# Next direction acceptance matrix

Written October 3, 2026 for reading-lite-kl7y. Use it with the
[design specification](design-spec.md). Connected's
[acceptance matrix](../connected/acceptance-matrix.md) still governs every
row it covers. That includes the common states (loading, expired session,
403, 412, offline, server error), the status refresh contract, and the
failure categories. This matrix adds the rows the new direction introduces,
and names the slice that owns each one.

Row outcomes, as in Connected:

- **Preserve**: same behavior, restyled or moved.
- **Relocate**: same behavior somewhere else.
- **New**: the slice adds it.
- **Not in UI**: stays API, MCP, or operator.
- **Deferred**: not in this epic.

## Routes

| Current | New | Outcome | Slice |
| --- | --- | --- | --- |
| `/` signed in: library | Desk | New | kl7y.7 |
| `/` signed out: sign-in form | Landing linking sign-in and `/samples` | New | kl7y.9 |
| `/?q=&tag=&offset=` | Redirects to `/library` with the same parameters | Relocate | kl7y.7 |
| — | `/library?q=&tag=&offset=` | Relocate | kl7y.7 |
| — | `/threads`, `/threads/$id` | New | kl7y.3 |
| — | `/catalog` with `kind`, one facet, `q`, `offset` | New | kl7y.4 |
| — | `/catalog`, meaning mode (not in the URL) | New | kl7y.5 |
| — | `/digest` | New | kl7y.10 |
| `/inbox` (nav item) | Same page, reached by "Show all" on the desk; no nav item | Relocate | kl7y.8 |
| `/inbox/$id` | Unchanged | Preserve | kl7y.8 |
| `/readings/$id` | Additions in [reading](#reading) | Preserve | several |
| `/samples`, `/samples/$id` | Unchanged | Preserve | — |

Return paths: see [routes](design-spec.md#routes-and-navigation). Each new
path has a test that accepts its allowed parameters and drops any others. A
stored `/?q=…` is rewritten to `/library?q=…`.

## Actions

| Action | Endpoint | Placement | Outcome | Slice |
| --- | --- | --- | --- | --- |
| Put on desk | `POST /api/desk` | Library card, reading page, Ready since row | New | kl7y.6 |
| Take off desk | `DELETE /api/desk/:id` | Desk row ×, reading page toggle | New | kl7y.6 |
| Done, next / Done, clear the desk | `DELETE /api/desk/:id` then navigate | Session bar | New | kl7y.7 |
| Clear the desk | `DELETE /api/desk` | Desk section | New | kl7y.7 |
| Browse the index | `GET /api/readings/terms` | Catalog tabs | New | kl7y.4 |
| Narrow to a term | `GET /api/readings?person=` (and the other facets) | Catalog term, reading mentions | New | kl7y.4 |
| Find by text | `GET /api/readings?q=` | Catalog Find | Relocate (also on the library) | kl7y.4 |
| Find by meaning | `POST /api/readings/search` | Catalog Find, meaning mode | New, paid | kl7y.5 |
| More like this | `GET /api/readings/:id/similar` | Reading page | New | kl7y.5 |
| Follow a thread | `GET /api/readings/relationships` | Threads, reading thread strip | New | kl7y.3 |
| Preview the digest | `GET /api/digest/preview` | `/digest`, desk tile | New | kl7y.10 |
| Preview, add, discard inbox items | Existing inbox API | Desk Inbox section | Relocate | kl7y.8 |
| Reorder the desk | — | — | Deferred | — |
| Supply an embedding for similar | `POST /api/readings/similar` | — | Not in UI | — |

Each write invalidates the queries it affects:

- A desk write invalidates the desk, the library, and the reading.
- An inbox promote or discard invalidates the desk and the inbox.

No new polling is added. The desk's Processing section uses the library's
bounded refresh rule.

## States

### Desk

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| New reader | `needs_provider_key` and an empty library | Three-step onboarding replaces the sections | Open samples; connect key; Save (disabled until a key) |
| Empty, key connected | No rows in any group, no inbox | "Nothing needs you." plus an empty On your desk with its hint | Save a reading; Library |
| Key rejected | Provider credential `status = invalid` | First row of Needs you | Replace key |
| Failed reading | `needs_you` row, `status = failed` | The failure category headline | Open reading |
| Failed reprocess | `needs_you` row, ready with failed reprocess `last_attempt` | "Reprocess failed · {headline}" | Open reading |
| Stalled | Pending past the TTL, read as failed (`stale_active_attempt`; `stale_pending` when there is no attempt) | In Needs you: "Processing stopped before finishing." | Open reading |
| More than 20 | `needs_you_total` or `processing_total` > 20 | The 20 newest, then "and N more" (the library has no status filter) | — |
| Inbox over five | More than 5 staged items | Five newest, then "Show all N" | `/inbox` |
| Processing | `processing` rows | Stage label and "saved {ago}"; refreshes while active | Open reading |
| Desk empty | `on_desk` empty | "Nothing yet. Put a reading here from the library, or from what arrived below." | — |
| Desk full | Three on the desk | Slots filled; toggles elsewhere disabled with "Three readings at a time" | Take one off |
| Desk reading not ready | An `on_desk` row is pending or failed | Row with its status badge; Start still opens the first reading | Open reading |
| Ready since | `ready_since` rows | Heading "Ready since {date of since}"; at most 10, then "Show all N" | Put on desk |
| First visit | No `rl_visit` cookie | "Ready since" covers the last 7 days | — |
| Digest off | Preview `cadence = off` | Tile says digests are off | Account settings |
| Provider read failed | Provider read error | Tile shows Connected's account-section error with Retry; the rest of the desk is unaffected | Retry |

### Desk writes

| State | Signal | Presentation |
| --- | --- | --- |
| Added | 200 | Toggle reads "Take off desk"; slots update |
| Full | 409 `desk_full` (another tab filled it) | Inline "Three readings at a time"; the desk query refetches |
| Not ready | 409 `not_ready` | Inline "Only ready readings can go on the desk" |
| Gone | 404 | The reading's not-found state |

### Library

These rows are added to Connected's.

| State | Signal | Presentation |
| --- | --- | --- |
| Counts | `connection_count`, `tension_count` | "n connections · m tensions"; nothing at zero |
| Verdict | `novelty_verdict` on a ready card | Label only (Novel, Familiar, Duplicate); none when absent |
| On the desk | `desk_position` | Toggle pressed; "On your desk" |
| Rows layout | localStorage preference | Same content in a dense row; the preference survives reloads |

### Threads

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| No threads | No component of two or more ready readings | "No threads yet. Threads form as readings connect." | Library |
| Threads | Components | Name, count, tension count, span of dates | Open thread |
| Large component | More than 12 readings | Split by tag ([rule](design-spec.md#threads)) | — |
| Tension pairs | Pairs exist | Active-voice rows with kind label and reason | Open either reading |
| Standing alone | Ready readings in no thread | Listed last | Open reading |
| Thread not found | `$id` in no thread, or unknown | "This reading isn't in a thread." | Threads; open the reading if it exists |
| Pending target | A relationship to a non-ready reading | It does not join a thread | — |

### Catalog and Find

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| Index | Terms read | Four tabs with counts | Pick a term |
| Empty kind | A list is empty | "No {kind} yet." | Other tabs |
| Term | Facet in the URL | Term heading, its readings, pager | Clear |
| Unknown term | Facet with no readings | "No readings mention “term”." | Clear |
| Text results | `q` | Results replace the index; "No readings match “q”" when empty | Clear |
| Meaning, no key | 409 `provider_key_required` | Connected's key-required copy; text mode still works | Connect a key |
| Meaning, key failures | Provider error codes | Connected's failure category copy for the key, billing, or limit case | As Connected |
| Meaning, running | Request in flight | Button busy; the field keeps its text | — |
| Meaning, results | `items` | Closeness band per row; no score number | Open reading |
| Meaning, none | Empty `items` | "Nothing in your library is close to that." | Try text |
| Meaning, reload | — | The question and results are gone; no request is made | — |

### Reading

These rows are added to Connected's.

| State | Signal | Presentation |
| --- | --- | --- |
| On the desk | `desk_position` | Session bar: "On your desk · n of m", next title, Done and Pause |
| Last on the desk | Position = count | "Done, clear the desk" |
| Not on the desk, ready | No `desk_position` | Put on desk toggle |
| Not ready | Pending or failed | No toggle, no session bar |
| Mentions | `people`, `orgs` | A row under the tags; each term links to its catalog facet |
| In a thread | Relationships read | Thread strip with Earlier and Later; ends say "This is the first" or "This is the latest" |
| No thread | Not in a component | No strip |
| Worth revisiting | Connection target saved more than 60 days before | A group after Connections & tensions |
| More like this | `/similar` items | Up to five cards; hidden when empty or on error |
| Relationships read failed | Error | Strip omitted; the rest of the page is unaffected |

### Digest

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| Scheduled | `next_send_at` | "Goes out {local date and time}, {time zone}"; the readings so far | Open a reading |
| Empty window | No items | Nothing yet; no mail is sent for an empty period | — |
| Off | `cadence = off` | Digests are off | Account settings |

## Checks each slice owns

Each check has one owner. Do not repeat it at another layer.

| Check | Owner |
| --- | --- |
| Relationships read: tenant scoping, dangling targets dropped, staleness on `readings` | kl7y.3 integration |
| `relationship_targets[].created_at` present; MCP still strips the map | kl7y.3 |
| Counts on list items match the reading's own rows, live targets only | kl7y.3 store test |
| Threads: components, the split above 12, naming, ordering, `$id` resolution | kl7y.3 `threads.test.ts` (`it.each`) |
| Tension pairs: dedupe and active voice | kl7y.3 `threads.test.ts` |
| Worth revisiting at 60 days | kl7y.3 |
| Terms: case grouping, displayed spelling, host derivation, ready only | kl7y.4 store test |
| Facets: one at a time (400), exact case-insensitive match, combined with `q` | kl7y.4 |
| Meaning search: key gate, spend admission inside the retry loop, no transaction across the call, floor | kl7y.5 (paid-spend ordering pin) |
| Closeness band edges | kl7y.5 frontend unit |
| Similar by reading: self and judged targets excluded, floor, 404, empty when no embedding | kl7y.5 |
| Desk: cap of 3 (409), not ready (409), idempotent add, renumber after a purge | kl7y.6 workers-pool (real concurrency: two adds racing for the third slot) |
| Desk: wipe and purge cascade; publication and `manifest-rows` never touch it; a toggle leaves `readings.updated_at` and `xmin` unchanged | kl7y.6 |
| Desk: archive `manifest.json` and `index.json` carry `desk_position` | kl7y.6 export test |
| Desk read groups, bounds and totals | kl7y.7 integration |
| Visit cookie rule | kl7y.7 unit with injected `now` |
| `/` to `/library` redirect and return-path rewrite | kl7y.7 |
| Inbox on desk: five, then Show all; promote and discard invalidate | kl7y.8 |
| New-reader journey from landing to first save | kl7y.9 browser evidence |
| Digest preview: `next_send_at` agrees with `digestDueAt`; selection is `selectDigestReadings` | kl7y.10 |
| `docs/openapi.yaml` covers every new endpoint | each slice; kl7y.11 audits |
| Full `test:browser` (themes, viewports, axe, keyboard) for desk, library, threads, catalog, reading, digest, landing | kl7y.11 |
| `scripts/ci-lib/changed-jobs.ts` maps any new paths | each slice |

## Keyboard and focus

Connected's rules apply. These are the additions:

- The desk toggle is a `button` with `aria-pressed`. When it is disabled at
  the cap, the reason is visible text, not only a `title`.
- Done, next moves focus to the next reading's heading, as any route change
  does.
- Desk sections are `section` elements with headings. The counts beside the
  headings are `aria-hidden`, and each list carries its own count.
- Catalog tabs follow the ARIA tabs pattern. Find's mode switch is a radio
  group. Meaning results are announced in a polite live region.
- The thread strip's Earlier and Later are links, in that order.
