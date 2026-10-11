# Local fixture pack state reference

The local fixture pack ([issue #366](https://github.com/brian-bell/reading-lite/issues/366))
turns the prototype's authored samples into real manifests, attempt logs, and
captured content, seeded into local PostgreSQL (rows) and R2 (content) by one
command (see [seeding local data](../../operations.md#seeding-local-data)):

```sh
npm run seed:local
```

Phase 3 and Phase 4 slices cite these fixture **names** when a state is
needed for a test, screenshot, or browser-evidence run. `app/`'s browser
evidence ([#374](https://github.com/brian-bell/reading-lite/issues/374)) serves
the pack without R2: `npm run fixtures:app` projects it into
`app/e2e/fixtures/fixture-pack.json` — the same bodies
`GET /api/readings/:id` returns, at a fixed clock, plus the extracted Markdown
(`contents`), the `GET …/diagnostics` bodies assembled the way the router
assembles them from rows (`diagnostics`), and each ready fixture's
raw capture with its stored content type (`raws`), and the staged inbox
items (`inbox`) — and
`test/unit/operator-guards.test.ts` fails while that file is stale, so
a new state is one edit here plus a regenerate. The same command writes
`app/src/samples/sample-library.json`, the public sample library the frontend
bundles (reading-lite-gh341.10): `attention`, `friction`, `gardens`,
`reprocess-failed`, `imported-markdown`, and `sparse-archive`, addressed by
their URL's last path segment, with relationships kept only between them.

The names and ids are stable: they live in `test/fixtures/local-seed.ts`, and
`npm run seed:local` writes them into PostgreSQL.

The pack contains authored fiction from the
[Connected prototype](design-spec.md#data-mapping) and the
[next-direction prototype](../next-direction/README.md#frozen-source)
(reading-lite-kl7y.2): `.example` hosts, a
reserved-style YouTube video id, and invented bylines. No production corpus
content, no credentials, and no paid processing run produces or consumes it.
Local `wrangler dev` has no Queue, so seeding is the only way to see these
states locally.

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
| `reprocess-failed` | `rd_FXREPROC01` | ready | Ready reading whose `last_attempt` is a **failed reprocess** (`BadStatusError` at `fetch_source`, trigger `reprocess`): the summary stays, the manifest carries no `error`, and the library card shows the "Reprocess failed" badge. Two attempt logs: the succeeded submit and the failed reprocess |
| `imported-markdown` | `rd_FXMDPAGE01` | ready | `source_type: "markdown"` with a `text/markdown` raw capture; metadata line says "Imported Markdown". Its body carries the rich content the Source view handles: a table, a fenced code block, an image, raw HTML, and an unbreakable link |
| `commonplace` | `rd_FXCMMNBK01` | ready | Connects to `marginalia`, saved more than 60 days earlier (Worth revisiting); `qualified_by` tension with `second-brain` |
| `second-brain` | `rd_FXSECBRN01` | ready | No connections; the `qualifies` side of the tension with `commonplace` |
| `marginalia` | `rd_FXMARGNA01` | ready | Saved in March, months before the rest; `similarity.count = 0`, and its connection to `commonplace` came from the nightly refresh |
| `paper-again` | `rd_FXPAPER001` | ready | Joins the `attention` thread through `imported-markdown`, saved days later, by the nightly refresh |
| `conversation` | `rd_FXCNVRSE01` | ready | Saved after the last refresh (no `connections_computed_at`); joins the `attention` thread through its ingest-time connection to `gardens` |
| `pending` | `rd_FXPENDNG01` | pending | Fresh submit with a running attempt (`stage: "queued"`). Stamped from the seed clock; re-seed once it passes the 15-minute pending TTL |
| `processing` | `rd_FXPRCSSNG1` | pending | Saved 8 minutes before the seed clock; its attempt log has reached `summarize` (diagnostics show the progress) while the reading's `active_attempt` still says `queued` |
| `stale-pending` | `rd_FXSTPEND01` | pending (read as failed) | The same submit, 40 minutes before the seed clock. Its running attempt is past the TTL, so every read shows it failed with `stale_active_attempt` at stage `queued`, without a write (the desk's Stalled row) |
| `fail-source-unreachable` | `rd_FXERR00001` | failed | `BadStatusError` at `fetch_source` — source unreachable category |
| `fail-source-incomplete` | `rd_FXERR00002` | failed | `SourceRejectedError` at `summarize` — source incomplete category; also `gardens`' failed connection target |
| `fail-provider-limit` | `rd_FXERR00003` | failed | `RateLimitedError` at `summarize` — provider limit category |
| `fail-provider-error` | `rd_FXERR00004` | failed | `OpenAIError` (`http_status` 500) at `embed_source` — provider error category |
| `fail-key-invalid` | `rd_FXERR00005` | failed | `provider_key_invalid` (`http_status` 401) at `summarize` — key invalid category |
| `fail-hosting-limit` | `rd_FXERR00006` | failed | `SpendAdmissionError` at `summarize` — hosting limit category |
| `fail-stopped` | `rd_FXERR00007` | failed | `QueueRetriesExhaustedError` — stopped category; dead-letter attempt log holds only the queued `started` event |
| `fail-unknown` | `rd_FXERR00008` | failed | `TypeError` at `query_similar` — unknown category fallback |
| `fail-key-missing` | `rd_FXERR00009` | failed | `provider_key_required` at `embed_source` — key missing category |
| `fail-billing` | `rd_FXERR00010` | failed | `provider_insufficient_quota` (`http_status` 429) at `summarize` — billing category |

The removed relationship target is `rd_FXVANSHD01`: referenced by
`attention`'s connections but never written anywhere, so any target-enrichment
lookup misses it and the frontend renders the removed card. Follow it directly
and the detail route 404s ("arrived from a removed target").

## Threads and the inbox

Following the [threads rule](../next-direction/design-spec.md#threads), the
ready readings form two threads and four readings standing alone:

- **Eight readings** around `attention`: `friction` (the `contradicts` pair),
  `gardens`, `reprocess-failed`, `unavailable-source`, `imported-markdown`,
  `paper-again`, and `conversation`. `gardens`' pending and failed targets do
  not join it.
- **Three readings**: `marginalia`, `commonplace`, and `second-brain`, with one
  `qualifies` pair. `commonplace` → `marginalia` is the pack's only connection
  to a target saved more than 60 days earlier.
- **Standing alone**: `sparse-archive`, `long-title`, `degraded-youtube`, and
  `old-manifest`.

No component exceeds 12 readings; the split rule is covered by kl7y.3's unit
tests, not by a fixture.

The inbox holds six staged items, newest first: one more than the desk shows
before "Show all". `in_rd_FXNBX00002` has no title, and `in_rd_FXNBX00003` was
re-staged, so its `updated_at` is later than its `created_at`. None shares a
URL with a reading. `seed:local` replaces the founder's inbox rows with them.

The desk holds `attention` then `commonplace`, two of its three slots, so the
desk has a next reading and room for one more. `seed:local` writes them as
`reading_desk` rows. The app snapshot's `desk` is the `GET /api/desk` body for a
first visit, `since` seven days before its clock, so `reprocess-failed` is
both in Needs you and in Ready since.

## Shape guarantees

- Every manifest is built through `src/modules/manifest-drafting.ts` and
  parses with `ManifestSchema`; the test enforces it, plus list-row/manifest
  equality, one URL per fixture (so each owns its URL), `url_hash`
  correctness, and that R2 gets only captured content.
- Every terminal timestamp is derived from the fixture's own generated
  attempt: ready `updated_at`/`fetched_at` equal `last_attempt.finished_at`,
  `similarity.computed_at` is the `query_similar` completion, and failed
  `updated_at`/`error.failed_at` equal the failure event — so the manifest,
  the attempt summary, and the event log share one chronology.
- Content hashes and byte counts in the manifests match the seeded artifacts,
  so diagnostics stay coherent.
- Failed readings carry the empty-content placeholder with
  `content_status: "failed"`, exactly as the worker failure path writes them.
- Each reading has an attempt log (attempt rows) with realistic stage
  events, including the dead-letter shape for `fail-stopped`.
  `reprocess-failed` has two: its manifest is the ready one rolled forward
  (`rollForward` in `src/modules/manifest-drafting.ts`), so `updated_at` is the
  reprocess failure while `fetched_at` and `similarity.computed_at` stay the
  succeeded attempt's.
- Seeded ids satisfy the worker's `parseReadingId` shape, so reprocess,
  lookup, and MCP paths treat fixtures like any other reading.
- The seeder replaces the local founder's reading rows with the pack's. Any
  other local reading drops out, though its R2 objects stay; see
  [resetting](../../operations.md#seeding-local-data) for a pristine store.
- The library lists the pack's 28 rows newest first, matching the store's
  `created_at` sort: a first page of 20 ending with `long-title` (the library
  case checks it wraps there) and eight on the second, ending with
  `old-manifest` and `marginalia`. The snapshot's `list_index` carries
  read-time staleness and each row's `connection_count` and `tension_count`,
  as the list route serves it.
- The snapshot's `relationships` is the `GET /api/readings/relationships`
  body: the rows whose target is in the pack, projected through the same
  `manifestToRows` the seeder writes, and the ready readings plus each row's
  ends. The browser suite serves it for `/threads` and the reading page.

## What the pack deliberately does not cover

Ready readings carry deterministic vectors, so similarity finds the other
ready fixtures, but the scores mean nothing about the prose. Submit, import,
and reprocess still return 503 locally (no Queue); use the seeded states
instead. Reprocess-pending (a ready reading under a running reprocess) and
batch-owned pending are Phase 4 states; add them here as named fixtures when
those slices need them (the failed variant, `reprocess-failed`, is in the
pack).

A pending reading reads as `stale_pending` only when it has no active attempt,
which intake never writes; a stalled submit reads as `stale_active_attempt`,
as `stale-pending` does, and the frontend gives both the same category. The
worker records each stage in the attempt log, never on the reading, so a
reading mid-run still says `queued`; only `processing`'s diagnostics show its
progress. The browser suite does not serve `GET /api/inbox` yet; the snapshot
carries the items for the slice that does (reading-lite-kl7y.8).
