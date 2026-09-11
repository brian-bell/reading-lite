# Connected acceptance matrix

Phase 2 draft for [issue #337](https://github.com/brian-bell/reading-lite/issues/337),
September 10, 2026. Use with the [design specification](design-spec.md). This
matrix maps current behavior on `main` (4031711) to the new TanStack Start
frontend, lists the states each screen must handle, and records the approved
status refresh contract. Brian accepted the core screens on September 10, 2026.

Row outcomes:

- **Preserve**: same URL and behavior, restyled.
- **Relocate**: same behavior in a different place.
- **New, approved**: backend already supports it and [#335](https://github.com/brian-bell/reading-lite/issues/335)
  or the [product scope](../../product/reading-lite-scope.md) asks for it in the UI.
- **Not in UI**: stays an API, MCP, or operator workflow.
- **Deferred**: designed in a later phase.

## Decisions recorded September 10, 2026

- Relationship targets are enriched at read time by the backend (see
  [relationship targets](design-spec.md#relationship-targets)).
- The new frontend has no reading-deletion control. Deletion stays in the API
  (`readings:delete` scope) and operator tooling.
- The status refresh numbers below are approved.
- The core screens are accepted as captured, with no further prototype changes
  for Phase 2, and the proposed contrast palette is adopted.
- This matrix is accepted. URL capture lives only on `/save` (no inline form on
  the library). Only ready readings ask for confirmation before reprocessing. A
  URL already in the library opens that reading with a notice. Failure
  categories come from a frontend mapping pinned by a test; the backend does not
  add a category field.

## Routes

Evidence: routes in `web/src/App.tsx` on current main.

| Current route | Current behavior | New frontend | Outcome |
| --- | --- | --- | --- |
| `/` | Signed in: library with submit form. Signed out: sign-in form rendered in place, no redirect | Library; signed-out behavior unchanged | Preserve |
| `/?q=&tag=&offset=` | `q` substring search, exact `tag`, `offset` snapped to a 20-row page, 20 per page | Same parameters, same snapping, same page size | Preserve |
| `/readings/:id` | Detail, or redirect to `/login?next=/readings/:id` when signed out | Detail including pending, failed, and watch states; same redirect | Preserve |
| `/readings/:id?view=source` | Not present | Source view; absent or any other value means Summary | New, approved |
| `/save` | Not present; submit lives on the library | URL and Markdown capture page, reached from navigation | Relocate (URL form); New, approved (Markdown) |
| `/login`, `?next=`, `?step_up=1` | Magic-link request, Turnstile when configured, return path, recent-auth step-up | Unchanged behavior | Preserve |
| `/login/verify`, `/auth/verify` | Link redemption, cross-tab continuation, return to stored path | Both entrypoints kept | Preserve |
| `/account/security` | Sessions, email change, immediate email, digest schedule, API tokens | Same sections, plus account deletion | Preserve; deletion is New, approved |
| `/terms`, `/privacy`, `/dmca` | Public legal pages, footer links | Unchanged, public, no SSR identity | Preserve |
| Any other path | `Navigate` to `/` with replace | Same | Preserve |
| Provider settings | Not present | Route and contract decided in Phase 6 | Deferred |

### Return paths

`safeAppReturnPath` in `web/src/login-return-path.ts` accepts only
`/readings/:id` and `/account/security`, and rejects any `?` or `#`. The new
frontend extends the allowlist to same-origin `/` with only `q`, `tag`, and
`offset`, and `/readings/:id` with only `view`. Parse candidates with `URL`
against the app origin and drop unknown parameters. Clear the stored return
path once it is consumed. The two login-return failures in the current SPA
tests are this defect; the new tests must cover it.

## Actions

| Action | Endpoint | Current placement | New placement | Outcome |
| --- | --- | --- | --- | --- |
| Search | `GET /api/readings?q=` | Library form | Library filter bar; empty results name the search and tag | Preserve |
| Filter by tag | `GET /api/readings?tag=` | Tag chips on rows; clear chip | Tag buttons on cards and detail; clear control | Preserve |
| Paginate | `offset`, `has_more` | Previous/Next with page number | Same | Preserve |
| Open a reading | — | Row title link | Card title link, stretched over the card; tag buttons stay separate targets | Preserve |
| Submit URL | `POST /api/readings` | Library form | `/save`, URL tab only; no inline library form | Relocate |
| Import Markdown | `POST /api/readings/import-markdown` | None | `/save`, Markdown tab: source URL (required), title (optional), Markdown (required) | New, approved |
| Reprocess | `POST /api/readings/:id/reprocess` | Detail button, no confirmation | Detail action; confirm on ready readings, none on failed | Preserve with confirmation |
| Reprocess from Markdown | same, `source.kind = "markdown"` | None | "Import a copy" on failed readings and unavailable source | New, approved |
| Force reprocess | same, `force: true` | Never sent | Never sent | Not in UI |
| Open extracted Markdown | `GET …/content` | Blob in new tab | Source view; "Open as file" in Details | Preserve |
| Open raw capture | `GET …/content/raw` | Blob in new tab | Details | Preserve |
| Diagnostics | `GET …/diagnostics` | Panel at bottom of detail | Details disclosure, collapsed | Preserve |
| Delete a reading | `DELETE /api/readings/:id` | None | None (Brian, September 10) | Not in UI |
| Look up by URL, similar readings | `GET …/lookup`, `POST …/similar` | None | None | Not in UI |
| Sign out | `POST /api/auth/logout` | Identity bar | Navigation account menu | Preserve |
| Sessions: list, revoke one, revoke all | `/api/auth/sessions…` | Security page | Account page | Preserve |
| Change email | `POST /api/auth/email-change` | Security page | Account page | Preserve |
| Immediate email and digest schedule | `GET`/`POST /api/auth/settings` | Security page | Account page | Preserve |
| API tokens: create (scopes, expiry, 10-token cap), revoke | `/api/auth/tokens…` | Security page | Account page; one-time token display unchanged | Preserve |
| Delete account | `DELETE /api/account` | None | Account page; see [account deletion](#account-deletion) | New, approved (#335 story 5) |
| Theme | — | None | System, Light, Dark in navigation | New, approved (#335 scope) |
| Provider key lifecycle, sample library, export | Not built | — | Phase 6 | Deferred |

Keep the current boot-time removal of the legacy
`reading-lite.bearerToken` localStorage entry until the old SPA is retired.
Bearer material never enters browser storage.

## States

Each row names the backend signal, what the reader sees, and the actions offered.
"Common states" apply to every authenticated screen.

### Common states

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| Loading | Query pending | Page frame and heading render; content region `aria-busy`; text "Loading…" after 300 ms, no spinner-only state | None |
| Expired session | 401 from any request | "Your session ended." Keep the current URL | "Sign in" to `/login?next=` with the current path |
| Permission denied | 403 | "You don't have access to this." Never treated as sign-out; the session stays | Back to library |
| Account changed | 412 expected-tenant mismatch | "This tab is signed in to a different account than the page expects." | Reload |
| Account closing | Deletion started here or in another tab: 401 after revocation, or 403 for an inactive account | Signed-out page explaining the account is being deleted; sign-in during the grace period follows the backend (confirm in Phase 5) | None |
| Offline | Fetch throws while `navigator.onLine` is false | Inline banner; keep form input and loaded content | Retry; refetch active queries on `online` |
| Server error | 5xx or unparseable body | "Something went wrong on our side." plus the error text | Retry |

### Library

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| No readings | Empty result, no `q` or `tag` | "No readings yet." | Save a reading |
| No results | Empty result with filters | "No readings match “q”" and/or "tagged T" | Clear search, clear tag |
| Offset past end | Empty result, `offset > 0` | As no results, with page number | First page |
| Pending or failed row | `status`, `active_attempt`, `last_attempt` | Status badge with text; failed shows the error message | Open reading |
| Reprocess failed on a ready reading | `last_attempt.trigger = reprocess`, `failed` | Ready card with "Reprocess failed" badge | Open reading |
| Long title | Any | Wraps; never truncated in the title; summary clamps at three lines | — |

### Reading detail

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| Not found | 404 | "This reading isn't in your library." | Back to library |
| Pending | `status = pending` or running attempt | Status card at the top, watch running; prior ready content stays visible below when reprocessing | Check status |
| Failed | `status = failed` | Failure category, message, stage; diagnostics collapsed | Retry; Import a copy |
| Ready | `status = ready` | Summary view by default | Reprocess; view Source |
| Sparse archive | `similarity.count = 0` or no connections | Novelty says nothing close existed when processed; no invented comparisons | — |
| Old manifest | No `similarity`, `connections_computed_at`, or verdict | Omit the missing line; never show "unclassified" as a verdict | — |
| Source unavailable | `content_status` not `captured`, or `/content` 404 | Source view says the source wasn't captured; summary, novelty, relationships stay usable | Import a copy |
| Degraded YouTube | `enrichment_degradation` present | Muted notice naming what was missing (watch page or transcript) | — |
| Imported Markdown | `source_type = markdown` | Metadata line says "Imported Markdown" | — |
| Removed target | Relationship id absent from targets | Dashed card, "Reading removed", reason kept, no link | — |
| Non-ready target | Target `status` pending or failed | Card links, with a text status badge | Follow |
| Arrived from a removed target | 404 after following a relationship | Not-found page shows the originating reason from the trail | Back to the previous reading |
| Long or rich source | Any | See [source content](design-spec.md#source-content) | — |

### Capture

| State | Signal | Presentation | Actions |
| --- | --- | --- | --- |
| Invalid input | Client URL check, or 400 | Field-level error, focus the field | Correct |
| Already saved | 200 with a manifest | Navigate to that reading with an "Already in your library" notice at the top | — |
| Accepted | 202 | Navigate to `/readings/:id`; watch starts | — |
| Owner initializing | 409 with `id` and `poll` | Navigate to that reading; watch starts | — |
| Already processing | 409 active attempt | "This reading is already processing." | Open reading |
| Request rate or quota | 429 `rate_limited` or `quota_exhausted`, `limit`, `reset_at` | Names the limit (request rate, hourly, monthly) and when it resets | Try again after reset |
| Usage guard unavailable | 429 `usage guard unavailable` | "Limits can't be checked right now." | Try again |
| Saving unavailable | 503; optional `id` | "Saving is unavailable right now." Includes a link when `id` is present | Try again |
| Markdown too large | 503 on import or Markdown reprocess | Explains the 128 KB queue limit | Shorten |

### Failure categories

Failed manifests carry `error.code` (the backend error class name, or
`stale_pending` / `stale_active_attempt`), `error.stage`, and `error.retryable`.
The frontend maps them to categories in one module, with an unknown fallback.
These names are not a published contract, so Phase 4 pins the mapping with a
test that fails when the backend adds or renames a class.

| Category | Examples | Reader copy | Recovery |
| --- | --- | --- | --- |
| Source unreachable | `fetch_source` stage: `BadStatusError` (4xx), `BlockedHostError`, `FetchTimeoutError`, `TooManyRedirectsError`, `DestinationResolutionError` | The page couldn't be fetched | Retry; Import a copy |
| Source incomplete | `SourceRejectedError`, `OpenAISourceRejectedError`; X and Reddit import errors | The page didn't contain the full article | Import a copy |
| Provider limit | Provider 429, `RateLimitedError` | The AI provider is rate limiting requests | Retry later |
| Provider error | Other provider errors at `summarize` or `embed_*` | The AI provider returned an error | Retry |
| Key problem | Provider 401 or 403 | Provisional until Phase 6 (hosted keys are the operator's today) | Phase 6 |
| Hosting limit | `SpendAdmissionError`, `ProcessingDeferExpiredError` | Reading Lite's processing limit was reached | Retry later |
| Stopped | `stale_pending`, `stale_active_attempt`, `QueueRetriesExhaustedError` | Processing stopped before finishing | Retry |
| Unknown | Anything else | The error message, unchanged | Retry; Details |

Retry on a failed reading is a reprocess; it never repeats automatically.

### Account deletion

Placement: last section of the account page.

- Explain the seven-day grace before data is wiped, and that sessions and tokens
  are revoked immediately. Do not promise an archive export until Phase 6 ships one.
- Require typing `delete` (the API's `{ "confirm": "delete" }`) in a modal dialog.
- A recent sign-in (10 minutes) is required. On that 403, show the existing
  step-up message and link (`/login?step_up=1&next=/account/security`).
- On success, clear identity caches and show a signed-out confirmation page.

## Status refresh contract

Approved September 10, 2026. Implemented with TanStack Query `refetchInterval`
on the reading query. It reports backend state only and never invents progress.

**Admission.** Watch a reading while `status = pending` or
`active_attempt.status = running`. A watch belongs to one attempt id; a new
attempt (reprocess, retry, import) starts a new watch.

**Schedule.** Elapsed time is measured from when the page started watching that
attempt:

| Elapsed | Interval |
| --- | --- |
| 0–30 s | 3 s |
| 30 s–2 min | 5 s |
| 2–16 min | 15 s |

**Cap.** Stop automatic checks at 16 minutes. `PENDING_TTL_SECONDS` is 900 in
every `wrangler.toml` environment, and the backend reports older pending
attempts as failed at read time, so the cap covers the whole attempt lifetime
plus a minute.

**Stop conditions.**

- Terminal: `ready`, or `failed` with no running attempt. Announce the outcome in
  a polite live region and invalidate the library queries. Do not move focus.
- 401: expired-session state. 403: permission state. 404: not-found state.
  412: account-changed state.
- Unmount or navigation away.

**Hidden tab.** Pause while `document.visibilityState = hidden`. On becoming
visible, check immediately, then resume the schedule. Hidden time counts toward
the cap.

**Network failure.** On a thrown fetch or 5xx, double the interval, up to 30 s.
After three consecutive failures, stop and show "Couldn't check status". A
success resets the count.

**Manual fallback.** "Check status" is always available while a reading is
active. It performs one request. After the cap or a network stop, the card
reads "Still processing" or "Couldn't check status" with the same button.
Manual checks do not restart automatic refresh; a new attempt or a reload does.

**Stage label.** While running, show a coarse label from `active_attempt.stage`
when present: Fetching (`queued` through `write_extracted`), Analyzing
(`embed_source` through `embed_summary`), Publishing (`upsert_vector` through
`send_email`). Otherwise "Processing". No percentages.

**Library.** Refresh the visible page every 15 s only while it contains an
active row, with the same cap, hidden-tab, failure, and stop rules.

### Acceptance checks

Automated with fake timers and a stubbed `fetch`:

1. A pending reading is requested at 3, 6, … s, then every 5 s after 30 s, then
   every 15 s after 2 min.
2. No request is made after 16 minutes; the manual button remains and works once.
3. A `ready` response stops requests and announces completion once.
4. A `failed` response stops requests and renders the failure category.
5. 401, 403, 404, and 412 each stop requests and render their state.
6. While hidden, no requests occur. Becoming visible triggers one immediate request.
7. Three consecutive network failures stop requests; one success before the third resets the count.
8. Unmounting cancels the pending timer and in-flight request.
9. A reprocess started from the page starts a new watch for the new attempt id.
10. The library refreshes only while its visible page has an active row.
11. A ready reading, and a reading whose attempt has finished, make no refresh requests.
