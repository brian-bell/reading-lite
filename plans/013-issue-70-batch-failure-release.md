# Plan 013 - Issue #70: Batch failure by-url slot release

> Source: https://github.com/brian-bell/reading-lite/issues/70
>
> Parent: issue #66, option (b), second tracer-bullet slice.
>
> Depends on: plan 012 / issue #69, the fresh-ingest eager by-url claim.

## 1. Goal

Finish the failure side of fresh batch eager ownership.

Issue #69 made `corpus-ingest` publish an in-flight by-url owner before
submitting the Anthropic Message Batch. That closes the batch-vs-online
unclaimed-window race while the batch is running, but it changes the failure
contract: a failed batch target now has a durable `index/by-url/{url_hash}`
pointer unless the write phase actively releases it.

The intended terminal state for a fresh batch failure is:

- a retryable `failed` manifest at the target key prefix;
- a by-id pointer so detail, diagnostics, and explicit reprocess can still find
  the failed reading;
- an `index/list.json` row reflecting the failed manifest;
- no by-url ownership pointer for that failed URL, unless another owner took the
  pointer before the release check.

This mirrors the existing online rollback-to-failed semantics: failed URLs stay
re-submittable, while the failed reading remains reachable by id.

## 2. Acceptance criteria

- [ ] When a batch result fails for a target whose by-url pointer still points
      at that target, `writeResults` writes the retryable failed manifest, keeps
      or writes the by-id pointer, updates `index/list.json`, and deletes
      `index/by-url/{target.urlHash}`.
- [ ] A clean non-eager failure remains idempotent: if no by-url pointer exists,
      the failure path still succeeds and does not invent one.
- [ ] The failure release is ownership-aware. If the by-url pointer points to a
      different id/key_prefix by terminal write time, the batch must not delete
      it.
- [ ] A failure that rolls forward to `preserveReadyManifest` must not release
      the by-url pointer, because the terminal manifest remains `ready`.
- [ ] The existing failure behavior remains intact: no vector upsert on failure,
      by-id pointer is written, and `index/list.json` is merged once at the end.
- [ ] Integration coverage proves the user-visible acceptance from issue #70:
      after a batch failure releases its eager claim, an online submit for the
      same URL reprocesses the failed reading in place and returns a pending
      response for the same id.

## 3. Non-goals

- Do not change terminal success behavior. Success still writes ready manifest,
  by-url pointer, by-id pointer, list row, and vector.
- Do not add `corpus-recover --batch` eager-claim parity. This slice only fixes
  terminal failure cleanup after the fresh-ingest eager claim.
- Do not remove the `--sole-writer` guard yet. The guard can be revisited only
  after all issue #66 parity slices are complete.
- Do not add attempt-log diagnostics for batch failures. The batch path already
  records the terminal failed manifest without full Worker attempt logs.
- Do not make read-only lookup repair or delete pointers. The release belongs
  to the terminal batch write phase.

## 4. Current system facts

### Batch write phase

`scripts/corpus-lib/batch/write-phase.ts` already splits terminal writes into
successes and failures.

Success currently writes:

- ready manifest;
- by-url pointer;
- by-id pointer;
- list item;
- vector.

Failure currently writes:

- failed manifest, or a rolled-forward preserved ready snapshot;
- by-id pointer;
- list item.

The file comments explicitly call out the missing follow-up: the failure branch
tolerates a pre-existing eager by-url claim but does not release it.

### Online failure semantics to mirror

`process-reading.ts` uses `commitTerminalManifest(..., similarity: null, ...)`
on failure. For a newly failed owner, the by-url pointer is not claimed by the
failure write itself. Failed owners stay re-submittable because the router can
resolve a failed owner and activate a new pending attempt in place.

For batch failures after issue #69, the difference is that the by-url pointer
already exists from activation. Therefore the batch terminal failure must delete
only its own eager claim, while preserving by-id reachability.

### Safety constraint

By-url deletion must be conditional in behavior, even though the Node R2 client
currently exposes only unconditional `delete(key)`.

The write phase should read `index/by-url/{target.urlHash}` immediately before
deleting and delete only when the parsed pointer equals:

```ts
{ id: target.id, key_prefix: target.keyPrefix }
```

If the pointer is absent, malformed, missing `id` / `key_prefix`, or points
elsewhere, do not delete it. A damaged pointer is an operator-repair case;
deleting it blindly risks releasing or damaging a concurrent owner.

Do not swallow R2 read failures. `R2Client.get` returns `null` only for 404 and
throws for non-OK reads; a transient permission/network/service error should
abort `writeResults` so the operator can retry rather than silently leaving the
by-url slot pinned after a reported-successful write phase.

This is a best-effort race reduction, not a perfect CAS delete. The residual
race is acceptable under the repo's existing last-writer-wins stance: a pointer
could change between read and delete. If Cloudflare R2 S3 conditional delete
support is later added to `R2Client`, this helper can be tightened without
changing call sites.

## 5. Proposed implementation

### 5.1 Extend the write dependencies deliberately

`WriteDeps.r2` already uses `R2Client`, whose runtime implementation includes
`delete(key)`. Make the dependency on delete explicit in tests and fakes:

- update the `fakeR2` in `test/unit/corpus/batch/write-phase.test.ts` with a
  `delete` method that records/removes keys;
- keep the production `WriteDeps` type as `R2Client` unless narrowing it makes
  the tests clearer.

No production client change should be required unless TypeScript exposes a
missing method through a narrowed test type.

### 5.2 Single-home ownership-aware release

Add a small helper in `write-phase.ts`, near the pointer helpers:

```ts
async function releaseByUrlIfOwned(target: SidecarTarget, deps: WriteDeps): Promise<void>
```

Suggested behavior:

1. Read `index/by-url/${target.urlHash}`.
2. If absent, return.
3. Parse the JSON pointer.
4. If `id` and `key_prefix` match the target, delete the computed
   `index/by-url/${target.urlHash}` key.
5. Otherwise return.

Parsing should be intentionally conservative. Catch JSON parse failures and
structural pointer failures, do not delete, and optionally log a line through
`deps.log`. Do not catch `deps.r2.get(...)` failures; those should bubble so the
write phase fails loudly and can be retried.

Use the existing serialized pointer shape from `pointers.ts`; do not invent a
new by-url schema or write tombstones.

### 5.3 Call release only for terminal failed manifests

In the failure loop:

```ts
const manifest = target.preserveReadyManifest
  ? rolledForward(...)
  : buildFailedManifest(...);

await write manifest;
await write by-id pointer;
if (manifest.status === "failed") await releaseByUrlIfOwned(target, deps);
touchedItems.push(...);
report.push(...);
```

The `manifest.status === "failed"` gate is important:

- fresh ingest failures should release the eager claim;
- preserved-ready failures should keep a ready URL owner intact.

Writing the failed manifest before deleting the by-url pointer is acceptable and
preferable. During the short window before deletion, online submit sees a failed
owner and may reprocess in place; after deletion, online submit can still find
the failed reading through the cold list-index lookup and reprocess in place.
Both outcomes satisfy "failed URLs stay re-submittable."

### 5.4 Update stale comments and docs

Adjust comments that currently say failure release is a follow-up:

- `write-phase.ts` top-level terminal-write contract;
- failure-loop comment around lines 113-126;
- `AGENTS.md` operational note if this plan is implemented later;
- `scripts/corpus-ingest.ts` / `sole-writer.ts` wording only if issue #70 is
  implemented and the remaining `--sole-writer` rationale should name only the
  still-open recover parity slice.

For this planning issue, do not edit those comments yet unless implementing the
code in the same branch.

## 6. TDD plan

Follow vertical red-green-refactor cycles. Do not write all tests first.

### Cycle 1: release own eager claim on failed result

RED:

- In `test/unit/corpus/batch/write-phase.test.ts`, replace the current
  "retains an eager by-url pointer" expectation with a behavior test named
  `releases its eager by-url claim when a batch result fails`.
- Seed `index/by-url/{hash}` with the target pointer.
- Run `writeResults(...)` with an errored result.
- Assert:
  - manifest status is `failed`;
  - by-id pointer exists and points to the target;
  - `index/by-url/{hash}` is absent;
  - report row is `{ id: "rd_a", status: "failed", reason: "boom" }`.

GREEN:

- Add the minimal `delete` fake method.
- Add `releaseByUrlIfOwned`.
- Call it for non-preserved failed manifests.

VERIFY:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts
```

### Cycle 2: non-eager failure remains idempotent

RED:

- Keep or tighten the existing `does not create a by-url pointer for a non-eager
  failed batch result` test.
- Add an assertion that `r2.delete` was not called when the key is absent, if
  the fake records deletes.

GREEN:

- If needed, make `releaseByUrlIfOwned` return early on `null`.

VERIFY:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts
```

### Cycle 3: do not delete a foreign owner

RED:

- Add `does not release a by-url pointer that no longer points exactly at the
  failed batch target`.
- Make this table-driven, because both fields are part of ownership. Cover:
  - same `id`, different `key_prefix`;
  - different `id`, same `key_prefix`;
  - different `id`, different `key_prefix`.
- Fail `rd_a` for each case.
- Assert the foreign pointer is unchanged and the failed manifest/by-id/list
  writes still happened. The same-id/different-key-prefix case is especially
  important: a newer online reprocess may reuse the reading id while moving
  ownership to a new key prefix, and a stale batch failure must not delete that
  newer owner.

GREEN:

- Add the id/key_prefix match before deletion.

VERIFY:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts
```

### Cycle 4: damaged pointers are not released, read errors fail loudly

RED:

- Add `does not release a malformed by-url pointer when a batch result fails`.
- Seed `index/by-url/{hash}` with malformed JSON, or with valid JSON missing
  `id` / `key_prefix`.
- Fail `rd_a`.
- Assert:
  - failed manifest is written;
  - by-id pointer is written;
  - list row is written;
  - the damaged by-url object is still present;
  - `r2.delete` was not called.
- Add a narrow subcase or separate test for an R2 read error on the by-url key:
  fake `r2.get("index/by-url/...")` rejects, then assert `writeResults` rejects.

GREEN:

- Catch only parse/schema failures inside `releaseByUrlIfOwned`.
- Let `deps.r2.get(...)` errors bubble.

VERIFY:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts
```

### Cycle 5: preserved-ready rollback keeps URL ownership

RED:

- Add `keeps by-url ownership when a failed batch result rolls forward to a
  preserved ready manifest`.
- Seed the by-url pointer with the target pointer.
- Use `sidecarTarget({ preserveReadyManifest: ready })`.
- Fail the result.
- Assert:
  - terminal manifest status is `ready`;
  - ready fields are preserved;
  - by-url pointer still exists and still points to the target.

GREEN:

- Gate release on `manifest.status === "failed"`.

VERIFY:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts
```

### Cycle 6: batch write failure then online resubmit

RED:

- Add an integration test in `test/integration/readings.test.ts` near the
  failed-owner/reprocess cases:
  `reprocesses in place after a failed fresh batch releases its by-url claim`.
- Arrange the initial R2 state as if issue #69 activation had happened:
  - eager by-url pointer for the target;
  - pending manifest for `id` at `keyPrefix`;
  - by-id pointer for `id`;
  - pending list row.
- In the test, run `writeResults(...)` with an errored result against the same
  Miniflare R2 bucket through a tiny test-only `R2Client` adapter (`get` returns
  object text, `put` writes strings, `delete` deletes keys). This makes the
  batch write phase produce the post-failure state instead of hand-seeding it.
- Assert the batch write produced:
  - failed manifest for `id`;
  - by-id pointer for `id`;
  - failed `index/list.json` row;
  - no by-url pointer for the URL.
- Submit the same URL to `POST /readings`.
- Assert:
  - response status is `202`;
  - response body has the same `id` and status `pending`;
  - exactly one queue message is enqueued with `{ id, trigger: "reprocess" }`;
  - lookup for the URL returns `{ id }` after the reprocess activation claims the
    by-url pointer again.

GREEN:

- Reuse the existing router behavior for no-pointer failed owners; do not treat
  renaming the legacy failed-owner test as sufficient acceptance. This cycle's
  value is proving that `writeResults` creates the exact state the router then
  accepts for online reprocess.

VERIFY:

```sh
npm run test:quiet -- test/integration/readings.test.ts -t "failed fresh batch"
```

### Cycle 7: refactor and full targeted verification

Refactor only after all tests are green:

- Keep pointer parsing local and tiny unless another batch module already has an
  equivalent helper worth reusing.
- Avoid a generic "delete pointer" abstraction unless a second caller appears.
- Update stale comments in `write-phase.ts`.

VERIFY:

```sh
npm run test:quiet -- test/unit/corpus/batch/write-phase.test.ts
npm run test:quiet -- test/integration/readings.test.ts -t "failed fresh batch|legacy failed reading"
npm run typecheck
```

Run full verification before shipping:

```sh
npm run test:quiet
npm run typecheck
```

## 7. Manual verification

Use staging only after the unit and integration tests pass.

1. Add a committed operator smoke helper for this slice, for example
   `scripts/smoke-batch-failure-release.ts`, or document an equivalent
   `tsx` one-off in the PR notes. The helper should:
   - load Cloudflare staging R2 credentials the same way the corpus scripts do;
   - write a tiny sidecar target plus the eager activation state
     (by-url pointer, pending manifest, by-id pointer, pending list row) for a
     throwaway URL;
   - call `writeResults` with a fabricated `BatchResult` of
     `{ type: "errored", error: { message: "manual smoke failure" } }`;
   - print the URL, id, key prefix, and object keys it touched so cleanup is
     deterministic.
2. Run that helper against staging only after unit/integration tests pass.
3. Confirm activation-state preconditions before the fabricated failure write:
   `index/by-url/{hash}` exists and the manifest is pending.
4. Let the helper process the failed result through `writeResults`.
5. Inspect R2:
   - failed manifest exists;
   - by-id pointer exists;
   - by-url pointer is absent, unless a newer owner claimed it;
   - list row is failed.
6. Submit the same URL through the Worker.
7. Confirm the response reuses the failed reading id, writes a new pending
   attempt, and enqueues a reprocess.
8. Clean up the throwaway reading objects, list row, and pointers using the
   existing corpus-drop/delete tooling or the helper's printed keys.

## 8. Risks and mitigations

- **Unconditional delete race:** `R2Client.delete` is unconditional. Mitigate by
  reading and matching the pointer immediately before deleting. A future helper
  can add conditional delete if Cloudflare's S3-compatible API supports the
  needed precondition.
- **Deleting ready ownership:** avoid by gating release on terminal
  `manifest.status === "failed"`.
- **Damaged pointer handling:** do not delete malformed pointers. Log and leave
  them for existing operator repair paths.
- **Read-error handling:** do not convert R2 read failures into "not owned" or
  "damaged" results. Let them abort the write phase so the operator can rerun
  after the transient failure clears.
- **Over-broad integration test:** the router already covers legacy failed
  no-pointer reprocess. The new integration assertion must run `writeResults`
  first so it proves the batch writer creates the state that the router accepts.

## 9. Completion checklist

- [ ] Unit failure-release tests added one at a time and passing.
- [ ] Damaged-pointer and by-url read-error tests added.
- [ ] Integration resubmit-after-batch-failure test added or existing coverage
      explicitly runs `writeResults` before the online submit.
- [ ] `write-phase.ts` comments updated to remove "follow-up slice" wording.
- [ ] No success-path behavior changed.
- [ ] Targeted tests, full quiet tests, and typecheck pass.
- [ ] Issue #70 acceptance checkbox can be marked complete in issue #66.
