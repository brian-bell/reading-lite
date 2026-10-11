# Next direction design specification

Status: specified October 3, 2026 (reading-lite-kl7y.1). Brian reviewed the
three prototype directions on October 1, 2026 and chose to combine them into
one app: the desk as home, tensions inside Threads, and Find inside the
Catalog. The [prototype](README.md#frozen-source) is the visual and
interaction reference. This document is the contract the slices implement.
Where it is silent, [Connected](../connected/design-spec.md) applies.

## Decisions

Recorded October 3, 2026. Brian chose the first four; the rest follow from
the code as it stands and are open to his review.

1. **Digest preview scope: preview only what the mail sends.** `/digest` shows
   the readings the next digest would carry, chosen by the same rule as the
   mail. The prototype's "Where they disagree" section and inbox count are not
   built. Adding them is a separate change to the mail and the preview together.
2. **Relationship counts on library cards come from the list items.** Each
   list row carries `connection_count` and `tension_count`, counted from that
   reading's own relationship rows, so the card agrees with the reading page.
   Library cards do not show a thread name. Threads appear on `/threads` and
   on the reading page.
3. **Large threads split by tag above 12 readings.** See
   [threads](#threads).
4. **The prototype is deleted at the release gate.** Commit `0507dc84` stays
   the frozen reference (see [README](README.md#frozen-source)).
5. **The desk lives in a reading-plane side table, not a readings column and
   not the control plane.** `reading_desk` has a foreign key to `readings`
   with `ON DELETE CASCADE`. A wipe or a purge therefore frees the slot with
   no new deletion code. `countTenantDataRows` and the teardown checks are
   unchanged. The reading's detail and list reads join the table, so the
   archive export carries the position. A readings column would cascade and
   export as well, but every toggle would update the reading row. That changes
   its `xmin`, which `startAttempt` compares as the row's version, so a toggle
   would make a concurrent reprocess see "changed". A control-plane table would
   need its own wipe, teardown count, and export handling.
6. **Three on the desk is a product rule.** The backend refuses a fourth with
   409. The prototype's three is kept.
7. **"Ready since" is a product rule with a defined visit.** See
   [the visit](#the-visit).
8. **The inbox shows its five newest items on the desk, then a "Show all"
   row.** `/inbox` stays as a page with no navigation item. `/inbox/$id` stays
   as the deep-linkable preview. The tenant cap stays at 200 staged items
   (`INBOX_ITEM_CAP`).
9. **The navigation keeps five items:** Desk, Library, Threads, Catalog, Save
   reading. Inbox leaves the navigation. The account menu and theme control
   are unchanged. At container width ≤650 px the compact bar carries the same
   five items.

## What the backend has today

These facts set the contracts below. Paths are from `main` at `0507dc84`.

- `reading_relationships` (`db/migrations/0001_reading_schema.sql`) has
  primary key `(tenant_id, source_id, kind, target_id)`. The foreign key
  covers the source only, so a target can dangle. There is no index on
  `target_id`.
- Connections are one-directional. Each reading stores up to
  `SIMILAR_TOP_K` (5) of its own judged connections, and nothing writes the
  inverse. Tensions are stored on both sides with inverse kinds and the same
  reason.
- `GET /api/readings/:id` returns only the reading's own relationships, plus
  `relationship_targets` `{url, status, title?}`.
- `readings` has `tags`, `keywords`, `people`, and `orgs` as nullable
  `text[]`, with no GIN index. `GET /api/readings` searches `q` over title,
  tl;dr, URL, and keywords, and matches `tag` exactly, case-insensitively.
  List items carry `keywords` but not `people` or `orgs`.
- `PgSimilarityStore.query(embedding, topK)` and `queryByVectorId(id, topK)`
  run an exact cosine scan over the tenant's ready readings, clamping `topK`
  to `MAX_SIMILARITY_TOP_K` (100). `SIMILARITY_FLOOR` is 0.55.
  `POST /api/readings/similar` takes a caller-supplied 1536-dimension
  embedding and applies neither the floor nor self-exclusion.
- The digest selects ready readings with a title and tl;dr whose
  `updated_at ?? created_at` falls in `(start, end]` of the last one or seven
  local days (`selectDigestReadings`, `digestWindow`). A reprocessed reading
  can therefore appear again. The mail is a heading, then title, tl;dr, and
  URL per reading. An empty window sends nothing.
- `GET /api/inbox` returns every staged item, newest first, without paging.
- The latest migration is `0010`.

## Data contracts

Each new endpoint is tenant-scoped through `TenantContext`. Each validates
its query or body with zod in `src/schemas/api.ts`, and each is documented
in `docs/openapi.yaml`. Rows read from PostgreSQL are parsed into these
shapes. None of them makes a paid call except [meaning search](#meaning-search).
Each new path under `/api/readings/` is a fixed segment, registered before
`/api/readings/:id`, as `/api/readings/lookup` already is.

### Relationships list (reading-lite-kl7y.3)

`GET /api/readings/relationships`, scope `readings:read`. It is one
side-effect-free read.

```json
{
  "readings": [
    { "id": "rd_a", "title": "…", "url": "https://…", "status": "ready",
      "tags": ["attention"], "created_at": "2026-09-01T…Z" }
  ],
  "relationships": [
    { "source_id": "rd_a", "target_id": "rd_b", "kind": "connection", "reason": "…" },
    { "source_id": "rd_a", "target_id": "rd_c", "kind": "tension",
      "tension_kind": "contradicts", "reason": "…" }
  ]
}
```

- `relationships` holds every row in the tenant's `reading_relationships`
  whose source and target are both live readings. Rows with a dangling
  target are left out. Order is `source_id, kind, position`.
- `readings` holds every ready reading in the tenant, including those with
  no relationships, plus any reading of another status that appears on
  either end of a listed relationship. Staleness is applied. The frontend
  builds threads from the ready ones and lists the ready readings in no
  thread as standing alone, so a library with no relationships still shows
  every ready reading on `/threads`.
- Size: one entry per ready reading, and about five connection rows per
  reading, plus tensions. kl7y.3 measures the response over the extended
  fixture pack and records the bytes per reading. If a library of 2,000
  readings would pass 1 MB, the slice proposes per-thread reads before
  shipping.
- Measured (kl7y.3): over the fixture pack the response is 6,605 bytes for
  17 readings and 15 rows, 389 bytes per reading (1,936 gzipped). A
  reading entry averages 202 bytes and a row 210, most of it the reason. At
  the pack's density 2,000 readings is about 0.78 MB, but at the five rows
  per reading assumed above it is about 1,250 bytes per reading, 2.5 MB
  uncompressed and about 0.7 MB gzipped, so a full library passes 1 MB.
  The proposal: keep this read for `/threads`, but drop `reason` from it
  (the list shows no reasons) and add `GET /api/threads/:id` returning one
  thread's readings and rows with reasons for `/threads/$id` and the reading
  page's strip. Without reasons a row is about 90 bytes, so 2,000 readings
  is about 1.3 MB at five rows each; the list read would also need its rows
  reduced to pairs (one per unordered pair), which halves it. Tracked in
  reading-lite-kl7y.12; this slice ships the single read.
- Server render: `/threads` and `/threads/$id` read it through a new
  `FrontendReads.relationships` method and `backend-reads.ts`. The reading
  page fetches it in the browser after hydration, as the Source view does, so
  the reading's server render stays bounded.

`GET /api/readings/:id` adds `created_at` to each `relationship_targets`
entry, so the reading page can compute [Worth revisiting](#worth-revisiting)
without the tenant-wide read. MCP `get_reading` still strips
`relationship_targets`.

### Counts on list items (reading-lite-kl7y.3)

`ListIndexItem` gains `connection_count` and `tension_count`, non-negative
integers, present on every row. `listManifests` computes them per row from
`reading_relationships` with the source key, counting only live targets. They
are response-only: they are not in `ManifestSchema`, not stored, and not in the
archive's `index.json` (which parses the manifest into the list shape, so the
optional fields are absent there). The library card shows "2 connections · 1
tension", and nothing when both are zero.

### Terms index and facets (reading-lite-kl7y.4)

`GET /api/readings/terms`, scope `readings:read`:

```json
{
  "people":   [{ "term": "Mara Ellis", "count": 3 }],
  "orgs":     [{ "term": "…", "count": 1 }],
  "keywords": [{ "term": "…", "count": 2 }],
  "hosts":    [{ "term": "example.com", "count": 4 }]
}
```

- Counts are over the tenant's ready readings. A reading counts once per
  term.
- Terms are grouped case-insensitively. The displayed spelling is the most
  frequent one, with ties broken by code-point order.
- A host is the URL's hostname, lowercased, with one leading `www.` removed.
  It is computed in SQL at read time. kl7y.4 adds a generated column only if
  measurement shows the read needs one. Any new migration is additive.
- Each list is sorted by term, case-insensitively. There is no paging. kl7y.4
  records the payload size for the fixture pack.
- Server render: `/catalog` reads it through `FrontendReads.terms`.

`GET /api/readings` accepts at most one of `person`, `org`, `keyword`, or
`host`. Two or more is a 400. A facet matches an array element, or the
derived host, case-insensitively and exactly. It combines with `q`, `tag`,
`offset`, and `limit`. `FrontendReads.list` passes the facet through. The
detail manifest already has `people` and `orgs`. The reading page shows them
as a mentions row under the tags, each linking to its catalog facet.

### Meaning search (reading-lite-kl7y.5)

`POST /api/readings/search`, scope `readings:write`, because it spends. The
body is `{ "query": string }`, trimmed, 1–500 characters.

- The `needs_provider_key` gate and the provider-failure classification are
  the same as intake. A reader with no key gets 409 `provider_key_required`.
  A rejected key, missing model access, or insufficient quota maps to the
  existing provider error codes.
- It resolves the tenant key (`resolveTenantOpenAIKey`). It embeds the query
  once, through `createPaidFetch`, with lease checks and spend admission
  inside the retry loop. Then it runs `pgSimilarityStore.query(embedding,
  10)`, keeps scores at or above the floor, and returns
  `{ items: SimilarItem[] }`, where each item has `id`, `url`, `title?`,
  `tldr?`, `tags?`, `created_at?`, and `score`.
- No transaction spans the provider call. It is billed to the reader's key
  under the daily spend cap. It does not count against the hourly or monthly
  reading quota. kl7y.5 decides whether the request-rate guard applies, and
  records the choice in `docs/paid-provider-spend.md`.
- The floor: `SIMILARITY_FLOOR` (0.55) was set for reading-to-reading
  scores. Question-to-reading scores run lower. kl7y.5 measures questions
  over the fixture pack. If useful matches fall below 0.55, it adds a
  `MEANING_SEARCH_FLOOR` with that evidence in its header comment.
- The UI shows a closeness band from the score: Close, Near, or Faint. The
  band edges are frontend constants that kl7y.5 sets from the same
  measurement and pins with a test. The prototype's matched-terms "why" has no
  production equivalent and is not shown. The numeric score is not shown
  either.
- The question is not put in the URL. A reload or Back must not spend again.
  It stays in page state, and the result is cached in TanStack Query for the
  page session.

### More like this (reading-lite-kl7y.5)

`GET /api/readings/:id/similar`, scope `readings:read`. It makes no paid
call, because it uses the stored embedding.

- It excludes the reading itself and its own connection and tension targets
  inside the SQL query, before `LIMIT`, so no number of related readings can
  push eligible neighbors past the store's `MAX_SIMILARITY_TOP_K` ceiling.
  kl7y.5 adds an exclusion list to `queryByVectorId` (`r.id <> ALL($n)`)
  rather than over-fetching and filtering afterwards. It asks for 5, keeps
  scores at or above `SIMILARITY_FLOOR`, and returns them as
  `{ items: SimilarItem[] }`.
- A missing reading returns 404. A reading with no embedding (not ready)
  returns `{ items: [] }`.
- The reading page fetches it in the browser after hydration and shows it as
  "More like this" after Worth revisiting. It is hidden when empty.

### Desk (reading-lite-kl7y.6, kl7y.7)

Migration `0012` adds (`0011` took Anthropic provider credentials):

```sql
CREATE TABLE reading_desk (
  tenant_id  text NOT NULL,
  reading_id text NOT NULL,
  position   smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  added_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, reading_id),
  UNIQUE (tenant_id, position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings ON DELETE CASCADE
);
```

Writes have scope `readings:write`. Each runs in one `sql.transaction`. It
first takes a transaction-scoped advisory lock on `desk:{tenant_id}`
(`pg_advisory_xact_lock`, as the control plane's `lockKey` does), because the
row being added may not exist yet. Then it locks the reading row `FOR SHARE`. Last, it renumbers
the tenant's rows 1..n in position order, so a purge's gap closes on the next
write.

| Endpoint | Effect | Refusals |
| --- | --- | --- |
| `POST /api/desk` `{ "id": "rd_…" }` | Appends the reading. Adding a reading already on the desk returns 200 unchanged | 404 unknown reading; 409 `not_ready` unless the stored status is `ready`; 409 `desk_full` `{ "limit": 3 }` |
| `DELETE /api/desk/:id` | Removes the reading. A reading not on the desk is a no-op | 404 unknown reading |
| `DELETE /api/desk` | Clears the desk | — |

Each write returns `{ "desk": ["rd_…", …] }` in position order. The write
never touches the `readings` row, its `updated_at`, or the digest. A reading
on the desk stays there through a reprocess, including a failed one. A
reading that becomes pending or failed shows on the desk with its status
badge. Reordering is not in this epic.

`ListIndexItem` and the `GET /api/readings/:id` response gain an optional
`desk_position` (1–3), present only when the reading is on the desk. It is
read-only state. `manifest-rows` never writes it, and publication never
touches `reading_desk`. Each has a test. `loadReadingById` returns it as
`deskPosition` beside the manifest, not inside it: the relationship and
tension judges, the operator corpus and the batch compare hash the loaded
manifest as its version, and a toggle must not change that. The archive's `manifest.json` and
`index.json` carry it. `docs/archive-export.md` documents it as an additive
field, without a version bump. MCP output carries it unchanged. There are no
MCP desk tools.

`GET /api/desk?since=<ISO>`, scope `readings:read`, is the desk's one read.
Staleness is applied before grouping:

| Group | Rows | Order and bound |
| --- | --- | --- |
| `on_desk` | Readings in `reading_desk`, any status | Position; at most 3 |
| `needs_you` | `failed`, or ready with `last_attempt` a failed reprocess | Newest first; 20 rows, plus `needs_you_total` |
| `processing` | `pending` after staleness | Newest first; 20 rows, plus `processing_total` |
| `ready_since` | `ready`, `created_at > since`, not on the desk | Newest first; 10 rows, plus `ready_since_total` |

Rows are `ListIndexItem`s. A missing `since` returns an empty `ready_since`.
The server render reads it through `FrontendReads.desk`. The inbox, the
provider tile, and the digest tile load in the browser from their own
existing or new reads.

### The visit

"Ready since" needs the previous visit. It is kept in a first-party cookie,
`rl_visit`, with no identity, like the theme preference, so the server render
can read it. The value is `{previous, latest}`, in epoch milliseconds. When
the desk renders at time `t`:

- If there is no cookie, `since = t − 7 days`.
- If `t − latest > 2 hours`, a new visit begins: `previous := latest`.
- `latest := t`. The browser writes the cookie after hydration.
- `since = max(previous, t − 14 days)`.

So "Ready since" stays stable while the reader moves around during one
visit. It never reaches back more than 14 days. The section heading names
the date of `since`.

### Digest preview (reading-lite-kl7y.10)

`GET /api/digest/preview`, scope `readings:read`. It reads the tenant's
settings and runs `selectDigestReadings` over the window that the next send
will cover, from its exclusive start to now.

```json
{
  "cadence": "weekly",
  "time_zone": "Europe/London",
  "next_send_at": "2026-10-05T07:00:00Z",
  "window": { "start": "2026-09-28T07:00:00Z", "end": "2026-10-03T10:00:00Z" },
  "subject": "Weekly digest · 4 readings",
  "items": [{ "id": "rd_…", "title": "…", "tldr": "…", "url": "https://…" }]
}
```

- `next_send_at` comes from the same schedule rule as `digestDueAt`: the
  next local hour equal to `digest_hour_local`, and for weekly, on
  `digest_weekday`. A shared helper computes it, and both callers test
  against it.
- `cadence: "off"` returns `next_send_at: null` and no items. The page says
  digests are off and links to the account settings.
- An empty window says nothing has arrived yet, and that no mail is sent for
  an empty period. The page explains that readings reprocessed in the window
  appear again, because selection uses `updated_at`.
- `/digest` renders the items in the app's design. The desk tile shows the
  count and `next_send_at` in the reader's time zone.

## Derivations in the frontend

These derivations are ported from the prototype's `study.ts` into
`app/src/`, with tests. Each derivation has one test owner.

### Threads

From the relationships list (`app/src/threads.ts`):

1. Build an undirected graph over ready readings, with an edge for every
   connection and every tension. Direction is ignored, so a one-sided
   connection still joins its two readings.
2. Take connected components. A component of one reading is not a thread.
   That reading stands alone.
3. A component of 12 or fewer readings is one thread. A larger component is
   split. Each reading joins the group of its own tag that is most common in
   the component, with ties broken alphabetically. A reading with no tags
   joins the largest group. A group with only one reading also merges into
   the largest group. Groups are not split again.
4. A thread's readings are ordered oldest first by `created_at`, then by id.
   The thread is named by the tag most of its readings share, capitalized,
   with ties broken alphabetically. A thread with no tags is named by its
   oldest reading's title.
5. A thread's id is its oldest reading's id. `/threads/$id` shows the thread
   that contains reading `$id`, so a link stays valid when a split or a new
   reading changes which reading is oldest. It returns 404 when that reading
   is in no thread.
6. `/threads` lists threads by their newest reading, most recent first, as
   the prototype does. Each shows its tension count, which counts the pairs
   with both ends in the thread.

### Tension pairs

Both sides' rows collapse to one pair per unordered `{a, b}`. Each pair is
read in the active voice: a `superseded_by` or `qualified_by` row is flipped
to `supersedes` or `qualifies`. The Threads page lists the library's pairs
newest first by the later reading.

### Worth revisiting

On the reading page, a connection whose target was saved more than 60 days
before this reading is listed again under "Worth revisiting", with its
reason. It uses `relationship_targets[].created_at`. 60 days is a product
rule.

### Desk views

`failureOf` and `reprocessFailed` carry the prototype's rules, keyed on the
same backend codes as `app/src/reading-failure.ts`. The desk's server read
already groups the rows, so there is no `deskOf` port.

## Routes and navigation

| Path | Screen | Notes |
| --- | --- | --- |
| `/` | Signed in: Desk. Signed out: landing | The landing links sign-in and `/samples` (kl7y.9) |
| `/library?q=&tag=&offset=` | Library | Today's `/` library, same parameters and snapping |
| `/?q=&tag=&offset=` | Redirect to `/library` with the same parameters | Old links and stored return paths keep working |
| `/threads` | Threads, tension pairs, readings that stand alone | Server render |
| `/threads/$id` | One thread | See [threads](#threads), rule 5 |
| `/catalog?kind=` | Index tab: `people`, `orgs`, `keywords`, or `hosts` (default `people`) | Server render |
| `/catalog?person=` (or `org=`, `keyword=`, `host=`) and `offset=` | A term's readings | Same list read with a facet |
| `/catalog?q=` | Find, text mode; results replace the index | Same `q` as the library |
| `/catalog` meaning mode | Find, by meaning | The question is never in the URL |
| `/digest` | Digest preview | Browser read |
| `/inbox`, `/inbox/$id` | Unchanged pages, reached from the desk | No nav item |
| `/readings/$id` | Reading, with the additions below | — |

Return paths (`app/src/auth/return-path.ts`) add `/library` with `q`, `tag`,
and `offset`; `/threads` and `/threads/:id`; `/catalog` with `kind`, `q`,
`offset`, and one facet; and `/digest`. Each of these accepts no other
parameters. A stored `/` with library parameters is rewritten to `/library`.

## Screens

The order within each screen follows the prototype.

**Desk.** It shows these sections, each omitted when empty, in this order:

1. Onboarding. This replaces everything below it when `needs_provider_key`
   is set and the library is empty.
2. Needs you. This section lists a rejected key (from the provider read),
   then failed readings and failed reprocesses, with the failure's headline.
3. Inbox. This section shows five items with inline preview, Add to library,
   and Discard, then "Show all N".
4. Processing. This section shows the stage label and the saved time, and
   uses the bounded refresh in `app/src/status-refresh.ts` with the library's
   rule.
5. On your desk. This section shows slots, the readings in order, Start on
   the first, and take-off controls.
6. Ready since {date}. Each row has a Put on desk control.
7. The Next digest tile and the Provider tile.

**Session bar.** On a reading that is on the desk, a bar above the title
reads "On your desk · n of m" and names the next reading. It offers:

- Done, next: removes the reading and opens the next one.
- Done, clear the desk: on the last reading.
- Pause: returns to the desk.

On a ready reading that is not on the desk, the bar's place holds a Put on
desk toggle. The toggle is disabled with "Three readings at a time" when the
desk is full.

**Library.** Connected's library with these additions:

- Each card shows its novelty verdict label, its relationship counts, and a
  desk toggle.
- A Cards / Rows layout switch. The preference is stored in localStorage and
  is cosmetic.

**Reading.** The order is:

1. Session bar or desk toggle.
2. Title, metadata, and tags.
3. Mentions.
4. Status card, tabs, and the selected view.
5. Novelty.
6. Details.

Beside the column on desktop, or after it on a phone, come:

1. The thread strip. It names the thread and shows Earlier and Later, with
   "This is the first" or "This is the latest" at the ends.
2. Connections & tensions.
3. Worth revisiting.
4. More like this.

The thread strip and More like this load in the browser. While they load,
they take no space.

**Threads, Catalog, Digest, Landing.** These follow the prototype's screens,
with production data only.

## Out of scope

- A digest mail change, including tensions or the inbox count (see decision
  1).
- Reordering the desk, or keeping desk history.
- Changes to the summarizer schema, the cached prefix, or stored manifests.
- Graph views.
- MCP tools for the desk, the terms index, or meaning search.
