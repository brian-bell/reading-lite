import { ByUrlPointerSchema, ManifestSchema } from "../../../src/schemas/manifest";
import { manifestToIndexItem } from "../../../src/modules/stores/reading-store";
import type { ListIndexItem } from "../../../src/schemas/api";
import { isFreshMissingManifestPointer, ownedManifestMatches } from "../../../src/modules/reading-claim";
import type { R2Client } from "../../lib/cf-clients";
import { R2ConditionalPutError } from "../../lib/cf-clients";
import type { ClaimRollback, SummarizeTarget } from "./types";
import { mergeListIndex } from "./write-phase";

export interface EagerClaimDeps {
  r2: R2Client;
  now(): string;
  saveClaimRollback?(rollback: ClaimRollback): Promise<void>;
  log?: (line: string) => void;
}

export interface EagerClaimResult {
  targets: SummarizeTarget[];
  claimRollback: ClaimRollback;
  rollback(): Promise<void>;
}

const LIST_INDEX_KEY = "index/list.json";

// Claim fresh corpus-ingest targets before the Message Batch is created, closing
// the window where an online submit could mint a competing pending reading.
export async function claimFreshMarkdownTargets(
  targets: SummarizeTarget[],
  deps: EagerClaimDeps,
): Promise<EagerClaimResult> {
  const claimed: SummarizeTarget[] = [];
  const touched: ListIndexItem[] = [];
  const snapshots = new Map<string, string | null>();

  try {
    for (const st of targets) {
      const target = st.extracted.target;
      const pointer = { id: target.readingId, key_prefix: target.keyPrefix };
      const pointerJson = JSON.stringify(pointer);
      const byUrlKey = `index/by-url/${target.urlHash}`;
      const existing = await deps.r2.get(byUrlKey);

      if (existing !== null) {
        const existingPointer = parseByUrlPointer(existing);
        const samePointer =
          existingPointer?.id === pointer.id && existingPointer.key_prefix === pointer.key_prefix;
        if (!samePointer) {
          if (await existingByUrlOwnsTarget(st, deps, existing)) {
            deps.log?.(`  skipped ${target.readingId}: by-url slot is already owned`);
            continue;
          }
          deps.log?.(`  skipped ${target.readingId}: by-url slot needs repair before submit`);
          continue;
        }
        if (!(await samePointerStillFailedOwner(st, deps))) {
          deps.log?.(`  skipped ${target.readingId}: by-url slot is already owned`);
          continue;
        }
        await snapshotClaimObjects(st, deps, snapshots);
        const nextTouched = [...touched, manifestToIndexItem(st.extracted.target.manifest, target.keyPrefix)];
        await deps.saveClaimRollback?.(rollbackFromSnapshots(snapshots, nextTouched));
        const ok = await writePendingClaimObjects(st, deps, pointerJson, {
          writeByUrl: "none",
          onConflict: async () => {
            await preserveConflictWinner(st, deps, snapshots);
            await deps.saveClaimRollback?.(rollbackFromSnapshots(snapshots, touched));
          },
        });
        if (!ok) continue;
        claimed.push(st);
        touched.push(manifestToIndexItem(st.extracted.target.manifest, target.keyPrefix));
        continue;
      }

      await snapshotClaimObjects(st, deps, snapshots);
      const nextTouched = [...touched, manifestToIndexItem(st.extracted.target.manifest, target.keyPrefix)];
      await deps.saveClaimRollback?.(rollbackFromSnapshots(snapshots, nextTouched));
      const ok = await writePendingClaimObjects(st, deps, pointerJson, {
        writeByUrl: "create",
        onConflict: async () => {
          await preserveConflictWinner(st, deps, snapshots);
          await deps.saveClaimRollback?.(rollbackFromSnapshots(snapshots, touched));
        },
      });
      if (!ok) continue;
      claimed.push(st);
      touched.push(manifestToIndexItem(st.extracted.target.manifest, target.keyPrefix));
    }

    if (touched.length > 0) {
      await snapshotKey(LIST_INDEX_KEY, deps, snapshots);
      await deps.saveClaimRollback?.(rollbackFromSnapshots(snapshots, touched));
      await mergeListIndex(deps, touched);
    }
    const claimRollback = rollbackFromSnapshots(snapshots, touched);
    return {
      targets: claimed,
      claimRollback,
      rollback: () => restoreClaimRollback(deps, claimRollback),
    };
  } catch (err) {
    await restoreClaimRollback(deps, rollbackFromSnapshots(snapshots, touched));
    throw err;
  }
}

async function writePendingClaimObjects(
  st: SummarizeTarget,
  deps: EagerClaimDeps,
  pointerJson: string,
  opts: {
    writeByUrl: "none" | "create";
    onConflict: () => Promise<void>;
  },
): Promise<boolean> {
  const target = st.extracted.target;
  await writeFreshArtifacts(st, deps);
  const manifest = ManifestSchema.parse(target.manifest);
  await deps.r2.put(`${target.keyPrefix}/manifest.json`, JSON.stringify(manifest), {
    contentType: "application/json",
  });
  await deps.r2.put(`index/by-id/${target.readingId}`, pointerJson, {
    contentType: "application/json",
  });
  if (opts.writeByUrl === "none") return true;
  try {
    await deps.r2.put(`index/by-url/${target.urlHash}`, pointerJson, {
      contentType: "application/json",
      ifNotExists: true,
    });
  } catch (err) {
    if (err instanceof R2ConditionalPutError) {
      await opts.onConflict();
      deps.log?.(`  skipped ${target.readingId}: by-url slot is already owned`);
      return false;
    }
    throw err;
  }
  return true;
}

async function existingByUrlOwnsTarget(
  st: SummarizeTarget,
  deps: EagerClaimDeps,
  rawPointer: string,
): Promise<boolean> {
  const target = st.extracted.target;
  try {
    const pointer = ByUrlPointerSchema.parse(JSON.parse(rawPointer));
    const rawManifest = await deps.r2.get(`${pointer.key_prefix}/manifest.json`);
    if (!rawManifest) return isFreshMissingManifestPointer(pointer, deps.now());
    const manifest = ManifestSchema.safeParse(JSON.parse(rawManifest));
    return manifest.success && ownedManifestMatches(pointer, manifest.data, target.url, target.urlHash);
  } catch {
    return false;
  }
}

function parseByUrlPointer(rawPointer: string): { id: string; key_prefix: string } | null {
  try {
    return ByUrlPointerSchema.parse(JSON.parse(rawPointer));
  } catch {
    return null;
  }
}

async function samePointerStillFailedOwner(
  st: SummarizeTarget,
  deps: EagerClaimDeps,
): Promise<boolean> {
  const target = st.extracted.target;
  const rawManifest = await deps.r2.get(`${target.keyPrefix}/manifest.json`);
  if (!rawManifest) return false;
  try {
    const manifest = ManifestSchema.parse(JSON.parse(rawManifest));
    return (
      manifest.status === "failed" &&
      ownedManifestMatches(
        { id: target.readingId, key_prefix: target.keyPrefix },
        manifest,
        target.url,
        target.urlHash,
      )
    );
  } catch {
    return false;
  }
}

async function snapshotClaimObjects(
  st: SummarizeTarget,
  deps: EagerClaimDeps,
  snapshots: Map<string, string | null>,
): Promise<void> {
  const target = st.extracted.target;
  for (const key of artifactKeysFor(st)) {
    await snapshotKey(key, deps, snapshots);
  }
  await snapshotKey(`${target.keyPrefix}/manifest.json`, deps, snapshots);
  await snapshotKey(`index/by-id/${target.readingId}`, deps, snapshots);
  await snapshotKey(`index/by-url/${target.urlHash}`, deps, snapshots);
}

async function writeFreshArtifacts(st: SummarizeTarget, deps: EagerClaimDeps): Promise<void> {
  const { target } = st.extracted;
  const fresh = st.extracted.fresh;
  if (!fresh) return;
  await deps.r2.put(`${target.keyPrefix}/raw.${extToken(fresh.content_type)}`, fresh.raw, {
    contentType: fresh.content_type,
  });
  if (fresh.markdown) {
    await deps.r2.put(`${target.keyPrefix}/extracted.md`, fresh.markdown, {
      contentType: "text/markdown; charset=utf-8",
    });
  }
}

function artifactKeysFor(st: SummarizeTarget): string[] {
  const { target } = st.extracted;
  const fresh = st.extracted.fresh;
  if (!fresh) return [];
  return [
    `${target.keyPrefix}/raw.${extToken(fresh.content_type)}`,
    ...(fresh.markdown ? [`${target.keyPrefix}/extracted.md`] : []),
  ];
}

// Mirror process-reading.ts / submit-phase.ts so raw object keys stay aligned.
function extToken(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}

async function preserveConflictWinner(
  st: SummarizeTarget,
  deps: EagerClaimDeps,
  snapshots: Map<string, string | null>,
): Promise<void> {
  const target = st.extracted.target;
  await restoreTargetObjects(st, deps, snapshots);
  snapshots.set(`index/by-url/${target.urlHash}`, await deps.r2.get(`index/by-url/${target.urlHash}`));
}

async function snapshotKey(
  key: string,
  deps: EagerClaimDeps,
  snapshots: Map<string, string | null>,
): Promise<void> {
  if (!snapshots.has(key)) snapshots.set(key, await deps.r2.get(key));
}

async function restoreTargetObjects(
  st: SummarizeTarget,
  deps: EagerClaimDeps,
  snapshots: Map<string, string | null>,
): Promise<void> {
  const target = st.extracted.target;
  for (const key of artifactKeysFor(st)) {
    await restoreSnapshotKey(key, deps, snapshots);
  }
  await restoreSnapshotKey(`${target.keyPrefix}/manifest.json`, deps, snapshots);
  await restoreSnapshotKey(`index/by-id/${target.readingId}`, deps, snapshots);
}

function rollbackFromSnapshots(
  snapshots: Map<string, string | null>,
  touchedListItems: ListIndexItem[],
): ClaimRollback {
  return {
    objects: [...snapshots.entries()].map(([key, body]) => ({ key, body })),
    touchedListItems,
  };
}

export async function restoreClaimRollback(
  deps: Pick<EagerClaimDeps, "r2">,
  rollback: ClaimRollback,
): Promise<void> {
  const snapshots = new Map(rollback.objects.map((o) => [o.key, o.body] as const));
  for (const key of [...snapshots.keys()].reverse()) {
    if (key === LIST_INDEX_KEY) continue;
    await restoreSnapshotKey(key, deps, snapshots);
  }
  if (snapshots.has(LIST_INDEX_KEY)) {
    await restoreListIndex(deps, snapshots.get(LIST_INDEX_KEY) ?? null, rollback.touchedListItems);
  }
}

async function restoreSnapshotKey(
  key: string,
  deps: Pick<EagerClaimDeps, "r2">,
  snapshots: Map<string, string | null>,
): Promise<void> {
  const body = snapshots.get(key);
  if (body === undefined) return;
  if (body === null) {
    await deps.r2.delete(key);
  } else {
    await deps.r2.put(key, body, { contentType: contentTypeForRestoredKey(key) });
  }
}

function contentTypeForRestoredKey(key: string): string {
  if (key.endsWith("/extracted.md")) return "text/markdown; charset=utf-8";
  const raw = key.match(/\/raw\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  switch (raw) {
    case "html":
      return "text/html";
    case "md":
      return "text/markdown; charset=utf-8";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "bin":
      return "application/octet-stream";
    default:
      return "application/json";
  }
}

async function restoreListIndex(
  deps: Pick<EagerClaimDeps, "r2">,
  originalRaw: string | null,
  touched: ListIndexItem[],
): Promise<void> {
  if (touched.length === 0) {
    await restoreSnapshotBody(LIST_INDEX_KEY, deps, originalRaw);
    return;
  }

  const current = parseListItems(await deps.r2.get(LIST_INDEX_KEY));
  const original = parseListItems(originalRaw);
  if (!current.ok || !original.ok) {
    await restoreSnapshotBody(LIST_INDEX_KEY, deps, originalRaw);
    return;
  }

  const touchedIds = new Set(touched.map((i) => i.id));
  const touchedKeyPrefixes = new Set(touched.map((i) => i.key_prefix));
  const isTouched = (i: ListIndexItem) =>
    touchedIds.has(i.id) || touchedKeyPrefixes.has(i.key_prefix);
  const restored = [
    ...current.items.filter((i) => !isTouched(i)),
    ...original.items.filter(isTouched),
  ];

  if (restored.length === 0 && originalRaw === null) {
    await deps.r2.delete(LIST_INDEX_KEY);
    return;
  }
  await deps.r2.put(LIST_INDEX_KEY, JSON.stringify({ version: 1, items: restored }), {
    contentType: "application/json",
  });
}

function parseListItems(raw: string | null): { ok: true; items: ListIndexItem[] } | { ok: false } {
  if (raw === null) return { ok: true, items: [] };
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    return {
      ok: true,
      items: Array.isArray(parsed.items) ? (parsed.items as ListIndexItem[]) : [],
    };
  } catch {
    return { ok: false };
  }
}

async function restoreSnapshotBody(
  key: string,
  deps: Pick<EagerClaimDeps, "r2">,
  body: string | null,
): Promise<void> {
  if (body === null) {
    await deps.r2.delete(key);
  } else {
    await deps.r2.put(key, body, { contentType: "application/json" });
  }
}
