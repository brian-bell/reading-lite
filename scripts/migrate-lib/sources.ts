// The legacy stores, read-only (reading-lite-gh348).
//
// `ops migrate export` reads three things the candidate no longer uses: the
// tenant's R2 manifests and pointers, the D1 control plane, and Vectorize.
// Each is reached through an interface with no write method at all, so
// "source access remains read-only" is a property of the types rather than of
// care at each call site: R2 is list and get, D1 is a SELECT the table specs
// build, and Vectorize is get_by_ids.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { R2ObjectMeta } from "../lib/cf-clients";
import { wranglerSpawnArgs } from "../lib/wrangler-cli";
import type { SourceEnv } from "./snapshot";

export interface ReadOnlyBucket {
  /** Every object under `prefix` (absolute bucket keys), with size and etag. */
  list(prefix: string): Promise<R2ObjectMeta[]>;
  /** The object's bytes, or null when it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
}

export interface SourceVector {
  id: string;
  values: unknown;
  namespace?: string;
}

export interface ReadOnlyVectors {
  /** Vectors by id. An id the index does not return is simply absent. */
  getByIds(ids: readonly string[]): Promise<SourceVector[]>;
}

export interface D1TableRead {
  table: string;
  orderBy: string;
  selectExtra?: string;
}

export type ReadD1Table = (spec: D1TableRead) => Promise<Record<string, unknown>[]>;

// Where each environment's legacy data lives. The D1 ids are the ones main's
// wrangler.toml binds; wrangler-d1-source.toml pins them, so the export reads
// the database the deployed Worker used, never one looked up by name.
export const LEGACY_SOURCES: Readonly<Record<SourceEnv, { bucket: string; d1Database: string; vectorizeIndex: string }>> = {
  staging: { bucket: "reading-lite-staging", d1Database: "reading-lite-control-staging", vectorizeIndex: "reading-lite-staging" },
  production: { bucket: "reading-lite", d1Database: "reading-lite-control", vectorizeIndex: "reading-lite" },
};

export function bucketFromInventory(client: {
  listObjects(prefix?: string): Promise<R2ObjectMeta[]>;
  getBytes(key: string): Promise<{ body: Uint8Array } | null>;
}): ReadOnlyBucket {
  return {
    list: (prefix) => client.listObjects(prefix),
    get: async (key) => (await client.getBytes(key))?.body ?? null,
  };
}

// The REST get_by_ids endpoint caps a request at 20 ids; a 21-id request
// answers 400 with an empty body (D1 migration 0010's note), so chunk here.
export const GET_BY_IDS_LIMIT = 20;

export function vectorizeGetByIds(
  cfg: { accountId: string; apiToken: string; index: string },
  send: typeof fetch,
): ReadOnlyVectors {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/vectorize/v2/indexes/${cfg.index}/get_by_ids`;
  return {
    async getByIds(ids) {
      const found: SourceVector[] = [];
      for (let i = 0; i < ids.length; i += GET_BY_IDS_LIMIT) {
        const chunk = ids.slice(i, i + GET_BY_IDS_LIMIT);
        const res = await send(url, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({ ids: chunk }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Vectorize get_by_ids failed: ${res.status} ${text}`);
        }
        const json = (await res.json()) as { result?: unknown };
        const raw = Array.isArray(json.result)
          ? json.result
          : ((json.result as { vectors?: unknown[] } | undefined)?.vectors ?? []);
        for (const item of raw as { id?: unknown; values?: unknown; namespace?: unknown }[]) {
          if (typeof item?.id !== "string") continue;
          found.push({
            id: item.id,
            values: item.values,
            ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
          });
        }
      }
      return found;
    },
  };
}

export type RunWrangler = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runWranglerCaptured: RunWrangler = (args) =>
  new Promise((resolve, reject) => {
    const launched = wranglerSpawnArgs(args);
    const child = spawn(launched.command, launched.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export const D1_SOURCE_CONFIG = fileURLToPath(new URL("./wrangler-d1-source.toml", import.meta.url));

// Page size for the D1 reads. The control plane is small (one founder, a
// handful of sessions and tokens); paging only keeps one wrangler response
// bounded if auth_challenges has grown.
export const D1_PAGE_SIZE = 500;

// Selected alongside `*` when a table pages by rowid, which `*` does not
// return, and stripped from every row before it leaves this module.
const ROWID_CURSOR = "_d1_export_rowid";

// A key value as a SQLite literal, for the WHERE that resumes after it. The
// values come from D1's own rows, but they are quoted as data regardless.
function keyLiteral(table: string, value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`cannot resume ${table} after a ${value === null ? "NULL" : typeof value} key; its ORDER BY must be a unique non-null key`);
}

/**
 * Reads whole D1 tables with SELECTs built here from the table specs, and
 * nothing else: no statement text reaches wrangler from outside this module.
 *
 * Each page resumes after the last key the previous page returned, never at
 * an OFFSET: every page is a separate wrangler call, and a row written or
 * deleted between two of them would shift an OFFSET, repeating a row (a
 * primary-key failure at import) or silently skipping one. A keyset read
 * returns every row that exists throughout exactly once. It needs
 * `spec.orderBy` to be a unique key, which every table spec's is.
 */
export function wranglerD1Reader(env: SourceEnv, run: RunWrangler = runWranglerCaptured): ReadD1Table {
  return async (spec) => {
    if (!/^[A-Za-z0-9_]+$/.test(spec.table) || !/^[a-z_, ]+$/.test(spec.orderBy)) {
      throw new Error(`refusing an unexpected D1 table spec: ${JSON.stringify(spec)}`);
    }
    const keys = spec.orderBy.split(",").map((key) => key.trim());
    const byRowid = keys.includes("rowid");
    const select = [spec.selectExtra, byRowid ? `rowid AS ${ROWID_CURSOR}` : undefined, "*"].filter(Boolean).join(", ");
    const rows: Record<string, unknown>[] = [];
    let after: string | null = null;
    for (;;) {
      const where = after === null ? "" : ` WHERE (${spec.orderBy}) > (${after})`;
      const sql = `SELECT ${select} FROM ${spec.table}${where} ORDER BY ${spec.orderBy} LIMIT ${D1_PAGE_SIZE}`;
      const result = await run([
        "d1", "execute", "CONTROL_PLANE", "--remote", "--json",
        "--config", D1_SOURCE_CONFIG, "--env", env, "--command", sql,
      ]);
      if (result.code !== 0) {
        throw new Error(`wrangler d1 execute failed for ${spec.table} (${result.code}): ${result.stderr.trim()}`);
      }
      const page = parseD1Json(result.stdout, spec.table);
      const last = page.at(-1);
      if (last !== undefined && page.length === D1_PAGE_SIZE) {
        after = keys.map((key) => keyLiteral(spec.table, last[key === "rowid" ? ROWID_CURSOR : key])).join(", ");
      }
      for (const row of page) {
        if (byRowid) delete row[ROWID_CURSOR];
        rows.push(row);
      }
      if (page.length < D1_PAGE_SIZE) return rows;
    }
  };
}

export function parseD1Json(stdout: string, table: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`wrangler d1 execute returned non-JSON output for ${table}`);
  }
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  const results = (first as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results) || (first as { success?: unknown }).success === false) {
    throw new Error(`wrangler d1 execute returned no result set for ${table}`);
  }
  return results as Record<string, unknown>[];
}
