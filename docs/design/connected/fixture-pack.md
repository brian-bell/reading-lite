# Local fixture pack state reference

The local fixture pack ([issue #366](https://github.com/brian-bell/reading-lite/issues/366))
turns the prototype's authored samples into real manifests, list rows,
pointers, content objects, and attempt logs, seeded into local R2 by one
command (see [seeding local R2](../../operations.md#seeding-local-r2)):

```sh
npm run seed:local
```

Phase 3 and Phase 4 slices cite these fixture **names** when a state is
needed for a test, screenshot, or browser-evidence run
([#374](https://github.com/brian-bell/reading-lite/issues/374) serves `app/`
against this pack). The names and ids are stable: they live in
`test/fixtures/local-seed.ts`, and `test/unit/fixtures/local-seed.test.ts`
pins every state below.

The pack contains authored fiction from the
[Connected prototype](design-spec.md#data-mapping): `.example` hosts, a
reserved-style YouTube video id, and invented bylines. No production corpus
content, no credentials, and no paid processing run produces or consumes it.
Local `wrangler dev` has no Queue or Vectorize, so seeding is the only way to
see these states locally.

## Reading states

| Name | Id | Status | Signal (acceptance-matrix row) |
| --- | --- | --- | --- |
| `attention` | `rd_FXATTENT01` | ready | Full baseline: summary, novelty verdict, similarity, refreshed connections (`connections_computed_at` present), a `contradicts` tension with `friction`, and a connection to the removed target |
| `gardens` | `rd_FXGARDEN01` | ready | Ready baseline whose connections target one **pending** reading and one **failed** reading (non-ready relationship targets) |
| `friction` | `rd_FXFRICTN01` | ready | The other side of the tension pair with `attention` |
| `sparse-archive` | `rd_FXSPARSE01` | ready | Sparse archive: `similarity.count = 0`, no connections; novelty reads as "nothing close existed when processed" |
| `unavailable-source` | `rd_FXRAWSRC01` | ready | `content_status: "raw_only"`: no `extracted.md`, `/content` 404s, raw capture serves; summary, novelty, and relationships stay usable |
| `degraded-youtube` | `rd_FXYTDEGRD1` | ready | `enrichment_degradation` present (`youtube`, tier `transcript`): ready on the oEmbed floor with description but no transcript |
| `old-manifest` | `rd_FXPAST0001` | ready | No `similarity`, `novelty_verdict`, or `connections_computed_at`; legacy usage shape. Omit the missing lines; never show "unclassified" |
| `long-title` | `rd_FXMAXNAME1` | ready | 130-character title, past the summarizer's 120-char output cap (the manifest field has none); must wrap, never truncate |
| `imported-markdown` | `rd_FXMDPAGE01` | ready | `source_type: "markdown"` with a `text/markdown` raw capture; metadata line says "Imported Markdown" |
| `pending` | `rd_FXPENDNG01` | pending | Fresh submit with a running attempt (`stage: "queued"`). Stamped from the seed clock; re-seed once it passes the 15-minute pending TTL |
| `fail-source-unreachable` | `rd_FXERR00001` | failed | `BadStatusError` at `fetch_source` — source unreachable category |
| `fail-source-incomplete` | `rd_FXERR00002` | failed | `SourceRejectedError` at `summarize` — source incomplete category; also `gardens`' failed connection target |
| `fail-provider-limit` | `rd_FXERR00003` | failed | `RateLimitedError` at `summarize` — provider limit category |
| `fail-provider-error` | `rd_FXERR00004` | failed | `BadStatusError` at `embed_source` — provider error category |
| `fail-key-problem` | `rd_FXERR00005` | failed | Provider 401 at `summarize` — key problem category (provisional until Phase 6) |
| `fail-hosting-limit` | `rd_FXERR00006` | failed | `SpendAdmissionError` at `summarize` — hosting limit category |
| `fail-stopped` | `rd_FXERR00007` | failed | `QueueRetriesExhaustedError` — stopped category; dead-letter attempt log holds only the queued `started` event |
| `fail-unknown` | `rd_FXERR00008` | failed | `TypeError` at `query_similar` — unknown category fallback |

The removed relationship target is `rd_FXVANSHD01`: referenced by
`attention`'s connections but never written anywhere, so any target-enrichment
lookup misses it and the frontend renders the removed card. Follow it directly
and the detail route 404s ("arrived from a removed target").

## Shape guarantees

- Every manifest is built through `src/modules/manifest-drafting.ts` and
  parses with `ManifestSchema`; the test enforces it, plus list-row/manifest
  equality, by-id/by-url pointer agreement, and `url_hash` correctness.
- Content hashes and byte counts in the manifests match the seeded artifacts,
  so diagnostics stay coherent.
- Failed readings carry the empty-content placeholder with
  `content_status: "failed"`, exactly as the worker failure path writes them.
- Each reading has an attempt log under `attempts/` with realistic stage
  events, including the dead-letter shape for `fail-stopped`.
- Seeded ids satisfy the worker's `parseReadingId` shape, so reprocess,
  lookup, and MCP paths treat fixtures like any other reading.
- The library lists 18 rows, newest first: `pending`, the eight failures,
  then the ready baselines — matching the store's `created_at` sort.

## What the pack deliberately does not cover

Ready readings have no Vectorize vectors (local dev has no binding), so
`POST /api/readings/similar` returns empty and by-id similarity is
manifest-only. Submit, import, and reprocess still return 503 locally (no
Queue); use the seeded states instead. Reprocess-pending (a ready reading
under a running reprocess) and batch-owned pending are Phase 4 states; add
them here as named fixtures when those slices need them.
