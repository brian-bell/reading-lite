// `ops migrate export` — freeze one tenant's legacy library and the D1
// control plane into a snapshot directory (reading-lite-gh348).
//
// Plan-first. A mode-less run reads the source (R2 under the tenant's root,
// D1 by SELECT, Vectorize by get_by_ids), reconciles it, and prints what the
// snapshot would hold and every discrepancy; it writes nothing and calls no
// provider. --execute re-embeds the ready readings get_by_ids did not return
// (the only paid call, spend-admitted against --billing-tenant) and writes
// the snapshot to --out, which must not already hold one.
//
// Source access is read-only by construction: see migrate-lib/sources.ts.
// Summarization providers are never called.

import { parseArgs } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { resolveOperatorTenant, type OperatorTenant } from "../../corpus-lib/tenant";
import { applyReembeds, collectExport, type ExportCollection, type ExportDeps } from "../../migrate-lib/export-library";
import { canonicalJson, SourceEnvSchema, writeSnapshot, type SourceEnv } from "../../migrate-lib/snapshot";
import { LEGACY_SOURCES } from "../../migrate-lib/sources";
import type { OpenOperatorSpend } from "../../system-lib/spend";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import { BILLING_TENANT_FLAG_HELP, resolveBillingTenant, withOperatorPaidFetch } from "../operator-spend";

export interface MigrateExportDeps extends BaseDeps {
  /** The read-only legacy stores for one environment. */
  openSource: (env: SourceEnv) => Promise<Pick<ExportDeps, "bucket" | "vectors" | "readD1">>;
  /** Embeds tldrs over the spend-admitted transport. */
  makeEmbedder: (paidFetch: typeof fetch) => Promise<(inputs: string[]) => Promise<number[][]>>;
  openSpend: OpenOperatorSpend;
  fetch: typeof fetch;
  now: () => number;
  writeSnapshot: typeof writeSnapshot;
}

interface Opts {
  source: SourceEnv;
  tenant: OperatorTenant & { kind: "tenant" };
  tenantId: string;
  out?: string;
  billingTenant?: string;
  json: boolean;
  execute: boolean;
}

function parseOpts(argv: string[]): Opts {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        source: { type: "string" },
        tenant: { type: "string" },
        out: { type: "string" },
        "billing-tenant": { type: "string" },
        json: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values;
  if (v.source === undefined) throw new UsageError("--source is required: staging or production");
  const source = SourceEnvSchema.safeParse(v.source);
  if (!source.success) throw new UsageError(`--source must be staging or production, not ${JSON.stringify(v.source)}`);
  const tenant = resolveOperatorTenant(v.tenant);
  if (!tenant.ok) throw new UsageError(tenant.reason);
  if (tenant.tenant.kind !== "tenant") {
    throw new UsageError("--tenant global is the retained pre-tenant data, which this migration excludes; pass the usr_… tenant");
  }
  if (v.execute && v.out === undefined) throw new UsageError("--execute requires --out <dir> for the snapshot");
  return {
    source: source.data,
    tenant: tenant.tenant,
    tenantId: tenant.tenant.tenantId,
    out: v.out,
    billingTenant: v["billing-tenant"],
    json: v.json ?? false,
    execute: v.execute ?? false,
  };
}

function printSummary(say: (line: string) => void, collection: ExportCollection): void {
  const r = collection.report;
  say(`Manifests: ${r.totals.manifests} (${r.totals.ready} ready, ${r.totals.pending} pending, ${r.totals.failed} failed)`);
  say(`Attempt logs: ${r.totals.attempts}   URL pointers: ${r.totals.pointers_by_url}   Tombstones: ${r.totals.tombstones}`);
  say(
    `Vectors: ${r.vectors.found} found, ${r.vectors.reembedded.length} to re-embed, ${r.vectors.invalid.length} invalid, ` +
      `${r.vectors.non_ready.length} on non-ready readings, ${r.vectors.non_owner.length} on non-owner duplicates`,
  );
  const tables = Object.entries(r.totals).filter(([key]) => key.startsWith("control_plane."));
  say(`Control plane: ${tables.map(([key, n]) => `${key.slice("control_plane.".length)} ${n}`).join(", ")}`);
  say(`Duplicate URL owners: ${r.duplicate_url_owners.length}`);
  const counts = Object.entries(r.discrepancy_counts);
  say(`Findings: ${counts.length === 0 ? "none" : counts.map(([code, n]) => `${code} ${n}`).join(", ")}`);
  if (r.blocking.length > 0) {
    say(`\nBlocking (import refuses these unless accepted):`);
    for (const d of r.blocking) say(`  ✗ ${d.code}${d.id ? `  ${d.id}` : ""}${d.key ? `  ${d.key}` : ""}${d.detail ? `  — ${d.detail}` : ""}`);
  }
}

async function runMigrateExport(argv: string[], deps: MigrateExportDeps): Promise<number> {
  const opts = parseOpts(argv);
  const { io } = deps;
  // With --json, stdout carries the report alone; the human lines move to stderr.
  const say = opts.json ? io.stderr : io.stdout;
  const billingTenant = resolveBillingTenant(opts.billingTenant, { tenant: opts.tenant, execute: opts.execute });
  // Before any read: a snapshot is frozen evidence and is never overwritten.
  if (opts.execute && existsSync(opts.out!) && readdirSync(opts.out!).length > 0) {
    throw new UsageError(`--out ${opts.out} already exists and is not empty; choose a new directory`);
  }

  const legacy = LEGACY_SOURCES[opts.source];
  say(`Source: ${opts.source} (bucket ${legacy.bucket}, D1 ${legacy.d1Database}, Vectorize ${legacy.vectorizeIndex})`);
  say(`Tenant: ${opts.tenantId}`);
  say(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

  const source = await deps.openSource(opts.source);
  let collection = await collectExport(opts.tenantId, { ...source, progress: (line) => io.stderr(line) });

  if (!opts.execute) {
    printSummary(say, collection);
    if (collection.reembed.length > 0) {
      say(`\nWould embed ${collection.reembed.length} tldr(s) (OpenAI, billed to ${billingTenant ?? "--billing-tenant"}).`);
    }
    say("\nPlan only: nothing embedded, nothing written. Re-run with --execute --out <dir>.");
    if (opts.json) io.stdout(canonicalJson(collection.report));
    return 0;
  }

  if (collection.reembed.length > 0) {
    const targets = collection.reembed;
    const embeddings = await withOperatorPaidFetch(
      { openSpend: deps.openSpend, fetch: deps.fetch, now: deps.now },
      { env: opts.source, billingTenant, command: "migrate-export" },
      async (paidFetch) => (await deps.makeEmbedder(paidFetch))(targets.map((t) => t.tldr)),
    );
    collection = applyReembeds(collection, embeddings);
  }
  const meta = deps.writeSnapshot(opts.out!, {
    meta: {
      format: "reading-lite-library-snapshot",
      version: 1,
      source: {
        env: opts.source,
        bucket: legacy.bucket,
        d1_database: legacy.d1Database,
        vectorize_index: legacy.vectorizeIndex,
      },
      tenant_id: opts.tenantId,
      exported_at: new Date(deps.now()).toISOString(),
    },
    library: collection.library,
    controlPlane: collection.controlPlane,
    report: collection.report,
  });
  printSummary(say, collection);
  say(`\nSnapshot written to ${opts.out} (library.json ${meta.files["library.json"].slice(0, 12)}…).`);
  if (opts.json) io.stdout(canonicalJson(collection.report));
  return 0;
}

export const migrateExportCommand: CommandDefinition<MigrateExportDeps> = {
  group: "migrate",
  name: "export",
  summary: "Freeze a tenant's legacy library and the D1 control plane into a snapshot",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- migrate export --source <staging|production> --tenant <usr_…>
                                  [--out <dir>] [--billing-tenant <usr_…>] [--json] [--execute]

Reads the legacy stores READ-ONLY: every object under u/{tenant}/ in the
environment's R2 bucket (manifests, attempt logs, pointers, tombstones and
the raw content, which is hashed), the whole D1 control plane by SELECT, and
the tenant's vectors from Vectorize by their composed {tenant}:{id} ids.
Retained pre-tenant global data is never read. The manifests are the
inventory; index/list.json is only compared against them.

Plan mode prints the reconciliation (counts, duplicate URL owners, dangling
relationships, missing or mismatched content, missing and invalid vectors,
and the blocking findings import would refuse) and writes nothing.

--execute embeds the tldr of each ready reading whose vector get_by_ids did
not return (after one individual retry), with the same model the Worker
uses, and writes the snapshot: snapshot.json, library.json,
control-plane.json and report.json (the machine-readable reconciliation
report). No summarization provider is called.

Freeze writers first: the export reads R2, D1 and Vectorize at different
moments and assumes nothing changes in between.

Options:
  --source <env>    staging or production. Required; there is no default.
  --tenant <usr_…>  The tenant whose library to export. Required.
  --out <dir>       Snapshot directory; must be new or empty. Required with --execute.
  ${BILLING_TENANT_FLAG_HELP}
                    Default: --tenant.
  --json            Also print the reconciliation report as JSON.
  --execute         Re-embed misses and write the snapshot.

Credentials: R2 as for the corpus commands (.corpus.vars CORPUS_R2_* or
CLOUDFLARE_API_TOKEN); Vectorize and D1 with CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_API_TOKEN (wrangler); OPENAI_API_KEY only when --execute re-embeds.`,
  defaultDeps: (io) => ({
    io,
    openSource: async (env) => {
      const { loadDotVars } = await import("../../lib/dotvars");
      const { r2InventoryClientFromVars, withRateLimitRetry } = await import("../../lib/cf-clients");
      const { bucketFromInventory, vectorizeGetByIds, wranglerD1Reader } = await import("../../migrate-lib/sources");
      const vars = sourceVars(loadDotVars);
      const legacy = LEGACY_SOURCES[env];
      const required = (names: string[]) => {
        for (const name of names) if (vars[name]) return vars[name]!;
        throw new Error(`missing credential: ${names.join(" or ")}`);
      };
      return {
        bucket: bucketFromInventory(r2InventoryClientFromVars(vars, legacy.bucket)),
        vectors: vectorizeGetByIds(
          {
            accountId: required(["CORPUS_VECTORIZE_ACCOUNT_ID", "CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]),
            apiToken: required(["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]),
            index: legacy.vectorizeIndex,
          },
          withRateLimitRetry(fetch) as typeof fetch,
        ),
        readD1: wranglerD1Reader(env),
      };
    },
    makeEmbedder: async (paidFetch) => {
      const { loadDotVars } = await import("../../lib/dotvars");
      const { makeOpenAIEmbedClient } = await import("../../corpus-lib/batch/clients");
      const apiKey = sourceVars(loadDotVars).OPENAI_API_KEY;
      if (!apiKey) throw new Error("missing execute credential: OPENAI_API_KEY");
      const client = makeOpenAIEmbedClient({ fetch: paidFetch, apiKey });
      return async (inputs) => (await client.embedMany(inputs)).embeddings;
    },
    openSpend: async (env) => (await import("../../system-lib/spend")).openRemoteOperatorSpend(env),
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    writeSnapshot,
  }),
  run: runMigrateExport,
};

function sourceVars(loadDotVars: (file: string) => Record<string, string>): Record<string, string | undefined> {
  return {
    ...loadDotVars(".dev.vars"),
    ...loadDotVars(".prd.vars"),
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  };
}
