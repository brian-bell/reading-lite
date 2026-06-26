# Plan 012 - Issue #69: Batch eager by-url claim for corpus-ingest

> Source: https://github.com/brian-bell/reading-lite/issues/69
>
> Parent: issue #66, option (b), first tracer-bullet slice.

## 1. Goal

Close the unclaimed-window race for the common `corpus-ingest` fresh-markdown
backfill path.

Today, `corpus-ingest --execute --sole-writer` resolves ownership client-side,
submits a Message Batch, and writes the terminal manifest later. During the
in-flight batch window, a newly-minted or pointerless failed fresh ingest has no
live `index/by-url/{sha256(url)}` pointer. A realtime `POST /readings` for the
same URL can therefore treat the URL as unclaimed, mint a competing reading, and
enqueue live work. Issue #68 added an operator sole-writer guard. Issue #69 adds
the code-level belt-and-suspenders fix for this first slice: the offline batch
submit path should eagerly publish a pending owner before creating the Anthropic
batch.

The online Worker side should not need ownership-rule changes. `ReadingClaim`
already uses `ownedManifestMatches(pointer, manifest, url, urlHash)` and treats
any matching `ready` or `pending` owner as owned. Once the offline path writes a
matching pending manifest behind a byte-compatible by-url pointer, the online
submit path should return that existing pending manifest and avoid a duplicate
queue job. The one online-side compatibility change this slice does need is the
read-time stale rule: batch-owned pending manifests must not age past
`PENDING_TTL_SECONDS` into a live reprocess while the Anthropic batch is still in
flight.

## 2. Acceptance criteria

- [ ] During a fresh `corpus-ingest` batch submit, every activated target
      publishes a matching pending manifest, by-id pointer, by-url pointer, and
      list row before `batch.create(...)` is called.
- [ ] The activation path is crash-safe in the same conservative sense as the
      existing batch-create guard: before the first durable by-url claim/verify,
      it writes a fail-closed, atomically-saved activating sidecar that causes a
      rerun to stop for manual reconciliation instead of silently skipping a
      stranded pending owner.
- [ ] Offline batch pending manifests with the batch-owned marker do not stale
      out after `PENDING_TTL_SECONDS`; `POST /readings` for that URL returns the
      batch pending manifest and does not enqueue realtime work when the by-url
      pointer still resolves to that marked manifest.
- [ ] The by-url pointer JSON is byte-compatible with the Worker pointer shape:
      `{"id":"...","key_prefix":"..."}` when parsed, with no extra fields.
- [ ] The eager by-url write is conditional for newly-claimed slots. If another
      owner claims the URL between planning and activation, the batch target is
      skipped rather than overwriting that owner.
- [ ] Targets whose by-url pointer already points at the same id/key_prefix are
      verified against both the pointer and the current manifest state, then
      activated in place only when the manifest is still the planned failed
      retry target; they are skipped if the manifest became ready/pending or no
      longer matches the planned URL/id/hash.
- [ ] The terminal success path still overwrites pending to ready at the same
      id/key_prefix; no terminal success behavior changes are required except
      tolerating a pre-existing by-url pointer.
- [ ] The terminal failure behavior for this slice is intentionally unchanged
      except for tolerating a pre-existing eager by-url claim: failures still
      write failed manifest + by-id + list, do not create a by-url pointer for a
      clean failure case, and do not delete an eager by-url pointer that already
      exists. Releasing an eager claim on batch failure is a later issue.
- [ ] If all activation candidates are skipped at submit time, no Anthropic
      batch is created, the temporary activating sidecar is cleared, skipped rows
      are returned in the run report, and the operator sees the skip reasons.
- [ ] Test coverage proves an online submit for a URL with an in-flight offline
      batch claim returns the existing pending reading and does not enqueue live
      work.

## 3. Non-goals

- Do not add the failure-path by-url slot release. That is the next slice.
- Do not add `corpus-recover --batch` parity. This issue is scoped to
  `corpus-ingest` / fresh markdown.
- Do not change the online `ReadingClaim` ownership matching rule unless a test
  exposes a bug in the existing rule. The stale-annotation exemption for
  batch-owned pending manifests is allowed because it changes only the read-time
  effective status of an already-owned record.
- Do not change `reconcilePending` behavior.
- Do not remove the issue #68 `--sole-writer` guard. After this slice, it is
  still useful operational defense while later slices are incomplete.

## 4. Current system facts

### Online activation contract

The online submit/import paths have two separate responsibilities:

- `router.ts` claims the by-url slot before activation. For a new reading, it
  writes `index/by-url/{urlHash}` conditionally with `ifNotExists`.
- `activateAttempt` then writes activation artifacts in order:
  `raw/extracted` if any, `manifest.json`, by-id pointer, `index/list.json`,
  queue message.

That ordering matters. The pointer can exist before the manifest for a very
short window, and `ReadingClaim` treats a fresh pointer-without-manifest as an
`initializing` owner. Once the manifest exists and matches id/url/url_hash, a
duplicate submit returns the existing manifest.

### Offline corpus-ingest contract

The fresh-markdown path is split like this:

- `prepareFreshMarkdown` resolves ownership before planning a batch:
  ready owners skip, pending owners skip, failed owners re-ingest in place, and
  unclaimed URLs mint a new reading id/key_prefix.
- `runFreshMarkdownBatch` feeds the planned targets into the shared batch tail.
- `submitBatch` currently writes raw/extracted objects and the sidecar, then
  calls `batch.create(...)`.
- `writeResults` later writes terminal ready or failed manifests and updates
  pointers/list/vector state.

The race exists because `submitBatch` does not publish an owner while the batch
is in progress.

### Online stale annotation constraint

The Worker annotates old `pending` manifests as effective `failed` at read time.
That is useful for stranded realtime queue attempts, but it is unsafe for this
batch-owned pending state: an Anthropic Message Batch can run longer than
`PENDING_TTL_SECONDS`. If a live submit sees the offline pending owner after TTL
and the router treats it as failed, `submitResultForOwnedReading` will enqueue a
reprocess and recreate the duplicate-work race this issue is closing.

Therefore the offline pending manifest needs a schema-compatible batch marker
and the stale rule needs a narrow exemption for that marker. Prefer:

- stamp `active_attempt` with an id prefixed by `batch_`, trigger `"import"`,
  status `"running"`, stage `"summarize"`, and `started_at` equal to activation
  time;
- add a tiny helper such as `isBatchOwnedPending(input)` in or near
  `staleness.ts`;
- when the marker is present, do not synthesize `stale_active_attempt` or
  `stale_pending` for read-time annotation.

Terminal success/failure clears this marker by overwriting the manifest, exactly
as the write phase already does. A truly stranded batch-owned pending remains a
manual reconciliation case, protected by the sidecar marker and follow-up
failure-release work, rather than becoming a realtime queue job.

### Important edge case: self-owned pointers

Some activation candidates already have a live by-url pointer:

- A failed reading with a valid by-url pointer is re-ingested in place.
- A failed reading found through a damaged-pointer repair scan may have an
  occupied by-url slot, but not necessarily one that safely points to the target.
- A prior failed fresh ingest may have no by-url pointer, but still be found by
  cold list-index lookup and re-ingested in place.

The eager activation code must not reduce all "pointer exists" cases to "skip".
It needs an explicit claim policy per target:

- `create-new`: the URL was unclaimed at planning time and no existing reading
  is being reused. The activation phase must conditional-create the by-url
  pointer. If it loses, skip.
- `create-existing-failed`: the URL had no usable by-url pointer, but cold
  lookup found a failed reading to reuse. The activation phase must revalidate
  that existing manifest before claiming, conditional-create the by-url pointer,
  then revalidate again before overwriting the manifest. If it became
  ready/pending before the claim, skip. If it becomes missing/mismatched or
  ready/pending after the claim succeeds, abort fail-closed and leave the
  activating sidecar for manual reconciliation.
- `verify-existing-failed`: the URL had a valid by-url pointer to the same
  id/key_prefix at planning time. The activation phase must re-read and verify
  that the pointer still points to the same target and the current manifest is
  still the planned failed/retryable reading. It must then re-read pointer +
  manifest immediately before the first destructive write. If anything changed
  before the write, abort fail-closed rather than clobbering a reading that may
  have become ready/pending.
- `occupied-needs-repair`: a damaged or mismatched pointer occupied the slot.
  For this issue, skip before activation rather than overwriting. Pointer repair
  and failure-release semantics belong in later slices.

## 5. Durable implementation decisions

- **Scope boundary:** implement the activation step only for the fresh-markdown
  front-end (`corpus-ingest`). The shared recover path must stay unchanged unless
  types need optional fields that recover can ignore.
- **Pipeline placement:** run fresh activation before `resolveSimilar`. A target
  that loses or fails activation must not spend OpenAI embedding tokens or
  Vectorize query work, and it must not reach Anthropic.
- **Data model:** extend the batch target/sidecar target metadata with a small
  offline activation policy, not with Worker-only concepts. The policy only
  needs to answer whether the by-url slot should be created or verified.
- **Pending manifest shape:** reuse the target manifest fields already created
  by `prepareFreshMarkdown`, but normalize it through `ManifestSchema.parse`
  before writing. Include `status: "pending"`, `source_type: "markdown"`,
  content descriptors, `created_at`, `updated_at`, and the batch-owned
  `active_attempt` marker described above. Do not invent a new manifest status
  or add new manifest fields.
- **Attempt logging:** do not add a full attempt log in this slice. The existing
  batch paths already omit `last_attempt`. Adding batch attempt diagnostics is a
  broader schema/UX concern.
- **Pointer JSON:** single-home pointer serialization in a helper shared by
  submit/write phases so by-id and by-url pointer writes do not drift.
- **List row:** use existing `manifestToIndexItem(manifest, keyPrefix)` for the
  pending row, matching terminal writes.
- **R2 conditional write:** extend the Node R2 client with an explicit
  conditional-create method or option that sends `If-None-Match: *` when using
  the S3 API. Treat HTTP `412 Precondition Failed` and `409 Conflict` as "slot
  already owned" (`false`), not as fatal batch failures. Preserve throw-on-error
  behavior for all other non-2xx responses. Confirm the exact staging response
  during manual verification before relying on the path operationally.
- **Sidecar timing:** keep the sidecar crash-window guarantee by adding an
  activation marker before the first durable by-url claim. Save sidecars
  atomically (temp file + rename) and make `loadSidecar` fail closed when the
  sidecar path exists but is unreadable or unparseable. The final fresh flow
  should be:
  `activating sidecar -> by-url claim/verify -> raw/extracted -> pending manifest
  -> by-id pointer -> list row -> resolveSimilar -> pending sidecar with
  activated targets -> batch.create -> final sidecar`.
  A crash after the activating sidecar but before `batch.create` must make a
  rerun abort for manual reconciliation. It is acceptable for the abort message
  to generalize the existing "pending sidecar with no batch id" warning to cover
  both "batch may have been created" and "activation may have stranded owners".
  Model the activating sidecar as an explicit union variant, not as a normal
  `SidecarTarget` with fake embedding-token fields.
- **Claim before manifest:** for `create-new` and `create-existing-failed`
  targets, the conditional by-url claim should happen before writing the pending
  manifest/by-id/list row. This mirrors the Worker's initializing-pointer
  tolerance and prevents a lost conditional claim from leaving a batch-created
  pending manifest for a URL owned by someone else. Existing-failed targets add
  the pre- and post-claim manifest revalidation above because they reuse a real
  reading, not a newly minted one.
- **Skip semantics:** if activation skips targets after planning, those skipped
  targets must not be included in Anthropic requests or in the sidecar targets.
  The operator report/log should state why they were skipped.

## 6. Proposed code changes

### 6.1 Add activation metadata to fresh-markdown targets

Add a fresh-ingest-only activation policy that flows from
`prepareFreshMarkdown` to the fresh activation phase.

Suggested shape:

```ts
type BatchActivationPolicy =
  | { kind: "create-new" }
  | { kind: "create-existing-failed"; expected: ExpectedExistingFailed }
  | { kind: "verify-existing-failed"; expected: ExpectedExistingFailed }
  | { kind: "occupied-needs-repair"; reason: string };

interface ExpectedExistingFailed {
  id: string;
  keyPrefix: string;
  url: string;
  urlHash: string;
  createdAt: string;
}
```

Add `freshActivation?: BatchActivationPolicy` to `ExtractedTarget`, keeping the
generic recover `BatchTarget` free of fresh-ingest semantics.

Map policies in `prepareFreshMarkdown`:

- New unclaimed URL: `create-new`.
- Failed owner found via live matching by-url pointer:
  `verify-existing-failed`.
- Failed owner found via cold list-index lookup with no live by-url pointer:
  `create-existing-failed`.
- Failed owner found after a damaged/mismatched live pointer forced a scan:
  `occupied-needs-repair` for this slice, regardless of whether the scan finds a
  failed cold owner. A present non-self-owned by-url object is an occupied slot;
  do not mint a new target and rely on submit-time `putIfAbsent` to fail.
- Damaged/mismatched by-url pointer and no cold owner: skip with a new
  disposition such as `skip-occupied-needs-repair` so the operator sees the URL
  was blocked by an occupied slot, not silently treated as unclaimed.

Implementation note: the current planner does not retain enough detail to
distinguish all of these after it falls through to cold lookup. Add local
variables that remember the by-url read result and whether the usable owner was
matching, absent, or damaged. Keep the planner's existing ready/pending skip
behavior unchanged.

### 6.2 Add a small batch activation module

Create `scripts/corpus-lib/batch/activation-phase.ts`. Keep it separate from
`submit-phase.ts` because it runs before `resolveSimilar` and should not know
about Anthropic request construction.

Responsibilities:

- Build the pending manifest to write for an `ExtractedTarget` before similarity
  resolution.
- Build an activating sidecar marker before the first durable by-url write.
- Claim or verify `index/by-url/{urlHash}` according to the activation policy.
- For any target that reuses an existing reading id/key_prefix, re-read the
  manifest before any by-url write. Activate only if it still matches
  id/url/url_hash and still has `status: "failed"`. Skip before claiming if it
  became `ready` or `pending`; skip before claiming if the manifest is missing or
  mismatched because no durable activation has happened yet.
- For `create-existing-failed`, re-read the manifest again immediately after a
  successful conditional by-url claim and before writing content/manifest/list.
  If it is no longer the expected failed manifest, abort fail-closed rather than
  returning a normal skipped row; the by-url claim is already durable and must be
  manually reconciled.
- For `verify-existing-failed`, re-read both the by-url pointer and manifest
  immediately before writing content/manifest/list. If the pointer no longer
  points at the target, or the manifest is no longer the expected failed
  manifest, abort fail-closed. This is deliberately stricter than a normal skip:
  the activation code is about to overwrite an existing reading and must not race
  a realtime repair/reprocess to ready.
- Write fresh raw/extracted objects exactly as `submitBatch` does today, but only
  after the target's by-url slot is claimed or verified.
- Write `${keyPrefix}/manifest.json`.
- Write `index/by-id/{id}` with the byte-compatible pointer JSON.
- Merge pending list rows into `index/list.json`.
- Return only activated targets to the request-building step.
- Return skipped rows with reason strings for logging/reporting.

The module should not call Anthropic and should not know about prompt building.
That keeps it testable as pure R2 behavior plus deterministic target filtering.
It should receive the full R2 client, or a small activation-specific R2
interface, rather than the current `putObject` callback; activation needs
`put`, `putIfAbsent`, and `get`/pointer verification, not just raw object writes.

Suggested activation return:

```ts
interface ActivationResult {
  activated: ExtractedTarget[];
  skipped: WriteReportRow[];
}
```

For activated fresh-markdown targets, activation owns the raw/extracted writes.
Return activated targets in a shape that prevents `submitBatch` from writing the
same objects again: add an explicit `contentAlreadyWritten: true` flag that
`submitBatch` respects while still using the scalar descriptors needed for the
sidecar. Do not leave two phases responsible for the same R2 objects.

Suggested activating sidecar shape:

```ts
interface ActivatingSidecar {
  batchId: "";
  model: string;
  processingStatus: "activating";
  resultsUrl: null;
  targets: Array<{
    id: string;
    customId: string;
    keyPrefix: string;
    url: string;
    urlHash: string;
    createdAt: string;
  }>;
}
```

Make `loadSidecar` validate and return `Sidecar | ActivatingSidecar | null`.
Use zod or a tight manual validator; valid JSON with the wrong shape is not
"absent". Unknown `processingStatus`, missing `batchId`, malformed targets, or
missing target fields should fail closed with an actionable error. Any sidecar
with empty `batchId` should continue to abort before planning; `writeResults`
must only ever receive a normal post-create `Sidecar`.

`runBatchPipeline` should call this fresh-only activation hook before
`resolveSimilar`. The recover path passes no activation hook and keeps the
current flow.

### 6.3 Extend the script R2 client for conditional create

Current `scripts/lib/cf-clients.ts` only exposes:

```ts
put(key, body, opts): Promise<void>
```

Add this API:

```ts
putIfAbsent(key, body, opts): Promise<boolean>
```

Behavior:

- Send `If-None-Match: *` with the signed PUT request.
- Return `true` on success.
- Return `false` on `412 Precondition Failed` or `409 Conflict`.
- Preserve existing error behavior for other failures.
- Implement the dry-run client with a clear log and `true`.
- Update in-memory test harnesses to model false when a key already exists.
- Add a staging smoke note to confirm whether R2 returns `412`, `409`, or both
  for this conditional PUT; if staging shows a different conflict response, add
  that status deliberately with a test rather than broadening all non-2xx.

### 6.4 Merge list rows safely enough for this path

Extract the existing `mergeListIndex` helper from `write-phase.ts` to
`scripts/corpus-lib/batch/list-index-write.ts` and reuse it from both activation
and terminal write phases. The activation pending write and terminal write
should not drift in how they replace cross-wired rows.

Do not introduce CAS in this slice unless the R2 client change makes it
straightforward. The CLI still requires `--sole-writer`; the critical race being
closed is the realtime submit seeing no by-url owner, not concurrent list-index
writers.

### 6.5 Modify `submitBatch`

Preserve `submitBatch` as the Anthropic submission phase. It should receive only
already-activated fresh targets, or legacy recover targets, and keep the existing
flow:

1. Write raw/extracted content.
2. Build requests and sidecar targets.
3. Save pending sidecar.
4. Create batch.
5. Save final sidecar.

For activated fresh-ingest targets, step 1 should be a no-op because activation
already wrote the content. Keep step 1 for recover/legacy targets that still
carry `fresh` content from extraction.

The activation-related control flow belongs one level up in `runBatchPipeline`:

1. Produce extracted targets.
2. If a fresh activation hook is present, save the activating sidecar and
   activate/filter extracted targets.
3. If no targets remain after activation, clear the activating sidecar and return
   `{ report: skipped, dropped, resumed: false }` with no `batchId`, no
   `resolveSimilar`, no `batch.create(...)`, and no poll.
4. Run `resolveSimilar` only for activated targets.
5. Call `submitBatch`; it saves the usual pending sidecar, creates the batch, and
   saves the final sidecar.
6. Poll/write, then combine activation skipped rows with the terminal write
   report.

Add `clearSidecar(): Promise<void>` to `BatchRunDeps` and thread it from
`corpus-ingest` / `corpus-recover`. Recover can pass its existing sidecar clearer
and should otherwise remain behaviorally unchanged.

### 6.6 Thread skipped activation rows into reports/logs

The shared `BatchRunResult` already has `dropped`, and `WriteReportRow` supports
`status: "skipped"`. Avoid overloading unrelated concepts if possible:

- For targets skipped before `batch.create`, prefer reporting them as
  `WriteReportRow` with `status: "skipped"` and reason like
  `"by-url slot already owned at batch submit"`.
- The activation phase should return skipped rows. `runBatchPipeline` should
  prepend/append them to the terminal write report so a mixed batch reports both
  submit-time skips and batch-result outcomes.

The operator should see both:

- planned dispositions from `prepareFreshMarkdown`;
- final activation skips caused by races between planning and submit.

### 6.7 Leave terminal success behavior mostly unchanged

`writeResults` already writes:

- ready manifest;
- by-url pointer;
- by-id pointer;
- list row;
- vector.

After #69, success will often overwrite a by-url pointer that already points at
the same id/key_prefix. That is fine. Add a regression assertion that the
terminal success path preserves the same id/key_prefix and does not create a
second list row when starting from a pending activation row.

### 6.8 Carefully document failure behavior

This slice intentionally creates a new intermediate state:

- pending manifest plus by-url pointer exists while batch is in flight;
- if batch succeeds, pending becomes ready;
- if batch fails, current terminal failure code writes failed manifest + by-id +
  list and does not write by-url.

Because `writeResults` currently does not delete by-url pointers, an eager claim
would remain unless a later slice releases it. The issue explicitly says
failure-path slot release is out of scope. The implementation plan should still
make this explicit in comments and tests:

- Do not accidentally add partial release behavior in this slice.
- Add a TODO or issue reference near failure write behavior if a test documents
  the retained by-url pointer.
- Add a regression test that starts with an eager pending by-url pointer and a
  failed batch result, then asserts the failed manifest/by-id/list row are
  written while the same by-url pointer remains.
- Keep retryability expectations aligned with the next slice.

If during implementation this retained pointer makes existing tests fail, update
the tests to describe the new intermediate contract and link to the follow-up
release slice rather than silently restoring the old no-by-url expectation for
fresh eager-claimed failures.

### 6.9 Add the narrow batch-pending stale exemption

Update `src/modules/staleness.ts` and the thin router adapters so batch-owned
pending manifests are not annotated stale while the schema-compatible marker is
present. This is intentionally marker-only: submit dedup still requires a
matching by-url owner because `ReadingClaim` finds the manifest through that
pointer, but detail/list stale annotation should also respect the marker even if
an operator is already manually reconciling a damaged or missing by-url pointer.

Do not broadly exempt all markdown imports or all active attempts. Key the
exemption to the schema-compatible batch marker stamped during activation:

```ts
active_attempt: {
  id: `batch_${...}`,
  trigger: "import",
  status: "running",
  stage: "summarize",
  started_at: activationTime
}
```

The helper should be unit-tested directly in `test/unit/staleness/staleness.test.ts`.
The integration test in Phase 6 should include both fresh and older-than-TTL
offline pending owners.

### 6.10 Update CLI operator text

Update `scripts/corpus-ingest.ts` usage text and comments that currently say the
by-url slot stays unclaimed until success. After this issue, fresh ingest should
say it eagerly claims activated targets before batch creation, while `--sole-writer`
is still required because recover parity and failure-release slices are not done.

`scripts/corpus-recover.ts` can keep its unclaimed-window warning for
`corpus-recover --batch`; only thread `clearSidecar` through it if `BatchRunDeps`
requires the method for the shared pipeline.

## 7. TDD plan

Follow red-green-refactor. Add failing tests before implementation.

### Phase 1 - Unit-test activation metadata in `prepareFreshMarkdown`

Tests in `test/unit/corpus/batch/prepare-fresh-markdown.test.ts`.

Add cases:

- New unclaimed URL produces an ingest target with `create-new`.
- Failed owner with a live matching by-url pointer produces
  `verify-existing-failed` and still reuses id/key_prefix/created_at.
- Prior failed fresh ingest found through list index with no by-url pointer
  produces `create-existing-failed`.
- Damaged/mismatched by-url pointer plus failed cold owner does not blindly
  declare `create-existing-failed`; it either marks `occupied-needs-repair` or skips
  according to the final chosen API.
- Damaged/mismatched by-url pointer plus no cold owner produces
  `skip-occupied-needs-repair` (or the final equivalent name), not a minted
  `ingest-new` target.
- Ready and pending owners still skip exactly as before.

Run:

```sh
npm run test:quiet -- test/unit/corpus/batch/prepare-fresh-markdown.test.ts
```

### Phase 2 - Unit-test conditional R2 create support

Tests in `test/unit/lib/cf-clients.test.ts`.

Add cases:

- `putIfAbsent` signs/sends `If-None-Match: *`.
- Success returns `true`.
- `412` and `409` conditional failures return `false`.
- Other non-2xx failures throw with the same useful message style as `put`.
- Dry-run implementation logs and returns `true`.

If the tests fake fetch at the signed-request boundary, assert the outgoing
request header rather than relying on exact AWS authorization bytes.

Run:

```sh
npm run test:quiet -- test/unit/lib/cf-clients.test.ts
```

### Phase 3 - Unit-test the fresh activation phase

Tests in a new `test/unit/corpus/batch/activation-phase.test.ts`, plus
`test/unit/corpus/batch/sidecar.test.ts` for sidecar I/O.

Add an order-recording fake R2 and fake batch:

- For a fresh markdown target, assert the order is:
  activating sidecar, by-url claim/verify, raw object, extracted object, pending
  manifest, by-id pointer, list index. `resolveSimilar`, pending sidecar, and
  `batch.create` should not happen until after activation returns.
- Assert sidecar saves are atomic enough for this CLI: write through a temp file
  then rename, and make `loadSidecar` throw/fail closed when the sidecar path
  exists but contains partial or unparseable JSON.
- Assert sidecar validation accepts the three legitimate persisted states:
  activating sidecar, pre-create pending sidecar with `batchId: ""`, and
  post-create sidecar with a real batch id.
- Assert valid JSON with invalid shape fails closed: unknown `processingStatus`,
  missing `batchId`, malformed activating targets, malformed normal targets, and
  non-ENOENT filesystem read errors all abort with actionable messages instead
  of returning `null`.
- Assert a throw/crash after the by-url claim but before `batch.create` leaves an
  activating sidecar with empty `batchId`, causing the next run to abort rather
  than re-plan and silently skip the now-pending owner.
- Assert the pending manifest parses with `ManifestSchema` and has:
  `status: "pending"`, matching id/url/url_hash, markdown source type,
  captured content fields, stable `created_at`, and a batch-owned
  `active_attempt` marker.
- Assert pointer JSON parses to exactly `{ id, key_prefix }`.
- Assert pending list row has the target id and pending status.
- Assert activated fresh targets do not cause `submitBatch` to write raw/extracted
  content a second time.
- Assert `verify-existing-failed` skips if the pointer is still equal but the
  manifest became `ready`, became `pending`, went missing, or no longer matches
  id/url/url_hash.
- Assert `create-existing-failed` revalidates before claiming, then aborts
  fail-closed (not normal-skip) if the manifest changes after its conditional
  by-url claim succeeds.
- Assert `verify-existing-failed` performs the final pointer + manifest
  revalidation immediately before destructive writes and aborts fail-closed if
  the manifest flips to `ready` between the initial verification and the write.

Run:

```sh
npm run test:quiet -- test/unit/corpus/batch/activation-phase.test.ts test/unit/corpus/batch/sidecar.test.ts
```

### Phase 4 - Unit-test submit-time race handling

Tests in `test/unit/corpus/batch/submit-phase.test.ts` or
`run-fresh-markdown.test.ts`.

Add cases:

- `create-new` target loses the by-url conditional create. It is skipped,
  Anthropic receives no request for it, and the report/log includes a reason.
- Mixed batch: one target activates, one loses ownership. `batch.create` is
  called with only the activated target, and the skipped row appears in the run
  result.
- `verify-existing-failed` target succeeds when the existing pointer still equals the
  target pointer.
- `verify-existing-failed` target skips when the existing pointer changed to another
  id/key_prefix after planning.
- `occupied-needs-repair` target does not overwrite the occupied by-url slot in
  this slice.
- All targets skipped: `batch.create` is not called, the activating sidecar is
  cleared, `BatchRunResult.report` contains skipped rows, `batchId` is absent,
  and neither embed/query nor Anthropic batch creation is called.

Run:

```sh
npm run test:quiet -- test/unit/corpus/batch/activation-phase.test.ts test/unit/corpus/batch/submit-phase.test.ts test/unit/corpus/batch/run-fresh-markdown.test.ts
```

### Phase 5 - Unit-test terminal success over pending activation

Tests in `test/unit/corpus/batch/write-phase.test.ts` and/or
`run-fresh-markdown.test.ts`.

Add cases:

- Starting from an eager pending manifest + by-url pointer + by-id pointer +
  list row, a successful batch result writes a ready manifest at the same
  key_prefix.
- The by-url pointer still points at the same id/key_prefix after success.
- `index/list.json` has one row for the id/key_prefix, with status `ready`, not
  both pending and ready rows.
- Vector upsert behavior is unchanged.

Also add the failure-side characterization in the same suite:

- Starting from an eager pending manifest + by-url pointer + by-id pointer +
  list row, a failed batch result writes a failed manifest at the same
  key_prefix, writes/keeps by-id, updates the list row to failed, and leaves the
  existing by-url pointer untouched. Include a TODO/comment pointing at the later
  failure-release slice.

Run:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts test/unit/corpus/batch/run-fresh-markdown.test.ts
```

### Phase 6 - Unit-test the stale exemption

Tests in `test/unit/staleness/staleness.test.ts`.

Add cases:

- A normal old `pending` manifest still returns `pendingError`.
- A normal old running active attempt still returns `expiredActiveAttempt`.
- A batch-owned pending marker (`active_attempt.id` starts with `batch_`,
  trigger `"import"`, status `"running"`, stage `"summarize"`) does not return
  either stale verdict, even when older than `PENDING_TTL_SECONDS`.
- Near-miss markers do not get the exemption: wrong id prefix, wrong trigger, or
  wrong stage should preserve existing stale behavior.

Run:

```sh
npm run test:quiet -- test/unit/staleness/staleness.test.ts
```

### Phase 7 - Integration-test Worker deferral against offline pending

Test in `test/integration/readings.test.ts`.

Seed the Worker test R2 bucket with a batch-shaped offline pending owner:

- pending manifest under `readings/.../manifest.json`;
- by-id pointer at `index/by-id/{id}`;
- by-url pointer at `index/by-url/{urlHash}`;
- list row via `manifestToIndexItem`.

Then call `POST /readings` for the same URL.

Assert:

- response status is `200`;
- response body id matches the offline batch reading id;
- response body status is `pending`;
- no queue job is enqueued;
- a subsequent lookup returns the same id.
- repeating the same test with `updated_at` older than `PENDING_TTL_SECONDS` and
  the batch-owned active-attempt marker still returns the pending reading and
  does not enqueue a reprocess.

This proves the online side "defers for free" once the offline side writes the
same ownership contract.

Run:

```sh
npm run test:quiet -- test/integration/readings.test.ts
```

### Phase 8 - Full verification

After focused tests pass:

```sh
npm run test:quiet
npm run typecheck
```

The SPA should not need changes. Do not run `cd web && npm test` unless the
manifest/API contracts change, which this issue should avoid.

## 8. Manual verification plan

After implementation and tests:

1. Run a dry-run `corpus-ingest` over a tiny markdown directory and confirm it
   still prints the same ownership disposition counts without submitting.
2. Run an execute batch against staging or a local fake with `--limit 1` and
   `--sole-writer`.
3. Confirm the real R2 conditional PUT conflict status by attempting a
   `putIfAbsent` against an existing scratch key; it should return `false` for
   the observed status (`412` or `409`) and throw for unrelated failures.
4. Immediately after submit but before results are written, inspect R2:
   - `readings/.../manifest.json` exists and is pending;
   - `index/by-id/{id}` exists;
   - `index/by-url/{urlHash}` exists;
   - `index/list.json` contains the pending row.
5. While the batch is in flight, submit the same URL through the API and confirm
   the API returns the existing pending id rather than creating a second id.
6. Let the batch finish and confirm the same reading becomes ready, with one
   list row and one by-url owner.

## 9. Rollout and follow-up notes

- Keep the PR focused on issue #69. Do not combine with failure release or
  recover parity.
- In the PR description, call out the intentionally retained limitation:
  failure-path by-url release remains a follow-up slice.
- If the implementation changes failure semantics enough to make stale failures
  less retryable, stop and split the failure-release slice first rather than
  hiding that behavior inside this tracer.
- After this lands, update the parent issue #66 checkbox for eager by-url claim.

## 10. Files likely touched

- `scripts/corpus-lib/batch/prepare-fresh-markdown.ts`
- `scripts/corpus-lib/batch/types.ts`
- `scripts/corpus-lib/batch/activation-phase.ts`
- `scripts/corpus-lib/batch/list-index-write.ts`
- `scripts/corpus-lib/batch/submit-phase.ts`
- `scripts/corpus-lib/batch/write-phase.ts`
- `scripts/corpus-lib/batch/run.ts`
- `scripts/corpus-lib/batch/run-fresh-markdown.ts`
- `scripts/corpus-lib/batch/sidecar.ts`
- `scripts/corpus-ingest.ts`
- `scripts/corpus-recover.ts`
- `scripts/lib/cf-clients.ts`
- `src/modules/staleness.ts`
- `src/router.ts`
- `test/unit/corpus/batch/prepare-fresh-markdown.test.ts`
- `test/unit/corpus/batch/activation-phase.test.ts`
- `test/unit/corpus/batch/submit-phase.test.ts`
- `test/unit/corpus/batch/sidecar.test.ts`
- `test/unit/corpus/batch/run-fresh-markdown.test.ts`
- `test/unit/corpus/batch/write-phase.test.ts`
- `test/unit/staleness/staleness.test.ts`
- `test/integration/readings.test.ts`

## 11. Open implementation questions

None known after this review pass. The batch-owned `active_attempt` marker is no
longer optional; it is the compatibility hook that keeps long-running batches
from being reprocessed by the realtime Worker.
