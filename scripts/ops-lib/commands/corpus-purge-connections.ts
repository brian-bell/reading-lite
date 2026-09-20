// `ops corpus purge-connections` — remove dangling inbound relationships that
// still name one already-deleted reading.
//
// This is the command the storage migration simplified most, and it is worth
// saying why, because almost all of it was scaffolding for a missing index.
// Relationships used to live inside each reading's manifest, so the only way
// to find the ones pointing AT a deleted reading was to list every manifest in
// the corpus, validate each one's key against its id and created_at, rewrite
// the matches with compare-and-set, and retry each CAS loss up to a bound —
// while asserting --sole-writer, because a concurrent writer could reintroduce
// an entry the sweep had already passed. All of that is now one statement
// against reading_relationships, which migration 0006 indexes by target.
//
// It still exists because the cascade does not cover this. The foreign key on
// reading_relationships names the SOURCE reading, so deleting a reading
// removes the relationships it declared and leaves every row that named it as
// a target. Detail reads tolerate a missing target, so nothing breaks, but the
// rows accumulate and keep citing a reading that is gone.
//
// It now purges tensions as well as connections. They are rows in the same
// table with the same dangling-target problem; only the old manifest layout,
// where connections and tensions were separate arrays, made it natural to
// handle one and not the other.

import { parseArgs } from "node:util";
import { parseReadingId } from "../../../src/services";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import type { OperatorTenant } from "../../corpus-lib/tenant";
import {
  DATABASE_URL_ENV_HELP,
  DATABASE_URL_ENV_OPTION,
  operatorDatabaseUrl,
  withOperatorSql,
} from "../../pg-lib/operator-db";
import { assertPgTenant, operatorCorpusFor, type CorpusLookup, type CorpusMutations } from "../../pg-lib/operator-corpus";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export type PurgeConnectionsView = CorpusMutations & Pick<CorpusLookup, "manifest">;

export interface CorpusPurgeConnectionsDeps extends BaseDeps {
  corpus: <T>(
    databaseUrlEnv: string,
    tenant: OperatorTenant,
    run: (corpus: PurgeConnectionsView) => Promise<T>,
  ) => Promise<T>;
}

interface Args {
  tenant?: string;
  databaseUrlEnv: string;
  id: string;
  execute: boolean;
}

interface Audit {
  mode: "plan" | "execute";
  tenant: string;
  target_id: string;
  rows_to_remove: number;
  rows_removed: number;
  failures: number;
  failure_code: "invalid_target" | "target_present" | "storage_error" | null;
}

function parsePurgeArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tenant: { type: "string" },
        "database-url-env": DATABASE_URL_ENV_OPTION,
        id: { type: "string" },
        execute: { type: "boolean", default: false },
        // Accepted and ignored: a single DELETE needs no quiescent corpus, but
        // an operator following an older runbook should not hit a usage error.
        "sole-writer": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.id) throw new UsageError("--id is required");
  return {
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    databaseUrlEnv: values["database-url-env"]!,
    id: values.id,
    execute: values.execute === true,
  };
}

async function purge(
  args: Args,
  corpus: PurgeConnectionsView,
  audit: Audit,
  io: CommandIo,
): Promise<number> {
  // The target must already be gone. Purging references to a LIVE reading
  // would silently delete real relationships, so this refuses rather than
  // trusting the operator's claim that the reading was deleted.
  if (await corpus.manifest(args.id)) {
    audit.failures += 1;
    audit.failure_code = "target_present";
    io.stderr(`REFUSED: target ${args.id} still exists in this tenant's corpus`);
    return 1;
  }

  // Counted in both modes, so "how many were targeted" reads the same whether
  // the run planned or applied. The old shape set manifests_would_write in
  // both modes for the same reason.
  audit.rows_to_remove = await corpus.countInboundRelationships(args.id);
  if (!args.execute) return 0;

  audit.rows_removed = await corpus.deleteInboundRelationships(args.id);
  return 0;
}

async function runCorpusPurgeConnections(argv: string[], deps: CorpusPurgeConnectionsDeps): Promise<number> {
  const args = parsePurgeArgs(argv);
  const tenant = requireOperatorTenant(args.tenant);
  // Before any connection: a 'global' selector must say so, not report a
  // missing connection string.
  assertPgTenant(tenant);
  const audit: Audit = {
    mode: args.execute ? "execute" : "plan",
    tenant: operatorTenantSelector(tenant),
    target_id: args.id,
    rows_to_remove: 0,
    rows_removed: 0,
    failures: 0,
    failure_code: null,
  };

  if (parseReadingId(args.id) !== args.id) {
    audit.failures += 1;
    audit.failure_code = "invalid_target";
    deps.io.stderr("REFUSED: --id must be a valid reading id");
    deps.io.stdout(JSON.stringify(audit));
    return 2;
  }

  let code: number;
  try {
    code = await deps.corpus(args.databaseUrlEnv, tenant, (corpus) => purge(args, corpus, audit, deps.io));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    audit.failures += 1;
    audit.failure_code = "storage_error";
    deps.io.stderr(`purge-connections failed: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  }
  deps.io.stdout(JSON.stringify(audit));
  return code;
}

export const corpusPurgeConnectionsCommand: CommandDefinition<CorpusPurgeConnectionsDeps> = {
  group: "corpus",
  name: "purge-connections",
  summary: "Remove dangling inbound relationships to one deleted reading",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus purge-connections --tenant <selector> --id <reading-id> [options]

Removes every connection and tension in this tenant's corpus whose target is
the given deleted reading. Deleting a reading cascades the relationships it
declared, but not the ones that named it, which is why this exists.

The target must already be absent: purging references to a live reading would
delete real relationships, so the command refuses instead.

Plans by default; --execute applies. No --sole-writer is needed — the removal
is a single statement, not a corpus-wide read-modify-write.

Options:
  --id <reading-id>     REQUIRED: deleted bare reading id to purge references to.
  --tenant <selector>   REQUIRED: tenant id (usr_…). 'global' has no PostgreSQL corpus.
  ${DATABASE_URL_ENV_HELP}
  --execute             Apply the removal.
  --help                Show this message.`,
  defaultDeps: (io: CommandIo): CorpusPurgeConnectionsDeps => ({
    io,
    corpus: (databaseUrlEnv, tenant, run) =>
      withOperatorSql(operatorDatabaseUrl(databaseUrlEnv), (sql) => run(operatorCorpusFor(sql, tenant))),
  }),
  run: runCorpusPurgeConnections,
};
