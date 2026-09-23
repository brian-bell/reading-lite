import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlFromConnectionString, type Sql } from "../../../src/modules/db/sql";
import { pgReadingStoreFor } from "../../../src/modules/stores/postgres/reading-store";
import type { TenantContext } from "../../../src/control-plane/ids";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { migrateImportCommand, type MigrateImportDeps } from "../../../scripts/ops-lib/commands/migrate-import";
import { applyReembeds, collectExport } from "../../../scripts/migrate-lib/export-library";
import { readSnapshot, writeSnapshot } from "../../../scripts/migrate-lib/snapshot";
import { openOperatorSql } from "../../../scripts/pg-lib/operator-db";
import { buildLegacyCorpus, LegacyLibrary, LEGACY_TENANT, unitVector } from "../../helpers/legacy-library";
import {
  databaseOf,
  fileDatabaseName,
  quoteIdentifier,
  templateDatabaseName,
  withDatabase,
} from "../../helpers/file-database";
import { testDatabaseUrl } from "../../helpers/test-database";

// Each case gets its own database, cloned from the migrated template (or, for
// the unmigrated case, created bare): the importer's contract is about what an
// EMPTY target looks like, which the shared rolled-back database cannot be.
// Clones use the per-file naming, so globalSetup drops any a killed run leaves.
const DDL_TIMEOUT_MS = 60_000;
const base = databaseOf(testDatabaseUrl());
const created: string[] = [];
let admin: Sql;
let snapshotDir: string;

async function database(opts: { migrated: boolean } = { migrated: true }): Promise<string> {
  const name = fileDatabaseName(base, crypto.randomUUID());
  await admin.query(
    `CREATE DATABASE ${quoteIdentifier(name)}${opts.migrated ? ` TEMPLATE ${quoteIdentifier(templateDatabaseName(base))}` : ""}`,
  );
  created.push(name);
  return withDatabase(testDatabaseUrl(), name);
}

async function withDb<T>(url: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = sqlFromConnectionString(url);
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

const ACCEPT = ["--accept", "malformed_manifest", "--accept", "tombstoned_manifest", "--accept", "unresolved_pending"];

async function runImport(url: string, args: string[], dir = snapshotDir) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MigrateImportDeps = {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    env: { REHEARSAL_TARGET_URL: url },
    readSnapshot,
    openSql: openOperatorSql,
  };
  const code = await migrateImportCommand.run(["--snapshot", dir, "--target-env", "REHEARSAL_TARGET_URL", ...args], deps);
  // With --json, stdout is the report and nothing else.
  if (args.includes("--json") && out.length > 0) expect(out).toHaveLength(1);
  return { code, out, err, report: args.includes("--json") && out.length > 0 ? JSON.parse(out[0]!) : undefined };
}

async function rowCount(url: string, table: string): Promise<number> {
  return withDb(url, async (sql) => (await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);
}

beforeAll(async () => {
  admin = sqlFromConnectionString(withDatabase(testDatabaseUrl(), "postgres"));
  const lib = new LegacyLibrary();
  buildLegacyCorpus(lib);
  const collection = applyReembeds(await collectExport(LEGACY_TENANT, lib.source()), [unitVector(3)]);
  snapshotDir = path.join(mkdtempSync(path.join(tmpdir(), "rl-import-")), "snapshot");
  writeSnapshot(snapshotDir, {
    meta: {
      format: "reading-lite-library-snapshot",
      version: 1,
      source: { env: "staging", bucket: "reading-lite-staging", d1_database: "reading-lite-control-staging", vectorize_index: "reading-lite-staging" },
      tenant_id: LEGACY_TENANT,
      exported_at: "2026-09-23T12:00:00.000Z",
    },
    library: collection.library,
    controlPlane: collection.controlPlane,
    report: collection.report,
  });
}, DDL_TIMEOUT_MS);

afterAll(async () => {
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
  await admin.end();
}, DDL_TIMEOUT_MS);

describe("migrate import", { timeout: DDL_TIMEOUT_MS }, () => {
  it("plans without writing, then imports, verifies and commits the snapshot", async () => {
    const url = await database();
    expect((await runImport(url, ACCEPT)).code).toBe(0);
    expect(await rowCount(url, "users")).toBe(0);

    const { code, report } = await runImport(url, [...ACCEPT, "--execute", "--json"]);
    expect(code).toBe(0);
    expect(report.verification).toMatchObject({
      manifest_mismatches: [],
      field_totals_match: true,
      embedding_mismatches: [],
      control_plane_mismatches: [],
    });
    expect(report.skipped.map((s: { id: string }) => s.id)).toEqual(["rd_BAD000001", "rd_TOMB00001"]);

    await withDb(url, async (sql) => {
      const store = pgReadingStoreFor(sql, { tenantId: LEGACY_TENANT } as TenantContext);
      // URL ownership follows the by-url pointer, not the newer failed copy.
      expect(await store.findOwnerByUrl("https://example.com/shared")).toEqual({ id: "rd_READY0001", status: "ready" });
      const ready = await store.loadReadingById("rd_READY0001");
      expect(ready?.manifest.connections?.map((c) => c.id)).toEqual(["rd_READY0002", "rd_GONE00001"]);
      // R2 content is not moved: the imported revision addresses the legacy keys.
      expect(await store.contentKeys("rd_READY0001")).toMatchObject({
        rawKey: "readings/2026/03/01T100000Z-rd_READY0001/raw.html",
        extractedKey: "readings/2026/03/01T100000Z-rd_READY0001/extracted.md",
      });
      // A raw object found under another spelling is the one addressed.
      expect((await store.contentKeys("rd_RAWEXT001"))?.rawKey).toBe("readings/2026/03/01T100000Z-rd_RAWEXT001/raw.bin");
      // Legacy work is carried as history, never as runnable work.
      expect((await sql.query("SELECT 1 FROM reading_jobs")).length).toBe(0);
      expect((await store.loadReadingById("rd_PEND00001"))?.manifest.active_attempt?.id).toBe("att_p");
      // Credentials survive: the token's HMAC, the session, the scopes.
      expect(await sql.query("SELECT secret_hmac FROM api_tokens")).toHaveLength(1);
      expect(await sql.query("SELECT scope FROM api_token_scopes ORDER BY scope")).toEqual([
        { scope: "readings:read" },
        { scope: "readings:write" },
      ]);
      // The challenge identity continues above the imported D1 rowids.
      const [next] = await sql.query<{ issue_seq: number }>(
        `INSERT INTO auth_challenges (id, purpose, email_canonical, email_display, secret_hmac, hash_key_version, issued_at, expires_at, state)
         VALUES ('ml_55555555-5555-4555-8555-555555555553', 'login', 'x@example.com', 'x@example.com', 'h', 1, now(), now(), 'revoked')
         RETURNING issue_seq`,
      );
      expect(next!.issue_seq).toBe(8);
    });
  });

  it("imports the same snapshot into another empty database with identical rows and report", async () => {
    const [a, b] = [await database(), await database()];
    const first = await runImport(a, [...ACCEPT, "--execute", "--json"]);
    const second = await runImport(b, [...ACCEPT, "--execute", "--json"]);
    expect(first.code).toBe(0);
    expect(second.report).toEqual(first.report);
  });

  it("refuses a target with any application row, and leaves it as it was", async () => {
    const url = await database();
    await withDb(url, (sql) =>
      sql.query("INSERT INTO signup_invites (email_canonical, email_display, created_at) VALUES ('a@b.c', 'a@b.c', now())"),
    );
    const { code, err } = await runImport(url, [...ACCEPT, "--execute"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("target is not empty: rows in signup_invites");
    expect(await rowCount(url, "users")).toBe(0);
  });

  it("refuses a target without the schema migrations and the vector extension", async () => {
    const url = await database({ migrated: false });
    const { code, err } = await runImport(url, [...ACCEPT, "--execute"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/migrations not applied: 0001_reading_schema/);
    expect(err.join("\n")).toContain("the vector extension is not installed");
  });

  it("refuses blocking findings that were not accepted, before writing anything", async () => {
    const url = await database();
    const { code, err } = await runImport(url, ["--accept", "malformed_manifest", "--execute"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("blocking finding(s) not accepted");
    expect(await rowCount(url, "users")).toBe(0);
  });

  it("rolls everything back when the read-back does not match the snapshot", async () => {
    const url = await database();
    // A trigger is schema, not a row, so the target still counts as empty.
    await withDb(url, (sql) =>
      sql.query(`
        CREATE FUNCTION tamper() RETURNS trigger AS $$ BEGIN NEW.title := 'tampered'; RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER tamper BEFORE INSERT ON readings FOR EACH ROW WHEN (NEW.id = 'rd_READY0002') EXECUTE FUNCTION tamper();`),
    );
    const { code, report } = await runImport(url, [...ACCEPT, "--execute", "--json"]);
    expect(code).toBe(1);
    expect(report.verification.manifest_mismatches).toEqual([{ id: "rd_READY0002", fields: ["title"] }]);
    expect(await rowCount(url, "readings")).toBe(0);
    expect(await rowCount(url, "users")).toBe(0);
  });

  it("refuses a snapshot whose files no longer match their recorded digests", async () => {
    const tampered = path.join(mkdtempSync(path.join(tmpdir(), "rl-import-")), "snapshot");
    const copy = readSnapshot(snapshotDir);
    writeSnapshot(tampered, { meta: copy.meta, library: copy.library, controlPlane: copy.controlPlane, report: copy.report });
    const file = path.join(tampered, "library.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("Title rd_READY0001", "Title edited"));
    const { code, err } = await runImport(await database(), [...ACCEPT], tampered);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("library.json does not match the digest");
  });

  it.each([
    ["a connection string", ["--target-env", "postgres://u:p@host/db"], "never a connection string"],
    ["a production variable for a staging snapshot", ["--target-env", "NEON_MAIN_DATABASE_URL"], "names the production database"],
    ["no target", [], "--target-env <NAME> is required"],
    ["an unknown acceptance", ["--target-env", "X", "--accept", "unfinished_wipe"], "not an acceptable finding"],
  ])("refuses %s", async (_name, args, message) => {
    const deps: MigrateImportDeps = {
      io: { stdout: () => {}, stderr: () => {} },
      env: { NEON_MAIN_DATABASE_URL: "postgres://prod/db", X: "postgres://x/db" },
      readSnapshot,
      openSql: () => {
        throw new Error("must not connect");
      },
    };
    const run = migrateImportCommand.run(["--snapshot", snapshotDir, ...args], deps);
    await expect(run).rejects.toThrow(UsageError);
    await expect(migrateImportCommand.run(["--snapshot", snapshotDir, ...args], deps)).rejects.toThrow(message);
  });
});
