// Blackbox harness for the operator corpus commands (reading-lite-gh347.4.7).
//
// Before the storage migration these commands could only be tested against
// stubbed `wrangler r2` shims, so every case had to hand-build a list index, a
// manifest, a key list and a delete result. The corpus is rows now, and the
// Node pool reaches the test database directly, so a case can instead seed
// real readings, run the real command, and assert on what is left — which is
// both shorter and a stronger claim.
//
// Each test runs inside a transaction that is rolled back (pg-rollback), so
// files run in parallel without seeing each other's rows. The command's own
// `openSql` is injected with a handle onto that transaction: `end()` is
// recorded rather than performed, which is also what lets a test assert the
// command closed its session.

import { randomUUID } from "node:crypto";
import type { Sql } from "../../src/modules/db/sql";
import type { TenantContext } from "../../src/control-plane/ids";
import { mintUserId, parseTenantId } from "../../src/control-plane/ids";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { manifestToRows, writeReadingRows } from "../../src/modules/stores/postgres/manifest-rows";
import { ManifestSchema, type Manifest } from "../../src/schemas/manifest";
import { EMBEDDING_DIM } from "../../src/schemas/api";
import { sha256Hex } from "../../src/services";
import type { CommandIo } from "../../scripts/ops-lib/contract";
import type { OpenOperatorSql } from "../../scripts/pg-lib/operator-db";
import { useRolledBackSql } from "./pg-rollback";

export interface CapturedIo {
  io: CommandIo;
  out: string[];
  err: string[];
  /** Everything the command printed, in order, as one string. */
  all: () => string;
}

export function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const all: string[] = [];
  return {
    io: {
      stdout: (t) => { out.push(t); all.push(t); },
      stderr: (t) => { err.push(t); all.push(t); },
    },
    out,
    err,
    all: () => all.join("\n"),
  };
}

/** An in-memory stand-in for the reading content in R2. */
export interface MemoryBucket {
  objects: Map<string, string>;
  put: (key: string, body?: string) => void;
  keys: () => string[];
  /** The delete shim a corpus command's `r2.deleteObject` dep takes. */
  deleteObject: (key: string) => Promise<"deleted" | "absent" | "error">;
  /** Keys whose delete should report a failure, for the partial-failure cases. */
  failOn: Set<string>;
  readObject: (key: string) => Promise<string | null>;
}

export function memoryBucket(): MemoryBucket {
  const objects = new Map<string, string>();
  const failOn = new Set<string>();
  return {
    objects,
    failOn,
    put: (key, body = "body") => { objects.set(key, body); },
    keys: () => [...objects.keys()].sort(),
    async deleteObject(key) {
      if (failOn.has(key)) return "error";
      if (!objects.has(key)) return "absent";
      objects.delete(key);
      return "deleted";
    },
    async readObject(key) {
      return objects.get(key) ?? null;
    },
  };
}

export interface OperatorSession {
  openSql: OpenOperatorSql;
  /** How many times the command closed a session. */
  ended: () => number;
  /** The connection strings the command asked for. */
  urls: () => string[];
}

/**
 * An `openSql` that hands the command the test's rolled-back transaction.
 * `end()` is counted, not performed — the transaction belongs to the harness.
 */
export function operatorSession(sql: () => Sql): OperatorSession {
  let ended = 0;
  const urls: string[] = [];
  return {
    openSql: (url) => {
      urls.push(url);
      const live = sql();
      return { ...live, end: async () => { ended += 1; } };
    },
    ended: () => ended,
    urls: () => urls,
  };
}

export interface SeedOptions {
  status?: Manifest["status"];
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  tldr?: string;
  tags?: string[];
  keywords?: string[];
  ownsUrl?: boolean;
  embedding?: readonly number[];
  error?: Manifest["error"];
  activeAttempt?: Manifest["active_attempt"];
  lastAttempt?: Manifest["last_attempt"];
  enrichmentDegradation?: Manifest["enrichment_degradation"];
  connections?: Manifest["connections"];
  /** Publishes the reading under an immutable revision, as the runtime does. */
  revision?: { id: string; rawKey: string; extractedKey: string | null };
}

export interface SeededReading {
  id: string;
  url: string;
  keyPrefix: string;
  manifest: Manifest;
}

/** The prefix every one of a reading's objects lives under. Deterministic. */
export function keyPrefixFor(id: string, createdAt = "2026-01-01T00:00:00.000Z"): string {
  return buildKeyPrefix(id, createdAt);
}

export function unitVector(): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  vector[0] = 1;
  return vector;
}

/** Inserts the tenant's `users` row, which claim and publish both require. */
export async function seedTenant(sql: Sql): Promise<TenantContext> {
  const tenantId = String(parseTenantId(mintUserId())!);
  const now = new Date().toISOString();
  await sql.execute(
    `INSERT INTO users (id, email_canonical, email_display, status, email_verified_at, created_at, updated_at)
     VALUES ($1, $2, $2, 'active', $3, $3, $3) ON CONFLICT (id) DO NOTHING`,
    [tenantId, `${tenantId}@test.example`, now],
  );
  return { tenantId: parseTenantId(tenantId)! };
}

export async function seedReading(
  sql: Sql,
  tenant: TenantContext,
  id: string,
  opts: SeedOptions = {},
): Promise<SeededReading> {
  const url = opts.url ?? `https://example.com/${id}`;
  const status = opts.status ?? "ready";
  const createdAt = opts.createdAt ?? "2026-01-01T00:00:00.000Z";
  const manifest = ManifestSchema.parse({
    id,
    url,
    url_hash: await sha256Hex(url),
    source_type: "url",
    status,
    created_at: createdAt,
    updated_at: opts.updatedAt ?? createdAt,
    content_type: "text/html; charset=utf-8",
    content_status: "captured",
    content_bytes: 10,
    extracted_bytes: 5,
    content_sha256: "0".repeat(64),
    ...(status === "ready"
      ? {
          title: opts.title ?? `Title ${id}`,
          tldr: opts.tldr ?? `Tldr ${id}`,
          tags: opts.tags ?? ["alpha"],
          keywords: opts.keywords ?? ["kw"],
          summary_markdown: `# ${id}`,
        }
      : {}),
    ...(opts.error === undefined ? {} : { error: opts.error }),
    ...(opts.activeAttempt === undefined ? {} : { active_attempt: opts.activeAttempt }),
    ...(opts.lastAttempt === undefined ? {} : { last_attempt: opts.lastAttempt }),
    ...(opts.enrichmentDegradation === undefined
      ? {}
      : { enrichment_degradation: opts.enrichmentDegradation }),
    ...(opts.connections === undefined ? {} : { connections: opts.connections }),
  });
  const keyPrefix = buildKeyPrefix(id, createdAt);
  const rows = manifestToRows(manifest, {
    tenantId: String(tenant.tenantId),
    keyPrefix,
    ownsUrl: opts.ownsUrl ?? true,
    ...(opts.embedding === undefined ? {} : { embedding: opts.embedding }),
    ...(opts.revision === undefined ? {} : { revision: opts.revision }),
  });
  await sql.transaction((tx) => writeReadingRows(tx, rows));
  return { id, url, keyPrefix, manifest };
}

/**
 * An earlier revision left behind by a reprocess: `reading_revisions`
 * accumulates one row per publish, and only the newest is `current_revision_id`.
 */
export async function seedSupersededRevision(
  sql: Sql,
  tenant: TenantContext,
  readingId: string,
  revision: { id: string; rawKey: string; extractedKey: string | null },
): Promise<void> {
  await sql.execute(
    `INSERT INTO reading_revisions
       (tenant_id, reading_id, id, raw_key, extracted_key, content_type, content_status,
        content_bytes, content_sha256, published_at)
     VALUES ($1, $2, $3, $4, $5, 'text/html; charset=utf-8', 'captured', 10, $6, now())`,
    [String(tenant.tenantId), readingId, revision.id, revision.rawKey, revision.extractedKey, "0".repeat(64)],
  );
}

/**
 * Records an attempt that captured content but never published it — the
 * middle `contentKeys` tier.
 */
export async function seedCapturingAttempt(
  sql: Sql,
  tenant: TenantContext,
  readingId: string,
  keys: { rawKey: string; extractedKey: string | null },
): Promise<void> {
  await sql.execute(
    `INSERT INTO reading_attempts (tenant_id, reading_id, id, trigger, status, started_at, raw_key, extracted_key)
     VALUES ($1, $2, $3, 'submit', 'failed', now(), $4, $5)`,
    [String(tenant.tenantId), readingId, `at_${randomUUID().slice(0, 8)}`, keys.rawKey, keys.extractedKey],
  );
}

export async function seedRelationship(
  sql: Sql,
  tenant: TenantContext,
  opts: { sourceId: string; targetId: string; kind?: "connection" | "tension"; position?: number },
): Promise<void> {
  // The table's check constraint pairs kind with tension_kind/computed_at: a
  // tension must carry both, a connection neither.
  const tension = opts.kind === "tension";
  await sql.execute(
    `INSERT INTO reading_relationships
       (tenant_id, source_id, kind, position, target_id, reason, tension_kind, computed_at)
     VALUES ($1, $2, $3, $4, $5, 'because', $6, $7)`,
    [
      String(tenant.tenantId),
      opts.sourceId,
      opts.kind ?? "connection",
      opts.position ?? 0,
      opts.targetId,
      tension ? "contradicts" : null,
      tension ? new Date() : null,
    ],
  );
}

export async function readingIds(sql: Sql, tenant: TenantContext): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(
    "SELECT id FROM readings WHERE tenant_id = $1 ORDER BY id",
    [String(tenant.tenantId)],
  );
  return rows.map((row) => row.id);
}

export async function countRows(
  sql: Sql,
  table: "reading_urls" | "reading_embeddings" | "reading_relationships" | "reading_revisions" | "reading_attempts",
  tenant: TenantContext,
): Promise<number> {
  const [row] = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [String(tenant.tenantId)],
  );
  return row?.n ?? 0;
}

/** The environment a ported command reads its connection variable from. */
export const OPERATOR_ENV = { PRODUCTION_DATABASE_URL: "postgres://test/main" } as const;

/** Sets up per-test isolation and returns the accessor for this test's Sql. */
export const useCorpusDatabase = useRolledBackSql;
