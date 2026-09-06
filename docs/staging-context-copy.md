# Preparing a private staging context-copy artifact

`staging prepare-context` prepares production reading fixtures for a staging
measurement. It reads production/staging state and materializes local payloads;
**it never writes Cloudflare data, calls a provider, enqueues, or deploys**.
Source bucket/index are fixed to `reading-lite`; destination bucket/index are
fixed to `reading-lite-staging`. Source/destination tenants must be explicit and
distinct. The selected staging tenant must be active and paid work disabled.

This is artifact preparation, not an automated remote copier. Applying the
artifact's writes requires separate authorization and the revalidation/ordering
below. No production dependency or public administration endpoint is added.

## Prepare and inspect

Input JSON contains `ids` (1–200 unique reading IDs to seed) and `targets`
(up to 200 `{id, contentSha256, markdownSha256?}` measurement inputs). Pin
`markdownSha256` when reproducing a frozen cohort. Seed/target overlap becomes
`reprocess` under the same ID; other targets become `import`, preserving their
canonical URLs. New import IDs are recorded at execution, not invented here.

```sh
# Plan only: reads and prints counts/preconditions; writes no output files.
npm run ops -- staging prepare-context \
  --source-tenant usr_SOURCE --tenant usr_STAGING \
  --input /private/path/selection.json --corpus-vars /private/path/.corpus.vars

# Authorized LOCAL materialization only; output directory must not exist.
npm run ops -- staging prepare-context \
  --source-tenant usr_SOURCE --tenant usr_STAGING \
  --input /private/path/selection.json --corpus-vars /private/path/.corpus.vars \
  --output-dir /private/path/context-packet --execute
```

Wrangler supplies Cloudflare read authorization. Matching-account S3 inventory
credentials from the selected `.corpus.vars` (or environment) provide complete
prefix checks. The observed REST empty-list response omits pagination metadata;
this command does not reinterpret that missing metadata as an empty prefix.
Read transports reject remote mutation methods, apart from Vectorize's explicit
read-only `get_by_ids` POST. No secret values are included in the packet.

The planner checks source ownership pointers, ready manifests, raw hashes/sizes,
extracted sizes, vector identity/dimensions/namespace and canonical URL. Title/TLDR differences
between indexed metadata and manifests are listed in `metadataDrift`; the packet
preserves indexed metadata because that is what the hosted summarizer reads. It
does not repair production drift or substitute manifest text into the vectors. It
rejects destination list, pointer, prefix, ledger-ID, or vector collisions. Ready
manifests with historical expired attempt markers use the existing read-time
staleness projection at 900 seconds; fresh active attempts are refused. Old
attempt journals, checkpoints, and last-attempt references are not copied.
Source hashes always identify original stored bytes, including projected
manifests. This affects only the local staging fixture payload, never production.

## Packet contents

- `plan.json`: exact rooted destination keys; content types; payload SHA256s;
  source keys/hashes; destination-absence preconditions; tenant-rewritten vectors;
  ledger IDs; expected staging list ETag and SHA256; merged-list blob; and target
  import/reprocess mapping with frozen Markdown blobs.
- `blobs/<sha256>`: binary-faithful raw captures, Markdown, pointer/manifest/list
  payloads, and target Markdown. Identical bytes share a blob.
- `SHA256SUMS`: plan and every blob checksum. Verify all before application.

**This packet contains private article content, URLs, summaries, and vectors.**
Keep it outside git (for issue 193, under `.summarizer-comparisons/`). New packet
folders are mode 0700 and files 0600. Existing output folders are refused. An
interrupted local save is incomplete unless `plan.json`, all referenced blobs,
and the complete checksum file validate; use a new output directory on retry.

## Application contract after separate approval

1. Verify packet checksums, exact tenant/environment, current active tenant and
   disabled paid-work policy, queue/lease state, and an exclusive staging writer
   window. Re-read every source hash and all destination-absence preconditions,
   including target pointers/prefixes and ledger rows. Re-read the source vectors
   and compare values/metadata with the planned vectors after reversing only
   the explicit tenant-ID/namespace rewrite. Abort on any drift. A
   prepared artifact is not an isolation lock or a source snapshot guarantee.
2. Insert the seed IDs into the destination tenant's vector ledger before any
   vector upsert. Refuse conflicting or delete-submitted rows. Never change
   production ledger state or resurrect a deleting tenant.
3. Create raw/Markdown/manifests using conditional absent-only writes. Do not
   overwrite destination objects. Preserve bytes and the planned content types.
4. Upsert the planned existing vector values with staging namespace, composed
   staging vector IDs, and staging `tenant_id` metadata. Verify values, namespace,
   metadata, and query visibility. Compare each object with its planned payload;
   declared title/TLDR drift mirrors production and is not silently repaired. An asynchronous mutation acknowledgement alone
   is not completion. Never delete bare IDs or touch retained legacy vectors.
5. Create by-ID/by-URL pointers conditionally. CAS the merged list against the
   recorded ETag and body hash using the existing R2 conditional-write adapter.
   If the list changed, stop and prepare/review a new merge; never blindly replace
   it. All original list rows remain in the planned merged list.
6. Verify final fixture content/pointers/list/vector consistency. Only then
   enable any separately approved paid run. On partial failure, retain evidence
   and report exact created state; this command has no automatic rollback,
   cleanup, or resumable remote application engine.

The artifact does not include executable SQL or an automatic apply command.
Its ordered mutation manifest is reviewable and can be applied through existing
operator adapters after approval. This separation keeps a local preparation
request from becoming a remote write authorization.

## Current issue 193 status

Revision `193-v2.1` and its 90-seed packet were approved and applied to staging
on September 6, 2026. Private detailed status instrumentation was deployed and
verified beforehand. The original absent-only packet has been consumed; do not
rerun it. See the [next-stage handoff](193-v2.1-handoff.md) for verified results,
private evidence locations, and the boundary before paid execution.

The sections below retain the earlier 193-v2 preparation history.

## Historical issue 193 readiness

The 193-v2 input fixes 91 seed readings and 65 measurement targets: 54 imports
and 11 identity-preserving reprocesses. The private copy packet is generated
separately from the earlier metadata-only inventory. It retains staging's
existing list and namespaced vectors, and never touches its legacy namespace.

The `system status --details` capability is implemented and tested locally, but
must be deployed before live quota/reservation readiness can be verified. Next
steps are approval for that staging deployment, detailed live inspection, then
separate approval for context application and the bounded paid measurement.
Neither local preparation nor successful tests activate production limits.

### Actual preparation result (2026-09-06 UTC)

The 91-seed packet is **blocked by source integrity validation**, and no copy
packet was saved. For seed `rd_45XAY3N8MM` (not one of the 65 measured targets),
both the authenticated content API and direct R2 retrieval return 1,054 bytes
with the same SHA256, while the ready manifest declares 10,608 bytes and a
different SHA256. The retrieved body is plain Markdown, not a remaining gzip
stream. Evidence is private at
`.summarizer-comparisons/193-v2-preflight/copy-source-blocker.json` and
`copy-readiness.json`. Validation stops at the first failure, so this is not a
claim that the remaining seeds pass.

Do not omit that seed, relabel its content hash, or repair production as part of
preparation. Establish a consistent source capture or explicitly revise the
context fixture before regenerating the packet. Status instrumentation can be
reviewed independently; it is not deployed.

Local validation passed: 245 test files / 3,865 tests, TypeScript checking, and
Worker dry-run bundling. The final diagnostic-only change also passed all 11
copy-planner tests and `git diff --check`. No remote copy, provider dispatch,
policy update, or deployment occurred.
