#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { loadDotVars } from "./lib/dotvars";
import { normalizeBacklitRow } from "./migrate-lib/normalize";
import { runMigration } from "./migrate-lib/run";
import {
  makeR2Client,
  makeVectorizeClient,
  dryRunR2,
  dryRunVectorize,
  type R2Client,
  type VectorizeClient,
} from "./lib/cf-clients";

interface Args {
  sqlite: string;
  contentDir: string;
  r2AccountId: string;
  r2AccessKey: string;
  r2SecretKey: string;
  r2Bucket: string;
  cfApiToken: string;
  vectorizeAccountId: string;
  vectorizeIndex: string;
  dryRun: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      sqlite: { type: "string" },
      "content-dir": { type: "string" },
      "r2-account-id": { type: "string" },
      "r2-access-key": { type: "string" },
      "r2-secret-key": { type: "string" },
      "r2-bucket": { type: "string" },
      "cf-api-token": { type: "string" },
      "vectorize-account-id": { type: "string" },
      "vectorize-index": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const dotVars = loadDotVars(".migrate.vars");

  const required = (name: keyof typeof values): string => {
    const v = values[name];
    if (typeof v !== "string" || v.length === 0) {
      const envName = name
        .toString()
        .toUpperCase()
        .replace(/-/g, "_")
        .replace(/^/, "MIGRATE_");
      const fromEnv = process.env[envName] ?? dotVars[envName];
      if (fromEnv) return fromEnv;
      console.error(
        `missing required --${name} (or env ${envName}, or ${envName} in .migrate.vars)`,
      );
      printUsage();
      process.exit(2);
    }
    return v;
  };

  return {
    sqlite: required("sqlite"),
    contentDir: required("content-dir"),
    r2AccountId: required("r2-account-id"),
    r2AccessKey: required("r2-access-key"),
    r2SecretKey: required("r2-secret-key"),
    r2Bucket: required("r2-bucket"),
    cfApiToken: required("cf-api-token"),
    vectorizeAccountId: required("vectorize-account-id"),
    vectorizeIndex: required("vectorize-index"),
    dryRun: values["dry-run"] === true,
  };
}

function printUsage() {
  console.error(`Usage: tsx scripts/migrate.ts \\
  --sqlite ./backlite.db \\
  --content-dir ./backlite-data \\
  --r2-account-id <ACCOUNT_ID> \\
  --r2-access-key <R2_ACCESS_KEY_ID> \\
  --r2-secret-key <R2_SECRET_ACCESS_KEY> \\
  --r2-bucket reading-lite \\
  --cf-api-token <CF_API_TOKEN_WITH_VECTORIZE_WRITE> \\
  --vectorize-account-id <ACCOUNT_ID> \\
  --vectorize-index reading-lite \\
  [--dry-run]

All flags also accept env vars MIGRATE_<UPPER_SNAKE_CASE>, or values
under the same names in a gitignored .migrate.vars file at the repo root
(see .migrate.vars.example). Resolution order: --flag > env > .migrate.vars.

Reads from BACKLITE_DATABASE_PATH (sqlite) + content dir (raw + extracted),
writes to R2 (S3 API, SigV4) + Vectorize (Cloudflare REST). Idempotent: re-runs
overwrite manifests + pointers and upsert by id, so partial migrations resume
cleanly.`);
}

function r2ClientForArgs(args: Args): R2Client {
  if (args.dryRun) return dryRunR2();
  return makeR2Client({
    accountId: args.r2AccountId,
    accessKeyId: args.r2AccessKey,
    secretAccessKey: args.r2SecretKey,
    bucket: args.r2Bucket,
  });
}

function vectorizeClientForArgs(args: Args): VectorizeClient {
  if (args.dryRun) return dryRunVectorize();
  return makeVectorizeClient({
    accountId: args.vectorizeAccountId,
    index: args.vectorizeIndex,
    apiToken: args.cfApiToken,
  });
}

interface RawRow {
  id: string;
  url: string;
  title: string;
  tldr: string;
  tags: string;
  keywords: string;
  people: string;
  orgs: string;
  novelty_verdict: string;
  connections: string;
  summary: string;
  embedding: string;
  content_type: string;
  content_status: string;
  content_bytes: number;
  extracted_bytes: number;
  content_sha256: string;
  fetched_at: string | null;
  created_at: string;
}

function* readRows(db: Database.Database): Generator<unknown> {
  const stmt = db.prepare("SELECT * FROM readings ORDER BY created_at ASC");
  let skipped = 0;
  for (const raw of stmt.iterate() as Iterable<RawRow>) {
    const decoded: Record<string, unknown> = {
      ...raw,
      tags: parseJsonArray(raw.tags),
      keywords: parseJsonArray(raw.keywords),
      people: parseJsonArray(raw.people),
      orgs: parseJsonArray(raw.orgs),
      connections: parseJsonObject(raw.connections),
      embedding: JSON.parse(raw.embedding),
    };
    const normalized = normalizeBacklitRow(decoded);
    if (!normalized) {
      skipped += 1;
      process.stderr.write(
        `[skip] ${raw.id} content_status=${JSON.stringify(raw.content_status)} (no captured content)\n`,
      );
      continue;
    }
    yield normalized;
  }
  if (skipped > 0) process.stderr.write(`[skip] ${skipped} row(s) skipped.\n`);
}

function parseJsonArray(raw: string | null): string[] | null {
  if (raw == null) return null;
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : null;
}

function parseJsonObject(raw: string | null): unknown {
  if (raw == null) return null;
  return JSON.parse(raw);
}

async function main() {
  const args = parseCliArgs();
  const db = new Database(args.sqlite, { readonly: true });
  const r2 = r2ClientForArgs(args);
  const vectorize = vectorizeClientForArgs(args);
  const report = await runMigration(readRows(db), {
    r2,
    vectorize,
    contentDir: args.contentDir,
  });
  db.close();

  const ok = report.filter((r) => r.status === "ok").length;
  const errs = report.length - ok;
  process.stderr.write(`\nMigrated ${ok}/${report.length} (${errs} errors).\n`);
  process.exit(errs > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
