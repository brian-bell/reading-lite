# Connected design specification

Status: captured design baseline, September 9, 2026. See the [frozen source and
reproduction instructions](README.md). This records the prototype Brian liked;
it does not claim approval of every state or completion of the Phase 2 design.

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
[shared styles](../../../web/prototypes/interface-directions/styles.css),
[Connected layout rules](../../../web/prototypes/interface-directions/ui.css),
and [dedicated frame rules](../../../web/prototypes/connected/styles.css).
System font differences can change wrapping. An earlier rough edge — key-point
numbers such as “01” wrapping onto two lines on narrow phones — is fixed
(`white-space: nowrap` on the number); screenshots captured before
September 10 may still show it.

## Color tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f1eadd` | `#211e1b` | Page, with a faint tiled paper grain |
| `--surface` | `#f8f3e9` | `#2a2623` | Cards/navigation |
| `--ink` | `#2c2620` | `#f0eae1` | Main text |
| `--muted` | `#78695a` | `#b3a89b` | Secondary text |
| `--border` | `#dccfbd` | `#443d36` | Dividers |
| `--soft` | `#e9dfcf` | `#332e29` | Secondary fills |
| `--accent` | `#4e4aa2` | `#b6b1ee` | Actions/selection |
| `--accent-soft` | `#e9e2ec` | `#36324a` | Connections/novelty |
| `--danger` | `#a34133` | `#edac91` | Failure/tension rule |
| `--positive` | `#3c755f` | `#91d0b2` | Ready/success |
| `--card-shadow` | warm `rgba(84, 62, 36)` at 5–7% | black at 25–28% | Library cards, forms, status cards |

Warm revision, September 9/10, 2026: the palette moved from cool blue-grey to parchment and cream in light mode (no pure white surfaces remain) and warm charcoal in dark mode, the page and novelty panel carry a low-opacity SVG grain, cards take a faint warm shadow, and the lead and source paragraphs use Charter, Iowan Old Style, Palatino, then Georgia. The September 10 screenshots reflect this revision.

Ink-on-paper revision, September 10, 2026: all reading matter — reading and
page titles, library card titles, relationship titles, and content headings —
moved to the same Charter/serif stack at weight 400, leaving Inter for UI
chrome (navigation, badges, labels, controls). Relationship cards changed from
filled accent-soft blocks to paper cards with a hairline border and an
accent-ink left rule (danger ink for tensions) on a transparent context panel,
and card hovers replaced the global brightness filter with a border/title
color shift toward accent. Screenshots predate this revision.

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
| Save URL | Validate HTTP(S) URL; create pending fixture and show status | Real intake must handle existing/initializing/conflicting owners and quotas |
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

## Still open

- Complete account/authentication, loading, empty archive, session expiry,
  permission, offline, deletion, and export designs; see the checklist.
- Define bounded status refresh interval, duration/backoff, terminal conditions,
  background-tab behavior, manual fallback, and auth/error stopping behavior.
- Define scroll restoration, keyboard focus after jumps, reduced motion, source
  rendering for rich/very long content, and a narrow-screen number layout.
- Confirm provider/model support, key validation/replacement/removal, billing
  disclosure, queued-job behavior, and hosting limits before BYOK implementation.
- Inventory all current URLs/actions against the replacement application and
  reconcile old product-document framework wording with issue #335.

Capturing these artifacts does not resolve those decisions. The
[implementation checklist](implementation-checklist.md) keeps them visible.
