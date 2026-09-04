// `ops account sweep-wipe-prefix` — list, and with --execute delete, every
// object under the bucket-root `wipe/` prefix, then re-list to prove the prefix
// is empty.
//
// Why it exists (issue #195 slice S2). The account wipe keeps its resume record
// at `wipe/{tenantId}/progress.json`, outside the tenant key root so it can
// outlive everything under `u/{tenantId}/`. S2 moves that state into D1 and
// removes the only code that ever deleted the R2 object, so a record left by an
// in-flight wipe at deploy time would sit in the bucket forever: a key naming a
// deleted tenant, with a body carrying that tenant's `vector_cursor` (a reading
// id). That is a leak, and "remember to check the bucket" is not a fix — this
// command is, and it verifies its own work rather than deleting and hoping.
//
// No --tenant flag, deliberately. Unlike every corpus command, these keys are
// bucket-root and each one names its tenant in its own path; the sweep's whole
// job is to clear the prefix as a whole. The safety property is supplied by the
// prefix guard in scripts/account-lib/wipe-prefix.ts instead, which is derived
// from the layout vocabulary so it cannot touch a corpus root.

import { parseArgs } from "node:util";
import type { R2ObjectMeta } from "../../lib/cf-clients";
import { loadDotVars } from "../../lib/dotvars";
import { resolveBucket } from "../../corpus-lib/config";
import {
  assertSweepableWipeKey,
  sweepableWipeKeyVerdict,
  wipeKeyTenantId,
  WIPE_PREFIX,
} from "../../account-lib/wipe-prefix";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface WipeSweepStorage {
  listObjects(prefix: string): Promise<R2ObjectMeta[]>;
  delete(key: string): Promise<void>;
}

export interface AccountSweepWipePrefixDeps extends BaseDeps {
  createStorage: (bucket: string) => Promise<WipeSweepStorage>;
}

interface Args {
  bucket: string;
  execute: boolean;
  acknowledgedNoActiveWipe: boolean;
}

// Deleting a LIVE wipe's record is the one way this command can do damage: the
// running job's next progress write is a CAS on the etag it read, so the delete
// costs that tenant its cursor and restarts the wipe from a full id re-collect.
// Nothing in R2 says which is which, so the operator asserts it — the same shape
// as --sole-writer on `corpus purge-connections`.
//
// What the operator must NOT be told to check is a bucket-wide
// `count(*) where status='deleting'`. `users.status` stays `deleting` after a
// wipe finishes, until the 195b PR2 hard-delete (see docs/operations.md and the
// src/account-wipe.ts header), so that count is non-zero forever once any
// account has ever been deleted, and a precondition nobody can satisfy is a
// guard in name only. The two checks that do discriminate:
//
//   - the records' own age. The wipe heartbeats `updated_at_ms` on every page,
//     and the in-flight lease is ACCOUNT_WIPE_IN_FLIGHT_MS (15 minutes, one
//     cron interval), so a record whose last-modified — printed for every
//     listed object — is older than that is not being written right now.
//   - a D1 lookup scoped to the tenants these keys actually name, which the
//     command prints as a ready-to-run query.
const NO_ACTIVE_WIPE_FLAG = "--acknowledge-no-active-wipe";
const WIPE_IN_FLIGHT_MINUTES = 15;

function scopedStatusQuery(tenantIds: string[]): string {
  const list = tenantIds.map((id) => `'${id}'`).join(", ");
  return (
    "npx wrangler d1 execute reading-lite-control --env production --remote \\\n" +
    `  --command "select id, status, deleting_at_ms from users where id in (${list})"`
  );
}

function parseSweepArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        execute: { type: "boolean", default: false },
        "acknowledge-no-active-wipe": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const args = {
    bucket: resolveBucket(values.bucket),
    execute: values.execute === true,
    acknowledgedNoActiveWipe: values["acknowledge-no-active-wipe"] === true,
  };
  // Refused at parse time, before a single R2 request: the acknowledgement is
  // about the state of the system, not about what the listing happens to show.
  if (args.execute && !args.acknowledgedNoActiveWipe) {
    throw new UsageError(
      `--execute requires ${NO_ACTIVE_WIPE_FLAG}: confirm no wipe is in flight for the tenants these\n` +
        "records name. Run this command without --execute first — it lists each record's tenant, its\n" +
        `last-modified time, and the D1 query scoped to exactly those tenants. Deleting a live wipe's\n` +
        "progress record costs that tenant its cursor and restarts its wipe from a full id re-collect.",
    );
  }
  return args;
}

function describe(object: R2ObjectMeta): string {
  return `  ${object.key}  ${object.size} bytes  ${object.lastModified ?? "(no last-modified reported)"}`;
}

// The pre-delete briefing: which tenants these records name, and the exact
// scoped D1 query that answers "is any of them mid-wipe right now".
function reportTenantsAtRisk(io: CommandIo, listed: R2ObjectMeta[]): void {
  const tenantIds = [
    ...new Set(
      listed.map((object) => wipeKeyTenantId(object.key)).filter((id): id is string => id !== null),
    ),
  ].sort();
  if (tenantIds.length === 0) {
    io.stdout(
      `\nNone of these keys is a ${WIPE_PREFIX}{tenantId}/progress.json record, so none names a tenant.`,
    );
    return;
  }
  io.stdout(`\nTenants named by these records (${tenantIds.length}):`);
  for (const id of tenantIds) io.stdout(`  ${id}`);
  io.stdout(
    `\nBefore ${NO_ACTIVE_WIPE_FLAG}, confirm none of them has a wipe in flight.\n` +
      `A record last modified more than ${WIPE_IN_FLIGHT_MINUTES} minutes ago is not being written\n` +
      "(the wipe heartbeats its progress on every page). To check D1 as well:\n\n" +
      scopedStatusQuery(tenantIds) +
      "\n\nNote: status stays 'deleting' after a wipe COMPLETES, until the 195b PR2 hard-delete —\n" +
      "so 'deleting' here is expected and is not by itself a reason to stop.",
  );
}

async function runAccountSweepWipePrefix(
  argv: string[],
  deps: AccountSweepWipePrefixDeps,
): Promise<number> {
  const args = parseSweepArgs(argv);
  const { io } = deps;

  const storage = await deps.createStorage(args.bucket);
  const listed = [...(await storage.listObjects(WIPE_PREFIX))].sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  io.stdout(`Bucket: ${args.bucket}`);
  io.stdout(`Prefix: ${WIPE_PREFIX}`);
  io.stdout(`Mode: ${args.execute ? "EXECUTE" : "PLAN"}`);
  io.stdout(`Objects found: ${listed.length}`);
  for (const object of listed) io.stdout(describe(object));

  if (listed.length === 0) {
    io.stdout(`\n${WIPE_PREFIX} is already empty — nothing to sweep.`);
    return 0;
  }

  // Fail closed on the whole run, before deleting anything, if the listing
  // returned a key this sweep has no business deleting. A prefixed LIST cannot
  // legitimately answer with one, so a stray key means the storage seam is not
  // behaving as assumed — and the safe response to that is to stop, not to
  // delete the keys that happen to look fine.
  const refused = listed
    .map((object) => ({ key: object.key, verdict: sweepableWipeKeyVerdict(object.key) }))
    .filter(
      (row): row is { key: string; verdict: { ok: false; reason: string } } => !row.verdict.ok,
    );
  if (refused.length > 0) {
    io.stderr(
      `\nREFUSED: the ${WIPE_PREFIX} listing returned ${refused.length} key(s) outside the sweepable prefix; ` +
        "nothing was deleted.",
    );
    for (const row of refused) io.stderr(`  ${row.key} — ${row.verdict.reason}`);
    io.stderr(
      "This sweep has no override: a key it will not delete must be inspected and removed by hand\n" +
        "  (`npx wrangler r2 object delete <bucket>/<key> --remote`) before the sweep can report the prefix empty.",
    );
    return 1;
  }

  if (!args.execute) {
    reportTenantsAtRisk(io, listed);
    io.stdout(
      `\nPLAN — nothing changed. Re-run with --execute ${NO_ACTIVE_WIPE_FLAG} to delete these ` +
        `${listed.length} object(s).`,
    );
    return 0;
  }

  let deleted = 0;
  let failed = 0;
  for (const object of listed) {
    // Belt and braces: the pre-flight above already cleared every key, so this
    // can only throw on a bug — which is exactly when it must.
    assertSweepableWipeKey(object.key);
    try {
      await storage.delete(object.key);
      deleted += 1;
      io.stdout(`deleted  ${object.key}`);
    } catch (err) {
      failed += 1;
      io.stderr(`failed to delete ${object.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  io.stdout(`\nDeleted ${deleted} object(s)${failed > 0 ? `, ${failed} failed` : ""}.`);

  // The scripted, verified half: a delete that reported success is not the same
  // as a prefix that is empty. Re-list and say so either way.
  const remaining = [...(await storage.listObjects(WIPE_PREFIX))].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  if (remaining.length > 0) {
    io.stderr(`\nVERIFICATION FAILED: ${remaining.length} object(s) still under ${WIPE_PREFIX}:`);
    // The two causes need opposite responses, and the listing alone does not
    // separate them: a key that was in the plan listing survived its delete and
    // re-running is right, while a key that was NOT there appeared after the
    // operator's users.status check — re-running would delete a record a wipe
    // may be actively using, which is the harm the acknowledgement exists to
    // prevent. So say which is which instead of a blanket "re-run".
    const planned = new Set(listed.map((object) => object.key));
    const survived = remaining.filter((object) => planned.has(object.key));
    const appeared = remaining.filter((object) => !planned.has(object.key));
    if (survived.length > 0) {
      io.stderr(`  survived the delete (${survived.length}) — re-running is safe:`);
      for (const object of survived) io.stderr(describe(object));
    }
    if (appeared.length > 0) {
      io.stderr(`  NEW since the plan listing (${appeared.length}) — do NOT re-run blind:`);
      for (const object of appeared) io.stderr(describe(object));
      io.stderr(
        `  Something wrote these after your ${NO_ACTIVE_WIPE_FLAG} check. Re-check D1 for a tenant with\n` +
          "  status='deleting' before touching them; a live wipe's record must not be deleted.",
      );
    }
    io.stderr("Investigate before merging or deploying anything that depends on this sweep.");
    return 1;
  }
  if (failed > 0) {
    // Belt-and-braces contradiction: deletes reported failures yet the prefix
    // re-lists empty. Report the failures rather than the reassuring listing.
    io.stderr(`\n${WIPE_PREFIX} re-listed empty, but ${failed} delete(s) reported an error — treat this run as unverified.`);
    return 1;
  }
  io.stdout(`\nVERIFIED: ${WIPE_PREFIX} is empty.`);
  return 0;
}

export const accountSweepWipePrefixCommand: CommandDefinition<AccountSweepWipePrefixDeps> = {
  group: "account",
  name: "sweep-wipe-prefix",
  summary: "List and delete orphaned account-wipe progress objects under wipe/",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- account sweep-wipe-prefix [options]

Lists every object under the bucket-root '${WIPE_PREFIX}' prefix with its size and
last-modified time. With --execute, deletes them and then RE-LISTS the prefix,
exiting non-zero if anything remains.

'${WIPE_PREFIX}{tenantId}/progress.json' is the account wipe's resume record. It names a
deleted tenant and its body carries that tenant's vector cursor, so a record
orphaned by the move of wipe progress into D1 (issue #195 slice S2) must not
survive in R2. Deletes are hard-restricted to keys literally under '${WIPE_PREFIX}':
tenant-rooted keys (u/{tenantId}/…) and the legacy corpus roots (readings/,
index/) are refused, and a listing containing one aborts the run before any
delete.

There is no --tenant flag: these keys sit outside every tenant key root and the
sweep clears the prefix as a whole.

Run it in plan mode before merging S2, and with --execute after S2's deploy has
landed. Nothing in R2 tells a live record from an orphaned one, so --execute
requires ${NO_ACTIVE_WIPE_FLAG}. Plan mode gives you what you need to
give that assertion honestly: each record's last-modified time (the wipe
heartbeats its progress every page, and the in-flight lease is
${WIPE_IN_FLIGHT_MINUTES} minutes), the tenants the records name, and a D1 query scoped to
exactly those tenants. Do NOT gate on a bucket-wide count of users with
status='deleting': that status survives a COMPLETED wipe until the 195b PR2
hard-delete, so the count never returns to 0.

See docs/operations.md, "Sweeping the wipe/ prefix".

Options:
  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --execute        Delete the listed objects, then verify the prefix is empty.
  ${NO_ACTIVE_WIPE_FLAG}
                   Assert that no wipe is in flight for the tenants these
                   records name. Required with --execute.
  --help           Show this message.`,
  defaultDeps: (io: CommandIo): AccountSweepWipePrefixDeps => ({
    io,
    createStorage: async (bucket) => {
      const { r2InventoryClientFromVars } = await import("../../lib/cf-clients");
      const vars = { ...loadDotVars(".corpus.vars"), ...process.env };
      const client = r2InventoryClientFromVars(vars, bucket);
      return {
        listObjects: (prefix) => client.listObjects(prefix),
        delete: (key) => client.delete(key),
      };
    },
  }),
  run: runAccountSweepWipePrefix,
};
