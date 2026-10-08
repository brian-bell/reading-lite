# Next direction — reading-lite-4tvj

A clickable prototype of the interface that follows the shipped Connected
design ([specification](../../../docs/design/connected/design-spec.md)). It
keeps Connected's tokens, type, navigation column, reading surface, status
card, relationship cards, and return trail, and combines the three candidate
directions Brian reviewed on 1 October 2026 (Threads, Desk, Catalog) into one
app: the desk as home, tensions inside Threads, and Find inside the Catalog. This is an isolated Vite entry using `app/`'s
React toolchain: the production routes, Worker, backend, and deployments are
unchanged, and nothing here reads or writes the backend.

## Open locally

From `app/`, run `npm ci` if needed, then `npm run prototype:dev` and open the
URL Vite prints (port 5175, beside the app's 5174). Starting points:

- `/#/desk` — home. What needs you (failed readings, a rejected key), the
  inbox (Markdown an agent staged, previewed, added to the library, or
  discarded in place), what is processing, the up-to-three readings on your
  desk, what became ready since your last visit, the next digest, and the
  provider.
- `/#/library` — Connected's library, with each card's novelty verdict,
  relationship count, thread, and desk toggle, plus a rows layout.
- `/#/threads` — readings grouped by the connections and tensions between
  them, oldest first, with the library's tensions on the same page and the
  readings that stand on their own.
- `/#/catalog` — the index of people, organizations, keywords, and hosts, with
  Find inside it: one field at the top takes a word or, by meaning, a
  question, and a term from the index narrows to its readings. Results
  replace the index until cleared.
- `/#/reading/a-quieter-internet` — the reading page with all of the above:
  the session bar or desk toggle above the title, mentions under the tags,
  the thread strip beside the column, then Connections & tensions, Worth
  revisiting, and More like this.
- `/#/digest` — the weekly digest preview in the app's own design.
- `/#/landing` — the signed-out landing with the sample library; the New
  reader scenario goes from here through sign-in, key, and first save.

The three-direction study's hashes (`#/threads/reading/x`, `#/desk/desk`,
`#/catalog/people`, `#/threads/tensions`, `#/find`, `#/inbox`) still open. Phone narrows the stage
to 390 px and triggers the same container breakpoints as a narrow browser;
the layout also adapts to a real phone-width window. Light and dark apply to
every screen.

## Scenarios and samples

Everything uses `samples.ts`: the six bundled sample readings
(`src/samples/sample-library.json`, authored fiction) plus eight more so that
threads, tensions, a months-old connection, an inbox, and the pending and
failed states have something to show, including a ready reading whose
reprocess failed (its earlier summary stays; the failure is its last attempt)
and a pending reading saved 40 minutes before the study clock, which a read
surfaces as "Processing stopped before finishing" the way the backend's
staleness annotation does, without a write. The scenario control covers the
full library, a new reader with no key and an empty library, a sparse
archive, a pending capture, a stalled capture, a failed capture, a failed
reprocess, and a removed connection target. The
sample outcome control on the save form and the status card decides what
Check status reports: ready, or a failure in the production categories
(`src/reading-failure.ts`): source unreachable, key invalid, out of credit,
provider rate limit, hosting limit.

Tasks to try:

1. Start a session from the desk, read the two pieces on it, and reach the
   cleared desk. Then review the inbox there: preview an item, add one,
   discard the other.
2. Open A quieter internet, follow the garden connection and the friction
   tension, and return. Step along its thread with Earlier and Later.
3. On Threads, read the Attention thread from the beginning and find the two
   tensions in the library.
4. Open What a commonplace book is for and follow the revisit prompt to a
   reading saved seven months earlier.
5. In the Catalog, browse by host, narrow to Mara Ellis, then ask “why do I
   keep saving things I never read?” by meaning.
6. In the New reader scenario, go from the landing through a sample, sign-in,
   key, and first save without help.
7. Save a URL, watch it process, and recover from a rejected key, an
   out-of-credit account, and an unreachable page.

## What it would need from the backend

| Feature | New reads or fields | Paid calls |
| --- | --- | --- |
| Threads and tensions | The tenant's relationships as one list (the rows already exist); threads are derived in the frontend. | None |
| Desk | A per-reading desk flag (at most three); a digest preview read. The last-visit time stays in the browser and carries no identity. | None |
| Catalog and Find | A terms index (people, orgs, keywords, hosts with counts; rows already exist); meaning search embeds the question and calls the existing `POST /api/readings/similar`. | One embedding per meaning search, on the reader's key |
| More like this | The similar endpoint by reading id, excluding judged relationships. | None (the reading's embedding is stored) |

Nothing here changes the summarizer schema, the cached prefix, or the stored
manifests.

## Open questions

- The navigation column carries five items (Desk, Library, Threads, Catalog,
  Save reading). The inbox has no page of its own: an agent that stages more
  than the desk can show needs a rule (a cap, or a "show all" row).
- Threads are connected components; a rule for cutting a very large
  component once the library grows is open.
- The desk's three-reading cap and the "ready since" window are study
  values, not product rules.

## Simulation boundaries

- No API proxy, provider client, backend import, or live processing. A save
  never fetches the URL; Check status applies the chosen sample outcome.
  Markdown stays in page memory as the source text.
- Meaning search is token overlap over titles, leads, tags, and keywords,
  with the matched terms as the "why"; production would rank by cosine
  similarity after embedding the question.
- The desk's "ready since" uses a fixed last visit (27 September 2026) and a
  fixed study clock (1 October 2026, 10:00 UTC). The digest preview is the
  current week so far. Staleness is judged against the same clock with the
  backend's 15-minute window, from the running attempt's start, so a retry
  begins a fresh window.
- A sample outcome that fails over a reading that already had a summary
  rolls forward as the writer does: the reading stays ready and carries the
  failure as its last attempt.
- The provider field is disabled. Connect, replace, and remove change a
  sample state and gate saving, as the shipped intake refusal does.
- Captures, filters, tabs, the desk, and provider state last for the page
  session; a reload restores the fixtures. Nothing persists in browser
  storage.

## Validation

From `app/`:

```sh
npm run prototype:build
npm run typecheck && npm test
```

The study has its own TypeScript project (`tsconfig.prototypes.json`), so
`npm test` and `npm run typecheck` never see it, and CI's path map runs no
job for it (`scripts/ci-lib/changed-jobs.ts`). The build writes to the
ignored `app/dist-prototypes/`. It has no tests of its own; the desktop and
phone review in both themes is Brian's.

## History

This combines the three separate candidates reviewed on 1 October 2026
(A Threads, B Desk, C Catalog), which had a direction picker, a comparison
table, and a decision form. Brian chose to continue with all three in one
app, with the desk as home, so the comparison was not kept.
