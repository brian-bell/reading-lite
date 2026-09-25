# Connected design specification

Status: captured design baseline, September 9, 2026, with the Phase 2
specification drafted September 10, 2026 (see
[Phase 2 specification](#phase-2-specification) and the
[acceptance matrix](acceptance-matrix.md)). See the [frozen source and
reproduction instructions](README.md). Brian reviewed and accepted the core
screens on September 10, 2026, and adopted the proposed contrast palette.

## Decisions recorded from Brian

- Continue with Connected. No borrowed elements from the other two directions
  have been requested.
- Remove decorative text such as “threads worth following” and “your reading,
  connected.” Use direct titles: Library, Save reading, Provider. Keep text that
  explains a relationship, a failure, an action, or the limits of the demo.
- Use the available width more efficiently. Compact page margins, card spacing,
  navigation, and forms; retain comfortable source and summary typography.
- Give Connected its own runnable entrypoint without a direction picker,
  comparison footer, or decision form.

The desktop reading surface places connections and tensions beside the article.
On a phone they follow the reading, reached with a “Connections & tensions” jump
and a “Back to the reading” action. Relationship explanations and return context
are central to this direction. A graph explorer is outside the agreed scope.

## Layout and typography baseline

Values below describe the current CSS, including container breakpoints. The
prototype surface is the container; the phone toolbar toggle narrows this
container without emulating an actual mobile browser. The screenshots use real
1440 × 1000 and 390 × 844 CSS-pixel viewports with the Desktop layout toggle
selected, so they exercise the natural responsive layout.

| Element | Captured value or rule |
| --- | --- |
| Frame | Dedicated desktop stage fills width up to 1760 px; compact preview toolbar above app |
| Desktop navigation | 80 px column, icon and text stacked; active item uses accent surface |
| Small navigation | At container width ≤650 px, brand row and horizontal navigation above content |
| Desktop page spacing | Library/forms 28 px top and sides, 36 px bottom; heading gap 20 px |
| Phone page spacing | Library/forms 20 px top, 16 px sides, 28 px bottom; reading 22/16/28 px |
| Library grid | Three columns at ≥1280 px; two from >850 to <1280; one at ≤850 |
| Cards | 12 px grid gap; 20 px padding, 16 px at ≤650; titles wrap; summaries clamp to three lines; hover deepens the border toward accent and adds a soft warm shadow |
| Detail columns | Flexible reading plus 320 px context; context 295 px at ≤1150; stacked at ≤850 |
| Relationship cards | Paper surface, 1 px hairline border with a 2 px accent (or danger) left rule, 15/16 px padding, 12 px bottom margin, 7 px radius; context panel transparent over the page grain, 20/18/28 px |
| Forms/status cards | Form 20 px padding; status 24 px; both 18 px at ≤650 |
| Font stack | UI chrome in Inter if installed, then system sans; reading matter (titles, leads, source) in Charter, Iowan Old Style, Palatino, then Georgia; no bundled font |
| Reading/page title | Serif, weight 400, `clamp(36px, 3.6cqw, 52px)`, line height 1.12, tracking −.025em; 35 px at ≤650 |
| Library title | Serif 34 px |
| Library card title | Serif 24 px, weight 400, line height 1.24; turns accent on hover |
| Summary lead | Charter/serif, 21 px, line height 1.7 |
| Source paragraphs | Charter/serif, 20 px, line height 1.85; 19 px at ≤650 |
| Key points | Sans 16 px, line height 1.75; 16 px number/text gap |
| Relationship text | Serif title 18 px/1.35, weight 400; explanation sans 14 px/1.65 |
| Metadata and state badges | 12–13 px; text labels accompany status colors |
| Novelty | Accent surface, 2 px accent rule, 20/22 px padding, 22 px section margin; heading in serif italic |
| Focus outline | Focus-visible controls use 3 px accent outline with 4 px offset |

The source of exact cascade behavior is
[shared styles](https://github.com/brian-bell/reading-lite/blob/128c7cdf926cbcbb8206f5b654208aa3456c7d51/web/prototypes/interface-directions/styles.css),
[Connected layout rules](https://github.com/brian-bell/reading-lite/blob/128c7cdf926cbcbb8206f5b654208aa3456c7d51/web/prototypes/interface-directions/ui.css),
and [dedicated frame rules](https://github.com/brian-bell/reading-lite/blob/128c7cdf926cbcbb8206f5b654208aa3456c7d51/web/prototypes/connected/styles.css).
System font differences can change wrapping. An earlier rough edge — key-point
numbers such as “01” wrapping onto two lines on narrow phones — is fixed
(`white-space: nowrap` on the number), and the current phone screenshots show
the corrected rendering.

## Color tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f1eadd` | `#211e1b` | Page, with a faint tiled paper grain |
| `--surface` | `#f8f3e9` | `#2a2623` | Cards/navigation |
| `--ink` | `#2c2620` | `#f0eae1` | Main text |
| `--muted` | `#6c5e50` (captured `#78695a`) | `#b3a89b` | Secondary text |
| `--border` | `#dccfbd` | `#443d36` | Dividers |
| `--soft` | `#e9dfcf` | `#332e29` | Secondary fills |
| `--accent` | `#4e4aa2` | `#b6b1ee` | Actions/selection |
| `--accent-soft` | `#e9e2ec` | `#36324a` | Connections/novelty |
| `--danger` | `#a34133` | `#edac91` | Failure/tension rule |
| `--positive` | `#356b56` (captured `#3c755f`) | `#91d0b2` | Ready/success |
| `--control-border` | `#948069` | `#857869` | Input, search, and toggle borders (3:1) |
| `--card-shadow` | warm `rgba(84, 62, 36)` at 5–7% | black at 25–28% | Library cards, forms, status cards |

Warm revision, September 9/10, 2026: the palette moved from cool blue-grey to parchment and cream in light mode (no pure white surfaces remain) and warm charcoal in dark mode, the page and novelty panel carry a low-opacity SVG grain, cards take a faint warm shadow, and the lead and source paragraphs use Charter, Iowan Old Style, Palatino, then Georgia. The September 10 screenshots reflect this revision.

Ink-on-paper revision, September 10, 2026: all reading matter — reading and
page titles, library card titles, relationship titles, and content headings —
moved to the same Charter/serif stack at weight 400, leaving Inter for UI
chrome (navigation, badges, labels, controls). Relationship cards changed from
filled accent-soft blocks to paper cards with a hairline border and an
accent-ink left rule (danger ink for tensions) on a transparent context panel,
and card hovers replaced the global brightness filter with a border/title
color shift toward accent. The screenshots reflect this revision.

Connections use a paper card with an accent left rule. Tensions use the same
card with a danger left rule and an explicit Tensions heading. Removed
connections use a dashed border, a “Reading removed” label, and retained
explanatory text.
These values are references; production contrast, target-size, zoom, and
assistive-technology checks remain acceptance work.

## Screens and interactions

| Surface | Captured behavior | Implementation implication |
| --- | --- | --- |
| Library | Seven fixtures, newest first; search title/author/summary, one tag filter, five items per page; whole card opens reading or status | Preserve discovery and return context; production search/pagination use backend semantics |
| Library return | Search, tag, and page survive navigation within the loaded prototype | Decide URL representation and restore scroll as well; current prototype resets scroll to top on navigation |
| Reading | Summary/Source tabs; selection remembered per reading during page session; novelty below either view | Keep source distinct from generated analysis, including missing/partial data |
| Connections/tensions | Title, explanation, author/publication, reading time; follow a target | Preserve why it was suggested, with a trail and return action |
| Return trail | Previous title and explanation above destination; “Back to your reading” | Support more than one hop, browser history, and returning from a missing target |
| Sparse archive | One reading; explicitly insufficient history for novelty and relationships | Avoid invented comparisons or a misleading empty success state |
| Unavailable source | Retain summary/novelty/connections; offer summary or import | Missing source does not make the whole reading unusable |
| Removed target | Explain unavailability and offer return to previous reading | Avoid a dead end and preserve the originating relationship explanation |
| Save URL | Validate HTTP(S) URL; create pending fixture and show status | Real intake must handle existing/conflicting owners and quotas |
| Import Markdown | Require text, retain it in memory, explicitly say analysis was not run | Import/recovery must respect the real source and reprocessing contracts |
| Processing | Saved, capture/summarize, connections/novelty; manual Check status | Step labels are conceptual, not a backend event stream or progress percentage |
| Ready | Success state and Open reading | Only show completion when the backend confirms it |
| Failed | Explain source/key/provider/hosting cause; relevant recovery and expandable diagnostics | Keep these causes distinct; recovery must not silently repeat a paid write |
| Provider | Missing/connected/invalid/removed sample states and a sample-library route | Concept only; credential contracts and supported providers remain Phase 6 decisions |

The prototype focuses main content after route changes. Tabs use arrow, Home,
and End keyboard behavior. These are a starting point for the production focus
and keyboard specification, not a completed accessibility audit. The mobile
jump scrolls smoothly but does not define focus movement or reduced-motion
behavior; both remain to be specified.

## Simulation boundaries

All seven articles, authors, publications, and relationships were authored for
this study. No real archive or provider credential is captured. URL capture does
not fetch the entered URL; it uses the slow-work sample. Markdown remains plain
text in page memory. Capture state, filters, theme, and per-reading tabs reset on
reload. Scenario selection also resets library filters.

“Check status” advances the chosen preview outcome immediately. “Retry sample”
and “Reprocess sample” set a sample pending and make its next check succeed.
There is no queue, timer, backend request, analysis, or paid call. The disabled
API key field cannot connect a provider. Sample key actions only change local UI
state; they do not enforce real capture admission after key removal.

Hash routes (`#/library`, `#/reading/attention`, `#/capture`, `#/status/pending`,
`#/provider`) support the standalone study. They are not the new frontend's URL
contract. Legacy comparison routes normalize to Connected. The toolbar and
simulation disclosures belong to this reference, not to the production app.

## Phase 2 specification

Drafted September 10, 2026 for review. Brian decided three points that day:
relationship targets are enriched at read time by the backend, the new frontend
has no reading-deletion control, and the status refresh numbers in the
[acceptance matrix](acceptance-matrix.md#status-refresh-contract) are approved.
Later that day he dropped the estimated reading time, accepted the core screens
(library, reading, capture/status, provider concept) without further prototype
changes, and adopted the proposed light-mode contrast palette. He then reviewed
and accepted each remaining section below. Choices he made in that review:
images in the source view load only when clicked, the connection trail stays in
history state, the Summary/Source switch replaces the history entry, the theme
control lives in the navigation, Details is one collapsed section, and focus
moves to the page heading after a route change. The whole Phase 2 specification
is accepted.

### Data mapping

The prototype's fixtures include fields the backend does not produce. The
production UI renders only real data, or text derived from it by fixed rules.

| Prototype element | Backend source | Production rule |
| --- | --- | --- |
| Title | `title`, else `url` | Unchanged |
| Author, publication | None | Show the URL's hostname instead. No author line |
| Date | `created_at` | "Saved {date}" |
| Reading time | None | Dropped (Brian, September 10) |
| Lead | `tldr` | Serif lead in the Summary view |
| Summary body | `summary_markdown` (2–6 paragraphs) | Rendered Markdown below the lead |
| Numbered key points | None | Dropped. Not generated by the summarizer |
| Novelty text | `novelty_verdict`, `similarity` | Verdict label plus a fixed sentence; see [novelty](#novelty) |
| Tags | `tags` | Buttons that open the library filtered by tag |
| Keywords, people, organizations | `keywords`, `people`, `orgs` | Details disclosure |
| Connection | `connections[]` `{id, reason}` plus target | Card; see [relationship targets](#relationship-targets) |
| Tension | `tensions[]` `{id, kind, reason, computed_at}` plus target | Card with the existing kind labels (Contradicts, Supersedes, Superseded by, Qualifies, Qualified by) |
| Connections date | `connections_computed_at` | Muted line under the Connections heading |
| Source | `GET /api/readings/:id/content` (extracted Markdown) | Source view; see [source content](#source-content) |
| Processing steps | `active_attempt.stage` | Coarse label only; see the refresh contract |

Adding a written novelty explanation or key points would change the summarizer
schema, the Anthropic cached prefix and its snapshot tests, and require a paid
reprocess to backfill. That is outside Phase 2 and would need its own issue.

### Novelty

Show for ready readings only. Label and sentence:

- **Novel**: "Nothing already in your library covers this closely."
- **Familiar**: "Overlaps with readings already in your library." Links to the
  connections when there are any.
- **Duplicate**: "Effectively the same piece as one already in your library."
- `similarity.count = 0`: replace the sentence with "Your library had no close
  readings when this was processed."
- No verdict (older manifests): omit the panel. Never show "unclassified".

Similarity numbers (`count`, `max`, `mean`, `computed_at`) go in Details, not the
panel.

### Relationship targets

Approved September 10, 2026. `GET /api/readings/:id` adds a response-only map of
the reading's connection and tension targets, built from the same tenant's
reading rows. Proposed shape, final name in the Phase 3 PR:

```json
"relationship_targets": {
  "rd_abc": { "url": "https://…", "title": "…", "status": "ready" }
}
```

- An id missing from the map is removed or unavailable. Render the removed card.
- Stored manifests and their schema do not change. The map is computed on read,
  with one tenant-scoped query for the target rows and no claims or repairs.
- Keep `src/schemas/`, `docs/openapi.yaml`, and tests in sync.
- MCP reading output is unchanged. The `get_reading` tool in `src/mcp/tools.ts`
  spreads the whole `GET /api/readings/:id` response into its result, so it must
  strip `relationship_targets` explicitly, with a test (Brian, September 10).

### Routes and navigation state

- URL state: `/?q=&tag=&offset=` for the library and `?view=source` for the
  reading. Everything else stays out of the URL.
- Switching Summary and Source replaces the history entry, so Back leaves the
  reading instead of toggling views. Reload and deep links keep the view.
- Scroll: TanStack Router scroll restoration. Back and Forward restore the
  previous position. A new navigation to a reading starts at the top.
- "Back to library" returns to the library URL the reader came from (router
  history state), else `/`.
- Connection trail: kept in router history state, at most 10 hops, each with the
  previous reading's id, title, and the relationship reason. It shows the previous
  title and reason above the destination and "Back to {title}". Browser Back does
  the same. A reload or shared link drops the trail and keeps the reading.
- Save: navigation item "Save reading" opens `/save`. A 202 navigates to the
  reading, which shows its status. The URL/Markdown tab is remembered for the
  browser tab's session, not in the URL.
- Pending and failed readings use the reading URL. There is no separate status
  route.

### Reading surface

Order in the reading column: title, metadata line (hostname, saved date,
"Imported Markdown" when applicable), tags, status card
when active or failed, Summary/Source tabs, view content, novelty panel, then
Details. Actions (Reprocess, Open original URL) sit in the heading row; on phones
they move below the metadata.

Details is one collapsed disclosure holding keywords, people, organizations,
similarity numbers, "Open as file" for extracted and raw content, attempts, and
diagnostics. Diagnostics load only when opened.

Reprocessing a ready reading asks for confirmation: it costs a paid run and
replaces captured content. Failed readings retry without a prompt.

### Source content

- Fetch the Source view on demand, not during the server render, so SSR payloads
  stay bounded. Show loading and failure inside the view.
- Render Markdown without raw HTML, through a sanitizer. Demote source headings
  one level below the reading title.
- Links open in a new tab with `rel="noopener noreferrer nofollow"`.
- Do not load remote images automatically, so image hosts don't learn what is
  being read. Render each as a placeholder showing its alt text and host, with a
  "Load image" button that loads that image in place. Only `http:` and `https:`
  image URLs can load, with `referrerpolicy="no-referrer"`. The frontend's
  content-security policy must allow remote `https:` images for this.
- Code blocks and tables scroll horizontally in their own container. Long unbroken
  text uses `overflow-wrap: anywhere`.
- Readable width: 68ch for the lead, summary, and source.
- Very long titles wrap; they are never truncated on the reading page.

### Themes and contrast

Preference is System (default), Light, or Dark, stored in a first-party cookie so
the server render sets the theme without a flash. The control lives in the
navigation. The cookie carries no identity.

Contrast of the captured tokens (WCAG 2.2):

| Pair | Light | Dark |
| --- | --- | --- |
| `--ink` on `--bg`/`--surface` | 12.5 / 13.5 | 13.9 / 12.5 |
| `--muted` on `--bg`/`--surface`/`--soft` | **4.42** / 4.79 / **4.01** | 7.1 / 6.4 / 5.8 |
| `--accent` on `--bg` | 6.2 | 8.3 |
| `--positive` on `--bg`/`--soft` | 4.50 / **4.08** | 9.4 / 7.6 |
| `--border` on `--bg` | 1.28 | 1.55 |

Adopted September 10, 2026 (Brian): light `--muted` `#6c5e50` (5.2 on bg,
4.75 on soft) and `--positive` `#356b56` (5.2 on bg, 4.7 on soft), plus a
`--control-border` for inputs and toggles that meets 3:1: light `#948069`
(3.2 on bg), dark `#857869` (3.9 on bg). `--border` stays for decorative dividers.
The [color tokens](#color-tokens) table carries the adopted values; the
prototype's Proposed palette switch shows them.

### Spacing and controls

Spacing uses a 4 px base: 4, 8, 12, 16, 20, 24, 28, 36. The captured values in
the layout table map onto it. Controls:

- Primary button: accent fill; secondary: control-border outline; quiet: text.
- Minimum target 24 × 24 CSS px everywhere; 44 px tall for primary actions and
  navigation items at container width ≤650 px.
- Inputs use 16 px text on phones to prevent browser zoom.
- Disabled controls keep their label and explain why nearby when not obvious.

### Components

| Component | States |
| --- | --- |
| Navigation | Active item; account menu (email, Account, Sign out); theme control; compact bar at ≤650 px |
| Reading card | Ready, pending, failed, reprocess failed; long title; tag buttons |
| Filter bar | Search draft, active tag, clear controls |
| Pager | First page, middle, last (`has_more = false`) |
| View tabs | Summary, Source; source unavailable |
| Novelty panel | Three verdicts, sparse archive |
| Relationship card | Connection, tension (danger rule and kind label), removed (dashed), non-ready target |
| Return trail | One hop, several hops, arrival at a removed target |
| Status card | Pending with stage, watch stopped, couldn't check, ready, failed with category |
| Details disclosure | Collapsed, open, diagnostics loading and failed |
| Capture form | URL; Markdown with source URL, optional title, Markdown text; field errors |
| Confirm dialog | Reprocess, account deletion (typed confirmation) |
| Empty and error states | Every row in the acceptance matrix's common states |
| Notice | Degraded YouTube, imported Markdown, offline |

### Keyboard, focus, and motion

- Skip link to main content as the first focusable element.
- After a route change, focus the page heading (`tabindex="-1"`) so screen
  readers announce the new page.
- Tabs follow the ARIA tabs pattern: arrows, Home, End; the panel is focusable.
- Phone "Connections & tensions" jump moves focus to that section's heading;
  "Back to the reading" returns focus to the jump link.
- Status outcomes are announced in a polite live region. Focus does not move.
- Dialogs are modal `<dialog>` elements; focus returns to the opening control.
- Smooth scrolling only under `prefers-reduced-motion: no-preference`.
- Key-point numbers are gone, so the narrow-screen number rule no longer applies.
- Verify at 390 px, each breakpoint, 1440 px, and 200% and 400% zoom (320 CSS px
  reflow, no page-level horizontal scroll).

### Implementation slices

Sizes are relative (S under a day, M a few days, L about a week) and assume the
decisions above. They are for Brian to adjust, not commitments.

| Phase | Slice | Size |
| --- | --- | --- |
| 3 (#338) | Backend `relationship_targets` enrichment, schema, OpenAPI, tests | S |
| 3 | Backend read-only frontend entrypoint ([ADR 0003](../../decisions/0003-frontend-worker-topology.md)) with 401 and cross-tenant tests | S |
| 3 | TanStack Start app in `app/` on its own Worker, identity, service binding, cache rules, Node 22 CI | L |
| 3 | Sign-in, both verify links, return paths, sign-out, expired session | M |
| 3 | Tokens, themes, navigation, and the reading summary view with SSR | M |
| 3 | Novelty panel, relationship cards, removed targets, return trail | M |
| 3 | Source view with sanitizer and rich-content handling | M |
| 4 (#339) | `next.readinglite.ai` host: allowlist entry, routes, precedence smoke check (retired after cutover, reading-lite-gh335.2) | S |
| 4 | Library search, tags, pagination, return state | M |
| 4 | `/save` URL and Markdown capture with intake outcomes | M |
| 4 | Status refresh contract and failure categories | M |
| 4 | Reprocess, import a copy, Details and diagnostics | S |
| 5 (#340) | Account page parity: sessions, tokens, email, notifications, digests | L |
| 5 | Staging and production cutover, rollback rehearsal, release chain | M |
| 5 | Account deletion UI | S |

## Still open

- Provider/model support, key validation/replacement/removal, billing
  disclosure, queued-job behavior, and hosting limits, before BYOK (Phase 6).
- Archive export design (Phase 6).
- Whether sign-in is allowed during the account-deletion grace period (Phase 5).

The [implementation checklist](implementation-checklist.md) keeps these visible.
