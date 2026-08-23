// `ops corpus rebuild-list` — rewrite index/list.json from live manifests.
//
// Projects every readable readings/*/manifest.json through the Worker's
// manifestToIndexItem helper so newly denormalized list fields (keywords)
// land on existing rows without a paid reprocess. Plan-first; --execute is a
// plain put (not CAS) and requires --sole-writer.

import { parseArgs } from "node:util";
import { ManifestSchema } from "../../../src/schemas/manifest";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { planListRebuild, rebuildWriteGuard } from "../../corpus-lib/rebuild-list";
import { resolveBucket } from "../../corpus-lib/config";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface CorpusRebuildListR2 {
  readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
  readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
  writeListIndex: (items: unknown[], deps: R2Deps) => Promise<void>;
}

export interface CorpusRebuildListDeps extends BaseDeps {
  r2: CorpusRebuildListR2;
}

interface Args {
  bucket: string;
  remote: boolean;
  execute: boolean;
  soleWriter: boolean;
}

function parseRebuildArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        local: { type: "boolean", default: false },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  return {
    bucket: resolveBucket(values.bucket),
    remote: values.local !== true,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
  };
}

async function runCorpusRebuildList(argv: string[], deps: CorpusRebuildListDeps): Promise<number> {
  const args = parseRebuildArgs(argv);
  const { io, r2 } = deps;
  const r2Deps: R2Deps = { bucket: args.bucket, remote: args.remote };

  const currentItems = await r2.readListIndex(r2Deps);
  const rows = [];
  let skippedManifests = 0;
  for (const item of currentItems) {
    const raw = await r2.readManifest(item.key_prefix, r2Deps);
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
      skippedManifests += 1;
      continue;
    }
    rows.push({ keyPrefix: item.key_prefix, manifest: parsed.data });
  }

  const plan = planListRebuild({
    currentItems: currentItems as never,
    rows,
    complete: true,
  });
  const guard = rebuildWriteGuard({
    execute: args.execute,
    soleWriter: args.soleWriter,
    complete: plan.complete,
  });

  io.stdout(
    JSON.stringify(
      {
        bucket: args.bucket,
        currentCount: plan.currentCount,
        rebuiltCount: plan.rebuiltCount,
        keywordGainCount: plan.keywordGainCount,
        skippedManifests,
        complete: plan.complete,
        execute: args.execute,
        action: guard.action,
      },
      null,
      2,
    ),
  );

  if (guard.action === "refuse") {
    if (!args.soleWriter && args.execute) {
      const verdict = soleWriterGuard({ execute: true, acknowledged: false, tool: "ops corpus rebuild-list" });
      if (verdict.message) io.stderr(verdict.message);
    }
    io.stderr(guard.reason ?? "refused");
    return 2;
  }

  if (guard.action === "dry-run") {
    io.stdout("plan: not writing index/list.json (pass --execute --sole-writer to write)");
    return 0;
  }

  const verdict = soleWriterGuard({ execute: true, acknowledged: true, tool: "ops corpus rebuild-list" });
  if (verdict.message) io.stderr(verdict.message);
  await r2.writeListIndex(plan.items, r2Deps);
  io.stdout("index/list.json rewritten.");
  return 0;
}

export const corpusRebuildListCommand: CommandDefinition<CorpusRebuildListDeps> = {
  group: "corpus",
  name: "rebuild-list",
  summary: "Rewrite index/list.json from live manifests (backfill list-row fields)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus rebuild-list [options]

Rewrites index/list.json by scanning each indexed reading's manifest and
projecting it through manifestToIndexItem (the same helper the Worker uses).
Use after deploying a Worker that added list-row fields (e.g. keywords).

Plan by default. Deploy the new Worker before writing production.

Options:
  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --local          Read/write the local miniflare bucket.
  --execute        Write the rebuilt index (otherwise prints the plan).
  --sole-writer    Required with --execute: assert the realtime writer is
                   paused/drained. The rewrite is a plain put, not a CAS write.
  --help           Show this message.`,
  defaultDeps: (io: CommandIo): CorpusRebuildListDeps => ({
    io,
    r2: {
      readListIndex: async (d) => (await import("../../corpus-lib/wrangler-r2")).readListIndex(d),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      writeListIndex: async (items, d) =>
        (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items as never, d),
    },
  }),
  run: runCorpusRebuildList,
};
