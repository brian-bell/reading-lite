# Preparing a private staging context-copy artifact

`staging prepare-context` prepares production reading fixtures for a staging
measurement. It reads production/staging state and materializes local payloads;
**it never writes remote data, calls a provider, enqueues, or deploys**.
The source bucket/database pairing is production (`reading-lite`); destination
is staging (`reading-lite-staging`). Tenants must be explicit and distinct.
The staging tenant must be active and paid work disabled.

This prepares a packet, not an automated remote copier. Applying its writes
requires separate authorization and the revalidation/ordering below.

## Prepare and inspect

Input JSON contains `ids` (1–200 unique reading IDs to seed) and `targets`
(up to 200 unique `{id, contentSha256, markdownSha256?}` measurement inputs).
Pin `markdownSha256` to reproduce a frozen cohort. Seed/target overlap becomes
`reprocess` under the same ID; other targets become `import`, preserving their
canonical URLs. New import IDs are recorded at execution, not invented here.

```sh
# Direct PostgreSQL connections; never print these values or pass them as flags.
source ~/.config/reading-lite/neon.env
# Uses NEON_MAIN_DATABASE_URL / NEON_REHEARSAL_DATABASE_URL, or the paired
# PRODUCTION_DATABASE_URL / STAGING_DATABASE_URL variables.

# Plan only: read and print counts/preconditions, without writing files.
npm run ops -- staging prepare-context \
  --source-tenant usr_SOURCE --tenant usr_STAGING \
  --input /private/path/selection.json --corpus-vars /private/path/.corpus.vars

# Local materialization only; output directory must not exist.
npm run ops -- staging prepare-context \
  --source-tenant usr_SOURCE --tenant usr_STAGING \
  --input /private/path/selection.json --corpus-vars /private/path/.corpus.vars \
  --output-dir /private/path/context-packet --execute
```

The existing operator bucket/connection-variable pairing selects the databases.
Both sessions close on success or failure, including local-save errors. Source
and destination each supply a read-only repeatable snapshot, released before
R2 reads. The snapshots are independent observations, not a cross-database lock.

Wrangler supplies Cloudflare read authorization. Matching-account S3 inventory
credentials from the selected `.corpus.vars` (or environment) provide complete
destination prefix checks. Read transports reject remote mutation methods.
The packet contains no database connection strings or authorization material.

## Source and destination checks

The planner uses `PgReadingStore` for the same reading projection, URL owner
and current content keys as the runtime. It refuses non-ready readings, a
mismatched URL owner, fresh active attempts, invalid hashes/sizes, unsafe keys,
and missing or malformed seed embeddings (1536 finite dimensions). Historical
expired ready attempts use the existing `applyStaleness/900s` projection;
active/last attempt references and old checkpoints are omitted from the packet.
Source row fingerprints identify the original observation before that projection.

Content keys resolve from the current revision, then the latest capturing
attempt, then the legacy spelling under the stored prefix. Imported prefixes
are preserved, not reconstructed from creation time. Every key must be a safe
relative key under that reading's prefix. Historical revisions and attempts are
not copied. `contentKeysFor`, the deletion helper that enumerates all historical
content, is deliberately not used here.

Seed embeddings come from `reading_embeddings`. Their values are preserved;
the hosted similarity query gets title/TLDR/URL from `readings`, so there is no
separate Vectorize metadata to copy or reconcile. Destination seed and target
IDs, URLs, ownership slots and content prefixes must all be unoccupied. Existing
unrelated staging rows remain untouched.

## Version-2 packet contents

- `plan.json`: fixed source/destination identities; `readingIds`; destination
  `rows` in the shared `ReadingRows` mapping (reading, ownership flag, selected
  revision, ordered relationships and embedding); rooted content `objects`;
  `sourceRowChecks`; source content hashes; destination absence checks; target
  import/reprocess mapping; and the application order.
- `blobs/<sha256>`: binary-faithful raw captures, extracted content and target
  Markdown. Identical bytes share a blob.
- `SHA256SUMS`: plan and every blob checksum. Verify all before application.

The format is `reading-lite-staging-context-v2`. It replaces v1's vectors,
metadataDrift, list CAS payload and R2 manifest/pointer objects. A v1 application
procedure cannot consume it. Old packets and the dated evidence below remain
historical; do not reinterpret or reapply them as v2.

`sourceRowChecks` binds each selected ID to `contextFingerprint` of its parsed
`SourceContext`: the original manifest projection, stored prefix, URL owner,
revision ID, resolved content keys and seed embedding. JSON object keys are
sorted recursively before hashing; arrays retain their order. `includesEmbedding`
is false for import-only targets, whose embedding is not used. Recompute with
`readContextRows` and `contextFingerprint` using the same seed/target selection.
`sourceChecks` hashes original R2 bytes, including target-only Markdown/raw
checks; every copied content object has its original source key and hash.

**This packet contains private article content, URLs, summaries and embeddings.**
Keep it outside git. New packet folders are mode 0700 and files 0600. Existing
output folders are refused. An interrupted local save is incomplete unless
`plan.json`, all referenced blobs and the full checksum file validate; use a new
output directory on retry.

## Application contract after separate approval

1. Verify checksums, exact tenants/environments, current active staging tenant,
   disabled paid-work policy, queue/lease state, and an exclusive staging writer
   window. Re-read all source row/embedding fingerprints, content hashes and
   destination absence preconditions, including import-only targets. Abort on
   drift. The preparation snapshot does not reserve rows or lock either system.
2. Create the planned destination content with conditional absent-only writes.
   Preserve bytes and content types. Do not overwrite existing objects.
3. In one PostgreSQL transaction, recheck and lock the active tenant and disabled
   policy; recheck destination ID/URL absence; insert the reading, URL ownership,
   selected revision, ordered relationships and embedding rows. Keep the deferred
   current-revision FK intact. Preserve relationship presence flags and dangling
   targets as the runtime does. Use insert primitives, not `writeReadingRows`'s
   whole-reading replacement: application must never delete an existing row.
4. Verify fixture content, runtime reading projections, URL ownership and exact
   similarity. Only then start any separately approved paid run. On partial
   failure, retain evidence and report the exact created state; there is no
   automatic cleanup, rollback across R2/PostgreSQL, or resumable apply engine.

The artifact does not contain executable SQL or an automatic apply command.
There are no vector-ledger, Vectorize upsert, pointer or list-index steps.

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
