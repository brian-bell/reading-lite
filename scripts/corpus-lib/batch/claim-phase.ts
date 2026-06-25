import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import { manifestToIndexItem } from "../../../src/modules/stores/reading-store";
import type { ListIndexItem } from "../../../src/schemas/api";
import { PointerExistsError, type R2Client } from "../../lib/cf-clients";
import { getByUrl, readManifest } from "./r2-reads";
import { mergeListIndex } from "./list-index-merge";
import { extToken } from "./submit-phase";
import type { SummarizeTarget } from "./types";

export interface ClaimDeps {
  r2: R2Client;
  now(): string;
  log?(line: string): void;
}

// A target dropped from the batch before submit, so it is never summarized or
// billed. Either the by-url slot is owned by a different reading / a damaged
// pointer (defer to the online owner/repair), or the reading is already `ready`
// (no re-summary needed). `reason` distinguishes them; surfaced in the run's
// `dropped` list, not just the log.
export interface DeferredClaim {
  id: string;
  url: string;
  reason: string;
}

export interface ClaimResult {
  kept: SummarizeTarget[];
  deferred: DeferredClaim[];
}

// Eagerly claim the by-url slot for every target BEFORE the Message Batch is
// created — the offline mirror of the online `activateAttempt`. The Anthropic
// batch runs for minutes-to-hours; without this claim the URL would sit unclaimed
// that whole window and an online submit could start a competing pending + job
// (duplicate paid compute + duplicate email + pointer thrash, issue #66).
//
// Per target: conditional-create the `index/by-url/{hash}` pointer
// (byte-compatible with the Worker's ByUrlPointer JSON and `ownedManifestMatches`)
// and write a `pending` manifest + by-id pointer + list row. An online submit
// during the batch then resolves an owned `pending` reading and DEFERS (returns
// the existing pending) instead of racing. On a lost claim (the slot is owned by
// a different id, or a "damaged" pointer occupies it) the target is dropped and
// reported — never summarized.
//
// Write order mirrors the online path exactly: the Worker claims the by-url slot
// (router `claimByUrlSlot`) BEFORE `activateAttempt` writes the pending manifest,
// so by-url-then-manifest here is the same ordering, and the brief pointer-without-
// manifest gap is the documented `MISSING_MANIFEST_OWNER_GRACE_MS` "initializing"
// window the online resolver already tolerates. A crash in that gap is recoverable:
// for a fresh-markdown mint the new key_prefix's timestamp keeps the pointer in the
// initializing grace (then the damaged-pointer repair takes over); for a recover
// target the existing (failed) manifest is still present at the key_prefix
// (prepareTargets drops manifest-less rows), so the pointer is never truly
// dangling — the online resolver sees an owned `failed` reading and reprocesses it.
export async function claimByUrlSlots(targets: SummarizeTarget[], deps: ClaimDeps): Promise<ClaimResult> {
  const kept: SummarizeTarget[] = [];
  const deferred: DeferredClaim[] = [];
  const touched: ListIndexItem[] = [];

  for (const st of targets) {
    const { target } = st.extracted;
    const { readingId: id, url, urlHash, keyPrefix } = target;
    const pointer = { id, key_prefix: keyPrefix };

    try {
      // Conditional create: only wins if the slot is empty (If-None-Match: *).
      await deps.r2.put(`index/by-url/${urlHash}`, JSON.stringify(pointer), {
        contentType: "application/json",
        ifNoneMatch: "*",
      });
    } catch (err) {
      if (!(err instanceof PointerExistsError)) throw err;
      // Slot already claimed — proceed only if it is already ours (a failed
      // reading re-ingesting in place, a recover target that owned its slot, or a
      // resume re-run). Otherwise defer — drop this target so it is never
      // summarized. We deliberately DEFER (never CAS-overwrite) a foreign or a
      // structurally "damaged" pointer: overwriting a slot we don't own is exactly
      // the #66 race this phase exists to prevent, and repairing a corrupt by-url
      // object stays the online resolver's job (resolveOwner deep-scans + CAS-
      // replaces it on any traffic). The unconditional overwrite the batch used to
      // do "repaired" damaged pointers only as a side effect of that unsafe stomp.
      // A deferred row is surfaced in the result's `dropped` list, so a purely
      // offline backfill over a corrupt pointer is visible and operator-fixable.
      const existing = await getByUrl(deps.r2, urlHash);
      const ours =
        existing && existing !== "damaged" && existing.id === id && existing.key_prefix === keyPrefix;
      if (!ours) {
        const reason =
          existing === "damaged"
            ? "by-url pointer is damaged; left for online repair"
            : `by-url slot owned by another reading (${existing?.id ?? "unknown"})`;
        deferred.push({ id, url, reason });
        deps.log?.(`  deferred ${id}: ${url} — ${reason}`);
        continue;
      }
    }

    // We own the slot now (freshly claimed, or it was already ours). If the
    // current manifest is already `ready`, DROP this target from the batch — never
    // re-summarize a ready reading, and never leave it in the batch where a failed
    // batch result could overwrite it back to `failed` (its sidecar would carry no
    // preserveReadyManifest snapshot when the target was prepared from an older
    // failed/pending manifest that an online reprocess turned ready between
    // produce() and here — a data-loss race). This is the claim-time re-check of
    // the same skip-ready rule prepareFreshMarkdown applies up front. The reading
    // stays ready and defended (an online submit sees owned+ready and defers); if a
    // legacy/cold ready reading merely lacked a by-url pointer, the conditional
    // create above just added the missing one — a harmless repair.
    const existing = await readManifest(deps.r2, keyPrefix);
    if (existing?.status === "ready") {
      deferred.push({ id, url, reason: "already ready; not re-summarized by the batch" });
      deps.log?.(`  skipped ${id}: ${url} — already ready`);
      continue;
    }

    // Persist fresh content artifacts BEFORE the pending manifest (mirroring the
    // online activateAttempt's artifacts → manifest order), so a crash never
    // leaves a captured-`pending` manifest whose raw/extracted objects are
    // missing — a state the API reprocess path can't recover for a markdown
    // reading (enqueueReprocess rejects it when extracted.md is absent).
    const { fresh } = st.extracted;
    if (fresh) {
      await deps.r2.put(`${keyPrefix}/raw.${extToken(fresh.content_type)}`, fresh.raw, {
        contentType: fresh.content_type,
      });
      if (fresh.markdown) {
        await deps.r2.put(`${keyPrefix}/extracted.md`, fresh.markdown, {
          contentType: "text/markdown; charset=utf-8",
        });
      }
    }

    const pendingManifest = buildPendingManifest(st, deps.now());
    await deps.r2.put(`${keyPrefix}/manifest.json`, JSON.stringify(pendingManifest), {
      contentType: "application/json",
    });
    await deps.r2.put(`index/by-id/${id}`, JSON.stringify(pointer), {
      contentType: "application/json",
    });
    touched.push(manifestToIndexItem(pendingManifest, keyPrefix));
    kept.push(st);
  }

  await mergeListIndex({ r2: deps.r2, ...(deps.log ? { log: deps.log } : {}) }, touched);
  return { kept, deferred };
}

// The eager pending manifest: schema-valid, owns the URL (id + url + url_hash),
// status pending. Content descriptors come from the fresh extract when present
// (fresh-markdown / re-extracted recover) else the existing manifest (recover of
// a captured reading) — mirroring submit-phase's sidecarTargetFor.
function buildPendingManifest(st: SummarizeTarget, now: string): Manifest {
  const { target, title, fresh } = st.extracted;
  const m = target.manifest;
  const manifest: Manifest = {
    id: target.readingId,
    url: target.url,
    url_hash: target.urlHash,
    source_type: m.source_type ?? "url",
    status: "pending",
    ...(title === undefined ? {} : { title }),
    content_type: fresh?.content_type ?? m.content_type,
    content_status: "captured",
    content_bytes: fresh?.content_bytes ?? m.content_bytes,
    content_sha256: fresh?.content_sha256 ?? m.content_sha256,
    created_at: target.createdAt,
    updated_at: now,
  };
  return ManifestSchema.parse(manifest);
}
