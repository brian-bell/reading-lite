// `ops corpus normalize-tags` — rewrite stored tags into canonical hyphenated
// form. Write-time normalization (src/modules/tags.ts) only fixes new
// readings; the existing corpus holds the same bucket under several spellings,
// which splits the topical signal. Writes exactly one manifest field — NOT a
// reprocess. Plan-first: a mode-less run prints every tag rewrite it would
// make; --execute writes the manifests and rewrites the list index.

import { normalizeTags } from "../../../src/modules/tags";
import type { R2Deps } from "../../corpus-lib/wrangler-r2";
import type { ListItem } from "../../corpus-lib/types";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

export interface CorpusNormalizeTagsR2 {
  readListIndex: (deps: R2Deps) => Promise<ListItem[]>;
  readManifest: (keyPrefix: string, deps: R2Deps) => Promise<any | null>;
  putManifest: (keyPrefix: string, body: unknown, deps: R2Deps) => Promise<void>;
  writeListIndex: (items: ListItem[], deps: R2Deps) => Promise<void>;
}

export interface CorpusNormalizeTagsDeps extends BaseDeps {
  r2: CorpusNormalizeTagsR2;
}

interface Opts {
  tenant?: string;
  bucket: string;
  remote: boolean;
  execute: boolean;
  limit?: number;
}

function parseTagArgs(argv: string[]): Opts {
  const opts: Opts = {
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = requireValue(argv[++i], a);
    else if (a === "--tenant") opts.tenant = requireValue(argv[++i], a);
    else if (a === "--limit") opts.limit = Number(requireValue(argv[++i], a));
    else throw new UsageError(`unknown flag: ${a}`);
  }
  return opts;
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function runCorpusNormalizeTags(argv: string[], deps: CorpusNormalizeTagsDeps): Promise<number> {
  const opts = parseTagArgs(argv);
  const { io, r2 } = deps;
  const tenant = requireOperatorTenant(opts.tenant);
  const r2Deps: R2Deps = { bucket: opts.bucket, keyRoot: tenant.keyRoot, remote: opts.remote };
  const items = await r2.readListIndex(r2Deps);

  const changes = items
    .map((i) => {
      const tags = (i as { tags?: string[] }).tags;
      if (!tags || tags.length === 0) return null;
      const next = normalizeTags(tags);
      return same(tags, next) ? null : { item: i, from: tags, to: next };
    })
    .filter((c): c is { item: ListItem; from: string[]; to: string[] } => c !== null);

  const targets = opts.limit === undefined ? changes : changes.slice(0, opts.limit);

  io.stdout(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  io.stdout(`Corpus: ${items.length} readings`);
  io.stdout(`Readings with non-canonical tags: ${changes.length}`);
  io.stdout(`Mode: ${opts.execute ? "EXECUTE" : "PLAN"}\n`);

  if (targets.length === 0) {
    io.stdout("All tags already canonical — nothing to do.");
    return 0;
  }

  const vocabBefore = new Set(items.flatMap((i) => (i as { tags?: string[] }).tags ?? []));
  const rewritten = new Map<string, string[]>();
  let errored = 0;

  for (const c of targets) {
    const added = c.to.filter((t) => !c.from.includes(t));
    io.stdout(`  ${c.item.id}  [${c.from.join(", ")}] → [${c.to.join(", ")}]${added.length ? "" : "  (dedupe only)"}`);
    if (!opts.execute) {
      rewritten.set(c.item.id, c.to);
      continue;
    }
    const manifest = await r2.readManifest(c.item.key_prefix, r2Deps);
    if (manifest === null) {
      errored++;
      io.stderr(`  ! manifest unreadable for ${c.item.id}`);
      continue;
    }
    await r2.putManifest(c.item.key_prefix, { ...manifest, tags: c.to }, r2Deps);
    rewritten.set(c.item.id, c.to);
  }

  const vocabAfter = new Set(
    items.flatMap((i) => rewritten.get(i.id) ?? (i as { tags?: string[] }).tags ?? []),
  );
  io.stdout(
    `\nTag vocabulary: ${vocabBefore.size} → ${vocabAfter.size} distinct ` +
    `(${vocabBefore.size - vocabAfter.size} merged)`,
  );
  if (errored > 0) io.stdout(`Manifest read errors: ${errored}`);

  if (!opts.execute) {
    io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
    return 0;
  }

  const updated = items.map((i) => {
    const tags = rewritten.get(i.id);
    return tags === undefined ? i : { ...i, tags };
  });
  await r2.writeListIndex(updated, r2Deps);
  io.stdout("index/list.json rewritten.");
  return 0;
}

export const corpusNormalizeTagsCommand: CommandDefinition<CorpusNormalizeTagsDeps> = {
  group: "corpus",
  name: "normalize-tags",
  summary: "Rewrite stored tags into canonical hyphenated form",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus normalize-tags [options]

Writes only manifest.tags, leaving title, summary, keywords and updated_at
untouched. Readings whose tags are already canonical are skipped, so a run is
resumable and a second run is a no-op.

Plan by default, printing every tag rewrite it would make; --execute writes.

Options:
  --limit <n>      Cap how many readings are rewritten this pass.
  --bucket <name>  R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --tenant <selector>  REQUIRED: tenant id (usr_…) or 'global' for the pre-tenant layout.
  --local          Use the local miniflare bucket.
  --execute        Write manifests and rewrite index/list.json.
  --help           Show this message.`,
  defaultDeps: (io: CommandIo): CorpusNormalizeTagsDeps => ({
    io,
    r2: {
      readListIndex: async (d) => (await import("../../corpus-lib/wrangler-r2")).readListIndex(d),
      readManifest: async (kp, d) => (await import("../../corpus-lib/wrangler-r2")).readManifest(kp, d),
      putManifest: async (kp, body, d) => (await import("../../corpus-lib/wrangler-put")).putManifest(kp, body, d),
      writeListIndex: async (items, d) => (await import("../../corpus-lib/wrangler-r2")).writeListIndex(items, d),
    },
  }),
  run: runCorpusNormalizeTags,
};
