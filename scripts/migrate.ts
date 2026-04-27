#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { AwsClient } from "aws4fetch";
import { loadDotVars } from "./lib/dotvars";
import { runMigration } from "./migrate-lib/run";
import type {
  R2Client,
  R2PutOptions,
  VectorizeClient,
  VectorizeUpsertVector,
} from "./migrate-lib/clients";

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

function makeR2Client(args: Args): R2Client {
  if (args.dryRun) return dryRunR2();
  const aws = new AwsClient({
    accessKeyId: args.r2AccessKey,
    secretAccessKey: args.r2SecretKey,
    service: "s3",
    region: "auto",
  });
  const base = `https://${args.r2AccountId}.r2.cloudflarestorage.com/${args.r2Bucket}`;
  return {
    async put(key: string, body: Uint8Array | string, opts?: R2PutOptions) {
      const headers: Record<string, string> = {};
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await aws.fetch(`${base}/${encodePath(key)}`, {
        method: "PUT",
        body,
        headers,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 PUT ${key} failed: ${res.status} ${text}`);
      }
    },
    async head(key: string) {
      const res = await aws.fetch(`${base}/${encodePath(key)}`, { method: "HEAD" });
      return res.ok;
    },
  };
}

function makeVectorizeClient(args: Args): VectorizeClient {
  if (args.dryRun) return dryRunVectorize();
  const url = `https://api.cloudflare.com/client/v4/accounts/${args.vectorizeAccountId}/vectorize/v2/indexes/${args.vectorizeIndex}/upsert`;
  return {
    async upsert(vectors: VectorizeUpsertVector[]) {
      const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${args.cfApiToken}`,
          "content-type": "application/x-ndjson",
        },
        body: ndjson,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Vectorize upsert failed: ${res.status} ${text}`);
      }
    },
  };
}

function dryRunR2(): R2Client {
  return {
    async put(key) {
      process.stderr.write(`[dry-run] R2 PUT ${key}\n`);
    },
    async head() {
      return false;
    },
  };
}

function dryRunVectorize(): VectorizeClient {
  return {
    async upsert(vectors) {
      for (const v of vectors) {
        process.stderr.write(`[dry-run] Vectorize upsert ${v.id}\n`);
      }
    },
  };
}

function encodePath(key: string): string {
  return key
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

interface RawRow {
  id: string;
  url: string;
  url_hash: string;
  title: string | null;
  tldr: string | null;
  tags: string | null;
  keywords: string | null;
  people: string | null;
  orgs: string | null;
  novelty_verdict: string | null;
  connections: string | null;
  summary_markdown: string | null;
  embedding: string;
  content_type: string;
  content_status: string;
  content_bytes: number;
  extracted_bytes: number | null;
  content_sha256: string;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

function* readRows(db: Database.Database): Generator<unknown> {
  const stmt = db.prepare("SELECT * FROM readings ORDER BY created_at ASC");
  for (const raw of stmt.iterate() as Iterable<RawRow>) {
    yield {
      ...raw,
      tags: parseJsonArray(raw.tags),
      keywords: parseJsonArray(raw.keywords),
      people: parseJsonArray(raw.people),
      orgs: parseJsonArray(raw.orgs),
      connections: parseJsonObject(raw.connections),
      embedding: JSON.parse(raw.embedding),
    };
  }
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
  const r2 = makeR2Client(args);
  const vectorize = makeVectorizeClient(args);
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
