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
import { ACCOUNT_WIPE_IN_FLIGHT_MS } from "../../../src/account-wipe";
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
// THE precondition is S2's deploy. Once the new Worker is live, no code reads
// or writes `wipe/{tenantId}/progress.json` at all, so no record under this
// prefix can belong to a running wipe and every one of them is by definition
// orphaned. Before that deploy, every record is dangerous regardless of how it
// looks, and this is not the tool to reach for.
//
// Two things the operator must NOT be told, because both invite an --execute
// before the deploy:
//
//   - "check that `count(*) from users where status='deleting'` is 0".
//     `users.status` stays `deleting` after a wipe FINISHES, until the 195b PR2
//     hard-delete (docs/operations.md; the src/account-wipe.ts header), so that
//     count never returns to 0 once any account has been deleted. A
//     precondition nobody can satisfy is a guard in name only.
//   - "an old record is inert". It is the opposite: `wipeLeaseHeld` in
//     src/account-wipe.ts is false once `updated_at_ms` is older than
//     ACCOUNT_WIPE_IN_FLIGHT_MS, which is exactly when the cron fan-out is free
//     to enqueue a RESUME for that tenant. Pre-deploy, a stale record is due to
//     be picked up, not finished with.
//
// So age and D1 status are reported as evidence of a wipe that is running or
// due — reasons to stop — never as a green light. The green light is the deploy.
const NO_ACTIVE_WIPE_FLAG = "--acknowledge-no-active-wipe";
// Derived, not retyped: the briefing's "a record older than this has a lapsed
// lease" claim is only true of the window `wipeLeaseHeld` actually uses.
const WIPE_IN_FLIGHT_MINUTES = ACCOUNT_WIPE_IN_FLIGHT_MS / 60_000;

// The control-plane database and wrangler env that go with a data bucket. A
// query pointed at the wrong control plane answers a question about the wrong
// environment, and that answer is the input to the acknowledgement — so an
// unrecognised bucket gets no query rather than a production-shaped guess.
const CONTROL_PLANE_BY_BUCKET: Record<string, { database: string; env: string }> = {
  "reading-lite": { database: "reading-lite-control", env: "production" },
  "reading-lite-staging": { database: "reading-lite-control-staging", env: "staging" },
};

function scopedProgressQuery(bucket: string, tenantIds: string[]): string | null {
  const target = CONTROL_PLANE_BY_BUCKET[bucket];
  if (target === undefined) return null;
  const list = tenantIds.map((id) => `'${id}'`).join(", ");
  return (
    `npx wrangler d1 execute ${target.database} --env ${target.env} --remote \\\n` +
    "  --command \"select tenant_id, phase, updated_at_ms, completed_at_ms " +
    `from wipe_progress where tenant_id in (${list})"`
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
      `--execute requires ${NO_ACTIVE_WIPE_FLAG}: assert that S2's deploy has landed, so nothing\n` +
        "reads or writes this prefix any more and every record under it is orphaned. Run this command\n" +
        "without --execute first — it names each record's tenant and prints what to check. Before that\n" +
        "deploy, deleting a record costs its wipe the cursor and restarts it from a full id re-collect;\n" +
        "a stale record is due for cron resumption, not finished with.",
    );
  }
  return args;
}

function describe(object: R2ObjectMeta): string {
  return `  ${object.key}  ${object.size} bytes  ${object.lastModified ?? "(no last-modified reported)"}`;
}

// The pre-delete briefing: which tenants these records name, and the scoped D1
// query for spotting a wipe that is running or due to resume. Neither is a
// green light — see the NO_ACTIVE_WIPE_FLAG comment above.
function reportTenantsAtRisk(io: CommandIo, bucket: string, listed: R2ObjectMeta[]): void {
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
    "\nBEFORE S2 DEPLOYS: a record under this prefix means that tenant's wipe is running\n" +
      `or due to resume — a fresh record is being written now, and one more than ${WIPE_IN_FLIGHT_MINUTES} minutes\n` +
      "stale has a lapsed lease, which is exactly when cron may enqueue a RESUME. Wait for\n" +
      "the wipe to finish. Do not sweep around it: deleting the record costs that wipe its\n" +
      "cursor and restarts it from a full id re-collect.\n" +
      "\nAFTER S2 DEPLOYS: nothing reads or writes this prefix at all, so every record left\n" +
      `under it is orphaned by construction. That deploy is what ${NO_ACTIVE_WIPE_FLAG}\n` +
      "asserts, and it is the only thing that makes --execute safe.",
  );
  const query = scopedProgressQuery(bucket, tenantIds);
  if (query === null) {
    io.stdout(
      `\nNo control-plane database is mapped to bucket '${bucket}', so no D1 query is offered —\n` +
        "check the control plane for THAT bucket's environment yourself, not production's.",
    );
    return;
  }
  io.stdout(
    "\nOnce S2 has deployed, D1 carries the in-flight signal — a wipe_progress row with\n" +
      "completed_at_ms NULL and a recent updated_at_ms heartbeat is a wipe still running:\n\n" +
      query +
      "\n\n(The table exists only after S2's migration applies.) A count of users with\n" +
      "status='deleting' is NOT the signal, before or after: that status survives a\n" +
      "COMPLETED wipe until the S4 hard-delete, so it never returns to 0.",
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
    reportTenantsAtRisk(io, args.bucket, listed);
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
    //
    // Identity is (key, etag), not key alone. The worst case reuses the key: a
    // wipe writing a fresh record for the very tenant whose record this run
    // just deleted. By key that looks like a survivor — "re-running is safe" —
    // which is the one thing it is not. A changed etag says the bytes are not
    // the ones planned against, so it is a re-creation.
    const plannedEtags = new Map(listed.map((object) => [object.key, object.etag]));
    const isSurvivor = (object: R2ObjectMeta) =>
      plannedEtags.has(object.key) &&
      // An etag missing on either side cannot witness sameness; treat the row
      // as new so the operator re-checks rather than re-runs.
      object.etag !== "" &&
      plannedEtags.get(object.key) === object.etag;
    const survived = remaining.filter((object) => isSurvivor(object));
    const appeared = remaining.filter((object) => !isSurvivor(object));
    if (survived.length > 0) {
      io.stderr(`  survived the delete (${survived.length}) — re-running is safe:`);
      for (const object of survived) io.stderr(describe(object));
    }
    if (appeared.length > 0) {
      io.stderr(
        `  NEW or REWRITTEN since the plan listing (${appeared.length}) — do NOT re-run blind:`,
      );
      for (const object of appeared) io.stderr(describe(object));
      io.stderr(
        `  Something wrote these after the listing this run planned against — which should be\n` +
          `  impossible once S2 has deployed, so treat ${NO_ACTIVE_WIPE_FLAG} as unproven.\n` +
          "  Check wipe_progress for an unfinished row (completed_at_ms NULL, recent heartbeat)\n" +
          "  before touching them; a live wipe's record must not be deleted.",
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

Run it in plan mode before merging S2, and with --execute only after S2's deploy
has landed — that deploy is the precondition, because after it nothing reads or
writes this prefix and every record under it is orphaned by construction.
--execute therefore requires ${NO_ACTIVE_WIPE_FLAG}.

Before that deploy, a record under wipe/ means that tenant's wipe is running or
due to resume — wait for it to finish rather than sweeping around it. A record
older than the ${WIPE_IN_FLIGHT_MINUTES}-minute lease is not inert: that is precisely when cron is free
to enqueue a RESUME. After the deploy, the in-flight signal lives in D1
(a wipe_progress row with completed_at_ms NULL and a recent heartbeat), which
plan mode prints a scoped query for. A count of users with status='deleting' is
not the signal either way — that status survives a COMPLETED wipe until the S4
hard-delete, so it never returns to 0.

See docs/operations.md, "Sweeping the wipe/ prefix".

Options:
  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --execute        Delete the listed objects, then verify the prefix is empty.
  ${NO_ACTIVE_WIPE_FLAG}
                   Assert that S2's deploy has landed, so no wipe can be using
                   these records. Required with --execute.
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
