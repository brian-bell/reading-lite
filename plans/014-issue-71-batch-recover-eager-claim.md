# Plan — Issue #71: `corpus-recover --batch` eager-claim parity + resume/sidecar

> Batch race slice 3 (of #66, option b). Depends on slices 1 & 2 (#75 fresh eager
> claim, #76 fresh failure release). Reviewed plan (3 review-loops, final 9/10).
> **This is a plan only — no code has been written.** Hand to `/tdd` or
> `/tdd-with-review` for implementation (pull latest from main and branch first).

## Goal

Bring `corpus-recover --batch` to **eager by-url claim parity** with the
fresh-ingest path. The crisp mechanism: for a recover **failed** owner the by-url
slot is usually **already held** (realtime-failed readings own by-url; batch-failed
ones don't), so the eager "claim" is really a **flip failed→pending**. That is what
makes the online path *defer*: `ownedManifestMatches` is status-agnostic, but the
online path *reprocesses failed owners in place* while it *returns the existing
manifest for ready/pending owners* — only a pending/ready manifest behind the
pointer makes an online submit defer instead of racing the in-flight batch. The
claim must be **idempotent for already-owned readings**, and resume must leave
**no orphaned pending** and **never re-bill**.

## Non-goals (STOP conditions)

- Do **not** drop/relax the `--sole-writer` requirement (eager claim is
  defense-in-depth; overlapping writers remain out of scope).
- Do **not** implement the old migration-only `reconcilePending` mechanism.
- Do **not** change the fresh path's observable behavior.
- Eager claims happen only under `--execute` (inside `runBatch`); the dry-run still
  writes nothing.

## Current system observations

- **Fresh template:** `runFreshMarkdownBatch` (`run-fresh-markdown.ts:37-57`) wires
  `activateExtracted: activateFreshTargets` into `runBatchPipeline`.
  `activateFreshTargets` (`activation-phase.ts:22-117`) saves an **activating
  sidecar** (batchId `""`), then per target claims by-url via `putIfAbsent`, writes
  a `pending` manifest (`buildPendingManifest`, 136-156), by-id pointer, fresh
  content, pending list row, then merges the list index once.
- **Recover gap:** `runBatch` (`run.ts:149-163`) calls `runBatchPipeline` with
  **no** `activateExtracted` → the by-url slot stays unclaimed for the whole
  in-flight window (the #66 race). Front-end: `prepareTargets` (`prepare.ts:25-37`,
  reads the existing manifest by `row.key_prefix` — authoritative for
  `created_at`/`url_hash`/content/`source_type`) + `extractTargets`
  (`extract-phase.ts`, reuses `extracted.md` only when
  `status==="ready" && content_status==="captured"`, else re-extracts → `fresh` set).
- **Pipeline already supports activation** (`run.ts:92-131`): when
  `deps.activateExtracted` is set it runs the extracted- and summarize-payload size
  preflights, calls it, filters `summarizeTargets` to the activated set, and
  early-returns + `clearSidecar` when nothing remains. Wiring recover reuses all of
  it.
- **Resume guard** (`run.ts:67-83`): a live sidecar with falsy `batchId` (both
  `activating` and create-window `pending`) → **throw/abort**; with a `batchId` →
  resume `pollAndWrite`, never re-create. `produce()`/activation run only on a fresh
  run, after the resume check.
- **`markFailed` zeroes content** (`process-reading.ts:348-350`):
  `content_status:"failed"`, `content_bytes:0`, `content_sha256:"0".repeat(64)` — so
  a recover failed manifest's content descriptors are *not* usable for the pending
  manifest.
- **Failure release** (`write-phase.ts:131`): releases by-url **only** when
  `target.releaseByUrlOnFailure === true`; `submit-phase.ts:168-173` sets that flag
  **only** for `create-new`/`create-existing-failed`. `preserveReadyManifest`
  (`submit-phase.ts:175`) is captured from the in-memory `target.target.manifest`.
- **Helpers:** `getByUrl` (`r2-reads.ts:46-57`) returns
  `ByUrlPointer | "damaged" | null`; `serializeReadingPointer` (`pointers.ts:9-11`)
  emits exactly `{id, key_prefix}`; `ManifestSchema` (`manifest.ts:111-144`) is a
  flat `.strip()` with all summary fields optional and **no** status refinement;
  `ownedManifestMatches` (`reading-claim.ts:182-189`) is status-agnostic.

## Design

### 1. New `activateRecoverTargets(targets, deps)` in `activation-phase.ts`

Sibling to `activateFreshTargets`, sharing `activatingSidecar`, `writeFreshContent`,
`mergeListIndex`, `readManifest`, `getByUrl`. No `BatchActivationPolicy` change —
recover treats every target uniformly. Per target,
`expected = {id, keyPrefix, url, urlHash}` from `target.target`:

0. Save the **activating sidecar** first (reuse `activatingSidecar`), before any
   claim.
1. `lookup = getByUrl(r2, urlHash)`:
   - `"damaged"` → skip, reason **"by-url pointer is damaged"**.
   - `null` → `putIfAbsent(pointerKey, serializeReadingPointer(id, keyPrefix))`; if
     `!claimed`, re-read — equals ours → proceed, else skip, reason **"by-url
     claimed by another writer"**.
   - pointer `== {id, key_prefix}` → already owned; proceed **without** a claim
     write (idempotent — holds because both the realtime writer and this path
     serialize identically via `serializeReadingPointer`).
   - pointer → a **different** id → skip, reason **"by-url owned by a different
     reading"** (no clobber).
2. Revalidate the live manifest belongs to us — predicate (**not**
   `isExpectedFailed`): `m = readManifest(keyPrefix)`; proceed iff
   `m && m.id===id && m.url===url && m.url_hash===urlHash`, **regardless of status**
   (ready force-reprocess, failed, or our-own `batch_<id>` pending on a re-run all
   pass); else skip, reason **"reading changed before activation"**. Re-claim safety
   of our-own pending rests on `--sole-writer` being held (no concurrent online
   writer) — stated explicitly.
3. `writeFreshContent(target)` (no-op when no `fresh`/saved markdown reused), write
   the pending manifest via **`buildRecoverPendingManifest`**, write the by-id
   pointer, push the pending list row. Return target with
   `contentAlreadyWritten: true`.
4. `mergeListIndex` once. **No** `releaseByUrlOnFailure` (recover carries no
   `create-*` policy), so `write-phase` leaves the claim on failure → failed recover
   URL stays re-submittable by **both** recover (resolves via `row.key_prefix`,
   pointer-independent) and the online reprocess path (`ownedManifestMatches`
   status-agnostic → failed owner reprocesses in place).

### 2. New `buildRecoverPendingManifest` (do **not** touch `buildPendingManifest`)

Mirrors `submit-phase.sidecarTargetFor`'s descriptor logic so a failed manifest's
zeroed/failed descriptors never leak into the pending:
`content_type = fresh?.content_type ?? m.content_type` (likewise bytes/sha256),
**force `content_status:"captured"`**, `extracted_bytes = byteLength(markdown)`.
Carries `id/url/url_hash`, `source_type = m.source_type ?? "url"`,
`status:"pending"`,
`active_attempt:{ id:` + "`batch_${id}`" + `, trigger:"reprocess", status:"running", stage:"summarize", started_at: now }`,
**`created_at` preserved from `m`**, `updated_at: now`. **Omits** stale summary
fields (`tldr`/`tags`/`keywords`/`people`/`orgs`/`novelty_verdict`/`connections`/
`summary_markdown`/`usage`) — the terminal write rebuilds the full ready manifest;
on failure `preserveReadyManifest` rolls a ready reading forward. Parses cleanly
(`.strip()`, no status refinement).

### 3. Wire into `runBatch` (`run.ts`)

`activateExtracted: (targets) => activateRecoverTargets(targets, { r2, model, now, saveSidecar, ...(log?{log}:{}) })`,
mirroring `runFreshMarkdownBatch`. Reuses the payload preflights, post-activation
filtering, and all-skipped early-return. No change to
`prepare.ts`/`extract-phase.ts`/`corpus-recover.ts`.

> **Load-bearing invariant:** activation must **not** mutate
> `target.target.manifest`. `submit-phase.sidecarTargetFor` computes
> `preserveReadyManifest` (`status==="ready"`) and `releaseByUrlOnFailure` from that
> in-memory **pre-activation** snapshot; activation flips only the **live R2**
> manifest to pending. An implementer must not "fix" the staleness by re-reading the
> manifest into the target — that would break roll-forward.

### 4. Resume / sidecar (no schema change)

- **Post-create crash** (sidecar has `batchId`): `runBatchPipeline` resumes
  `pollAndWrite` **before** `produce()`/activation; no second `batch.create`;
  `write-phase` writes ready/failed over the eager-claim pendings (keyed by sidecar
  target) → **no orphan**. Resume re-attaches via the sidecar's recorded targets
  without re-claiming.
- **Activating-window crash** (falsy `batchId`): existing guard throws; operator
  deletes the sidecar + re-runs; `activateRecoverTargets` is idempotent (owns-slot
  branch + re-flip of its own `batch_<id>` pending, safe under `--sole-writer`) →
  re-attaches without duplicating, creates exactly one batch (nothing billed in that
  window).
- **Create-window crash** (batch billed, batchId unsaved): guard aborts (unchanged)
  — operator checks the Anthropic console.

### 5. Docs

- `CLAUDE.md` `corpus-recover --batch` gotcha: eager claim now applies to recover
  (really a failed→pending flip; idempotent for already-owned; failed recover URLs
  keep their claim and stay re-submittable by both recover and online reprocess;
  `--sole-writer` still required while batch and realtime writers can overlap;
  transient pending visibility mid-batch).
- Refine the `types.ts:80-85` `releaseByUrlOnFailure` comment; update `README.md` if
  it documents the race.

## TDD plan (RED → GREEN → refactor; run `npm run test:quiet -- test/unit/corpus/batch` throughout)

**Step 1 — `activation-phase.test.ts` (new block), RED first.**
1. claims unclaimed + flips failed→pending: `putIfAbsent` called, status `pending`,
   `source_type:"url"`, `content_status:"captured"`, content bytes/sha from the
   **re-extracted `fresh`** (not the failed manifest's zeros), `extracted_bytes`
   from markdown, `active_attempt.id==="batch_rd_a"`, `trigger:"reprocess"`, by-id
   written, pending list row.
2. idempotent already-owned: by-url `== {id, key_prefix}` → proceeds without a
   failed-claim skip; assert `Object.keys(pointer).sort()===["id","key_prefix"]`
   **and** value unchanged; one list row.
3. skip foreign-owned (reason "by-url owned by a different reading"), no clobber/no
   pending write.
4. skip damaged (reason "by-url pointer is damaged"), no writes.
5. preserve `source_type:"url"` + original `created_at`.
6. activating sidecar saved before first `putIfAbsent`/`put`.
7. idempotent re-run twice = single by-url/by-id/list-row.
8. re-extracted content written + `contentAlreadyWritten`.
9. ready-source reused-saved-markdown → pending descriptors from the ready manifest
   (captured), not a re-extract.

**GREEN:** implement `activateRecoverTargets` + `buildRecoverPendingManifest`.

**Step 2 — `run.test.ts` (extend harness: copy the fresh harness's `r2` stub with
`putIfAbsent`/`delete`/`listKeys`).**
1. eager claim before create — failed reading lacking by-url → by-url
   `== {id, key_prefix}`; pending + by-url exist **before** `batch.create` (spy
   ordering); final manifest `ready`.
2. existing end-to-end still passes (activation in the middle).
3. failure keeps claim (recover, **no** release) — force a batch error → failed
   manifest, by-id present, by-url **still present** (contrast fresh), failed list
   row, **and** assert the kept pointer still resolves the failed reading as owner
   (re-submittable).
4. **defensive-guard** test for the load-bearing invariant — inject an
   `ExtractedTarget` with a **ready** `target.manifest` at the
   `runBatch`/`activateRecoverTargets` seam (not via `prepareTargets`, which the CLI
   never feeds a ready row — corpus-audit routes only non-ready rows into recover's
   reprocess/local-extract buckets, `corpus-recover.ts:276-283`), force a batch
   **failure**, assert roll-**forward** to ready via `preserveReadyManifest`.
5. oversized payload rejected **before** any claim — no `putIfAbsent`, no by-url, no
   `batch.create`.

**Step 3 — `run.test.ts` "recover — resume".**
1. **Acceptance** — seed R2 with a `pending` manifest carrying
   `active_attempt.id "batch_rd_a"` + by-url + by-id + pending list row, plus a
   **post-create** `Sidecar` (batchId set, one target); `loadSidecar→sidecar`;
   `runBatch([row])` → `batch.create` **not** called, that **specific** pending
   flips to `ready`, **no manifest left pending**, by-url/by-id consistent.
2. activating-window sidecar (`processingStatus:"activating"`, batchId `""`) →
   `runBatch` throws; after clearing + re-run, claim/list row single.

**Step 4 — `submit-phase.test.ts` (regression fence for existing behavior).** A
recover-shaped extracted target (no `create-*` policy) → `releaseByUrlOnFailure`
unset; `preserveReadyManifest` set iff the original manifest was `ready`.

**Step 5 — refactor** (share helpers without behavior change) **+ docs.**

## Verification

`npm run test:quiet -- test/unit/corpus/batch` → all batch tests green; `npm test`
(canonical) → green; `npm run typecheck` → clean. Evidence: recover writes by-url
`== {id, key_prefix}` before create; a resumed run logs `Resuming batch …`, no
`batch.create`, zero pending left; a failed recover reading keeps its by-url pointer
and resolves as owner.

## Risks

- Transient `ready→pending` + pending list-row visibility mid-batch — benign under
  `--sole-writer`; `preserveReadyManifest` rolls forward on failure.
- `buildRecoverPendingManifest` descriptor correctness — must use `fresh ?? manifest`
  + force `captured` (pinned by tests 1.1/1.9).
- Idempotency hinges on the `getByUrl` null/damaged/owned trichotomy — all three
  tested.
- Re-claim of an own `batch_<id>` pending is safe **only** under `--sole-writer` —
  stated; the one place correctness rests on operator discipline, deliberately out
  of scope.

## Review record

- Final score **9/10**, gate met. Plan-review loops run: **3** (5 → 8 → 9).
- Criticals resolved: stale in-memory manifest invariant (named + guarded);
  vacuous acceptance test (now seeds `batch_<id>` pending and asserts the flip);
  revalidation predicate spelled out (id/url/url_hash, status-agnostic).
- Important resolved: contradictory pending manifest from `markFailed`-zeroed
  descriptors (dedicated `buildRecoverPendingManifest`); ready-force-reprocess test
  reframed as a seam-level defensive guard; skip `reason` strings pinned.
- Residual gap (the −1): activating-window re-claim safety rests on `--sole-writer`
  being held (operator discipline, not a code mechanism) — within the documented
  contract; the old migration-only mechanical fix is out of scope here.
