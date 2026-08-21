// corpus-rebuild-list — rewrite index/list.json from live manifests.
//
// Projects every readable readings/*/manifest.json through the Worker's
// manifestToIndexItem helper so newly denormalized list fields (keywords)
// land on existing rows without a paid reprocess. Dry-run by default.
// --execute is a plain put (not CAS) and requires --sole-writer.

import { parseArgs } from "node:util";
import { ManifestSchema } from "../src/schemas/manifest";
import { enforceSoleWriter } from "./corpus-lib/sole-writer";
import { planListRebuild, rebuildWriteGuard } from "./corpus-lib/rebuild-list";
import {
  readListIndex,
  readManifest,
  writeListIndex,
  type R2Deps,
} from "./corpus-lib/wrangler-r2";
import { resolveBucket } from "./corpus-lib/config";

interface Args {
  bucket: string;
  remote: boolean;
  execute: boolean;
  soleWriter: boolean;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      bucket: { type: "string" },
      local: { type: "boolean", default: false },
      execute: { type: "boolean", default: false },
      "sole-writer": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  return {
    bucket: resolveBucket(values.bucket),
    remote: values.local !== true,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run corpus-rebuild-list -- [options]

Rewrites index/list.json by scanning each indexed reading's manifest and
projecting it through manifestToIndexItem (the same helper the Worker uses).
Use after deploying a Worker that added list-row fields (e.g. keywords).

  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --local          Read/write the local miniflare bucket.
  --execute        Write the rebuilt index (otherwise prints the plan).
  --sole-writer    Required with --execute: assert the realtime writer is
                   paused/drained. The rewrite is a plain put, not a CAS write.
  --help           Show this message.

Default is a DRY RUN. Deploy the new Worker before writing production.
`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const deps: R2Deps = { bucket: args.bucket, remote: args.remote };

  const currentItems = await readListIndex(deps);
  const rows = [];
  let skippedManifests = 0;
  for (const item of currentItems) {
    const raw = await readManifest(item.key_prefix, deps);
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
      skippedManifests += 1;
      continue;
    }
    rows.push({ keyPrefix: item.key_prefix, manifest: parsed.data });
  }

  const plan = planListRebuild({
    currentItems,
    rows,
    complete: true,
  });
  const guard = rebuildWriteGuard({
    execute: args.execute,
    soleWriter: args.soleWriter,
    complete: plan.complete,
  });

  console.log(
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
      enforceSoleWriter(
        { execute: true, acknowledged: false, tool: "corpus-rebuild-list" },
        { write: (s) => process.stderr.write(s), exit: (code) => process.exit(code) },
      );
    }
    console.error(guard.reason);
    process.exit(2);
  }

  if (guard.action === "dry-run") {
    console.log("dry-run: not writing index/list.json");
    return;
  }

  enforceSoleWriter(
    { execute: true, acknowledged: true, tool: "corpus-rebuild-list" },
    { write: (s) => process.stderr.write(s), exit: (code) => process.exit(code) },
  );
  await writeListIndex(plan.items, deps);
  console.log("index/list.json rewritten.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
