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
}

function parseSweepArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  return {
    bucket: resolveBucket(values.bucket),
    execute: values.execute === true,
  };
}

function describe(object: R2ObjectMeta): string {
  return `  ${object.key}  ${object.size} bytes  ${object.lastModified ?? "(no last-modified reported)"}`;
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
    return 1;
  }

  if (!args.execute) {
    io.stdout(`\nPLAN — nothing changed. Re-run with --execute to delete these ${listed.length} object(s).`);
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
    for (const object of remaining) io.stderr(describe(object));
    io.stderr("Re-run to retry; investigate before merging or deploying anything that depends on the sweep.");
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
landed and no tenant is 'status=deleting'. See docs/operations.md, "Sweeping the
wipe/ prefix".

Options:
  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --execute        Delete the listed objects, then verify the prefix is empty.
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
