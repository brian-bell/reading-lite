# reading-lite — Product Scope Document

> v1.0 · 2026-08-15 · Companion to the [portfolio strategy](https://claude.ai/code/artifact/cf7e942c-9a9a-4880-897e-c89c25e361c6) and the [reading-lite product brief](https://claude.ai/code/artifact/a1af4c2c-63fe-4ab5-8168-f05552ea5643). The brief argues *why*; this document defines *what*, *in what order*, and *what "done" means*.

---

## 0. How to read this document

Part I is the research context — condensed, so this document stands alone in six months. Part II is the scope proper: eight workstreams (WS-A through WS-H), each with goal, in/out, deliverables, acceptance criteria, effort, and dependencies. Part III sequences them into the roadmap, sizes the hours, and records the open decisions — including the repo-visibility recommendation.

Effort scale: **S** ≤ 1 focused week · **M** 2–4 weeks · **L** 5–12 weeks, at ~8–10 build hours/week.

---

# Part I — Research Context

## 1. Where this came from

A portfolio-wide review (three codebase surveys over ~15 repos, four market-research streams, a fifth on capture and integrations, two interview rounds, a critic-gated brief) concluded that reading-lite is the strongest revenue candidate in the portfolio: the only deployed product, the only one with an unclaimed market differentiator, and the only one with measured unit economics. Everything else became either a gated bet (MegaClock), an audience engine (Approach + weekly writing), or an explicit non-goal.

Decisions already made and not relitigated here: hybrid pricing; **straight to multi-tenant** (no single-tenant-instances stopgap); a six-month rewrite moratorium; the TypeScript/Cloudflare Workers codebase is the shipping base (the Go rewrite stays parked).

## 2. The product today

Deployed at `readinglite.ai` (also `readinglite.app`; `reading-lite.bbell.dev` retained for compatibility/rollback), daily personal use, 331 readings ingested (321 ready). Pipeline:

```
POST /api/readings {url}
  → dedupe (index/by-url/{sha256})
  → queue (READING_JOBS)
  → fetch + extract (readability/turndown; special paths: reddit, youtube)
  → embed (text-embedding-3-small)
  → Vectorize top-K similar prior readings
  → summarize with structured output:
      TL;DR · summary · tags · entities · CONNECTIONS to prior readings · NOVELTY VERDICT
  → embed TL;DR → upsert Vectorize
  → R2 manifest (readings/YYYY/MM/…) + list index (compare-and-set)
  → email digest (Resend)
SPA (React 19 / Vite / TanStack Query / react-router): list · search · tags · detail
```

Code facts that shape the scope (from `src/`): a single shared bearer token in `middleware.ts`; flat global R2 keys in `stores/reading-store.ts` and `stores/list-index.ts`; one unfiltered Vectorize index in `stores/similarity-store.ts`; provider abstraction already exists (`modules/openai-summarizer`, `modules/anthropic`, `modules/summarizer/config.ts`); the SPA is a single 709-line `App.tsx` with a 537-line stylesheet. Test discipline is strong (102 test files, DLQ recovery, CAS on the index, 429→queue-retry). Cost per reading, measured from checked-in comparison runs: **$0.0542** at production settings; batch pricing (queue-async qualifies) → **~$0.028**.

## 3. What the market research established

**Category.** Read-later is alive but paid-prosumer-only. Pocket (20M+ registered users) died July 2025; Omnivore died November 2024 with two weeks' notice before deleting data. Survivors charge $28/yr (Raindrop) → $60–120/yr (Instapaper, Matter, Readwise) → $456/yr (Recall Max). Readwise Reader at $9.99–12.99/mo is the kill zone; the loudest complaint is "more machine than I need."

**Differentiator.** No surveyed product writes a cross-reference narrative at ingest or issues a novelty verdict. Nearest neighbors: Recall (visual graph; $38/mo tier for bulk connecting — proof the *job* is paid for), Trelk (graph + daily briefing, iOS-only), Sublime (related-ideas at save), Saner.AI (exact-duplicate warning only), Readwise (highlight-triggered surfacing). Medium confidence — absence after targeted search.

**Pain.** Platform-death trauma (Pocket HN thread: 1,222 points, dominant sentiment = distrust of cloud read-later); the bookmark graveyard ("where my good intentions go to die"; users exporting 32,000 unread saves); retrieval failure; Readwise price/complexity; a real but nascent hunger for synthesis over one-off summaries. A vocal minimalist segment rejects AI features — not our user.

**Willingness to pay.** ~$5–6/mo sellable to Readwise-curious users; $10 = kill zone; the HN/self-host segment refuses subscriptions outright ("I just don't try things out if needing a subscription is an inevitability") → the BYO-key tier.

**Distribution.** Comparison/alternative SEO is the category's revealed-preference channel (every survivor runs "Pocket alternative" pages; the category kills an app yearly, and each funeral is a capture event). Commercial-intent pages survived AI search (~31% zero-click vs ~74% informational). Show HN is a spike, not a channel (Readwise Reader: 326 points). Obsidian's plugin directory is Readwise's quiet distribution engine. Product Hunt: badge only (0.1% conversion anecdotes).

**Capture (follow-up research).** Extension-side capture of the rendered DOM from the user's own session is the category standard for paywalled and bot-blocked content — Readwise's docs say so explicitly; Instapaper ships "Logged-In Sites"; Karakeep integrates SingleFile. Reddit and X are auth walls unreachable by any cloud fetcher regardless of IP; Reddit is suing scrapers (Oct 2025). Cloudflare Browser Run: $0.09/browser-hour, 10 hours/month included on Workers Paid → ~$0.0001–0.0005/page for JS-heavy pages. Consumer "computer in the cloud" products (Grok Bot, launched 2026-08-11 at $120–300/mo tiers; ChatGPT agent mode) are general agents subsidized by VC/enterprise money — not a thing to build solo.

**Integrations (follow-up research).** MCP is now table stakes in the category: Recall ships "API and MCP access" on its free tier; Readwise has an official MCP server ("Give your AI access to everything you've read"); Karakeep and Raindrop both ship official servers. Nobody exposes a novelty check as an agent tool. Hermes Agent: MCP first-class (Streamable HTTP + OAuth 2.1). OpenClaw: skills (AgentSkills spec, ClawHub registry) are native; MCP via bridges. Grok Bot itself exposes no connector surface; Grok-the-assistant supports bring-your-own MCP. The consumer positioning "memory layer for your AI agents" is unclaimed — the phrase belongs to dev-infra (Mem0, Supermemory — which *started as a bookmarks app* and pivoted).

**Design.** The category has a design-premium lane (GoodLinks, Matter); the buyer stares at typography for hours; the current SPA is agent-generated and reads as such — a conversion risk on a strong pipeline.

---

# Part II — Scope

## 4. Product definition

**One-line:** A read-it-later that remembers what you know — every save gets a written account of how it connects to what you've already read, and a verdict on whether it's new to you.

**Positioning:** *reading memory*, not read-later. Permanence (guaranteed export, your data outlives us) is a headline feature, not a settings item.

**Personas.** Primary — the Readwise-curious prosumer: 20–100+ saves/month, keeps a PKM (Obsidian/Notion), feels the graveyard guilt, finds $120/yr too much machine. Secondary — the subscription-averse HN/self-host reader, served by BYO-key against free Karakeep on "zero ops + smarter than tagging."

**Non-goals for v1** (explicit, so they stay out): mobile apps; RSS/newsletter ingestion; highlights; TTS; team/sharing features; public archives; a "computer in the cloud"; credential vaults for publisher logins; the Go rewrite.

## 5. Workstreams

### WS-A · Multi-tenant core `L · 8–12 weeks · critical path`

**Goal.** Serve many users from one deployment with strict data isolation and hostile-user safety.

**Architecture decision:** [ADR 0001 · Tenant control plane](../decisions/0001-tenant-control-plane.md).

**In scope**
- **Accounts & auth.** Magic-link email auth (Resend already integrated); session cookies for the SPA; scoped API tokens for programmatic access (the MCP server and skills in WS-E depend on these); token revocation.
- **Tenancy in storage.** R2 keys re-prefixed `u/{user_id}/…` across `reading-store.ts`, `list-index.ts`, and the by-url/by-id indexes; migration script for the existing 331-reading corpus into the founder's tenant; per-user list index with the existing CAS semantics preserved.
- **Tenancy in similarity.** Vectorize per-user metadata filter on every query and upsert in `similarity-store.ts` — connections and novelty verdicts must only ever cite the requesting user's readings.
- **Dedup policy (a decision, made here).** Extraction cache of *public* URLs may stay global (raw + markdown, keyed by URL hash — cost saver, no user data). Summaries, connections, similarity, and manifests are strictly per-user. A user re-saving a URL another user saved gets a fresh, private synthesis against *their* corpus.
- **Per-user notification.** `EMAIL_TO` becomes a per-user setting; digest opt-in/out; per-user digest cadence.
- **Fetch hardening (SSRF).** Deny private/link-local/metadata IP ranges after DNS resolution; scheme allowlist; redirect-chain re-validation; size and time limits on fetch; drop the `extract-agent` (logged-in-Chrome) path from the hosted product entirely.
- **Rate limits & abuse.** Per-user submission rate limits; per-user and global concurrency caps in the queue consumer; hard per-user daily LLM spend ceiling and a global kill switch; the bulk importer gated behind the import economics in WS-B.
- **Legal surface.** ToS, privacy policy, DMCA contact page, private-by-default archives, account deletion that actually deletes (R2 prefix + Vectorize + index).

**Out of scope.** OAuth social login (magic link is enough); teams/orgs; public sharing.

**Acceptance criteria**
- Two test users cannot observe each other's readings, manifests, similarity results, or connections under any API path (integration test suite asserts this).
- The founder's corpus migrates with zero lost readings and connections still resolving.
- SSRF test suite passes (private ranges, redirects to private ranges, DNS rebinding case).
- Deleting an account leaves no R2 objects, Vectorize vectors, or index entries.
- Spend ceiling demonstrably stops processing at the cap in staging.

**Depends on:** nothing. **Blocks:** WS-B, WS-C (hosted parts), WS-E, WS-F.

---

### WS-B · Billing, metering & import economics `M`

**Goal.** Charge money, meter usage, and make migrations affordable by design.

**In scope**
- **Merchant of record.** Paddle or Lemon Squeezy (handles global tax; ~5–10% + 50¢); webhook → entitlement state; customer portal for cancel/upgrade.
- **Tiers.** Hosted **$6/mo or $60/yr**, 100 readings/month included, overage credit packs $3/50 (reprice to $3/25 if the interactive fallback is active). BYO-API-key **$24/yr** — user supplies OpenAI/Anthropic key (stored encrypted, never logged), our pipeline + storage. **Trial:** 14-day full trial that *begins with archive import*, so verdicts fire against real history from the first save.
- **Metering.** Per-reading meter events written at summarization time; monthly quota reset; soft warning at 80%, hard stop at 100% with clear UI; usage visible in settings.
- **Import economics.** Imported archives (Pocket CSV, Omnivore JSON, Instapaper CSV, Readwise export, plain URL lists) are backfilled **embeddings-only** (<$0.001/item; a 5,000-item Pocket export ≈ $4) — items become searchable and usable as connection targets immediately; synthesis applies to new readings; retroactive synthesis via credit packs or the BYO tier. This is what makes the migration funnels in WS-G affordable.
- **Batch mode.** Route summarization through provider batch APIs where the queue can tolerate latency (target: default on; own the "connections may take a few hours" behavior in the UI and digest). Operational trigger to drop to interactive + 60-reading cap: p90 time-to-summary > ~4 hours, or beta pushback.

**Acceptance criteria**
- A test purchase (sandbox) flips entitlement; cancellation flips it back; webhooks are idempotent.
- Metering matches summarizer calls 1:1 in tests; quota stop is enforced server-side.
- 1,000-item import completes embeddings-only within the cost envelope and surfaces in search.
- Margins hold at cap in both batch and fallback modes per the brief's ledger (43% / positive).

**Depends on:** WS-A. **Blocks:** launch (WS-H).

---

### WS-C · Capture-reliability ladder `S + S + M`

**Goal.** Reliable capture across content types without ever operating a cloud computer or holding publisher credentials.

| Rung | What | Effort | Phase |
|---|---|---|---|
| **R0** | Worker fetch (exists) — keep; add structured failure reasons (`blocked`, `thin`, `timeout`, `paywall-suspected`) surfaced to the user | S | Beta |
| **R1** | **Cloudflare Browser Run fallback** — auto-triggered when extraction is thin (<100 words, or readability confidence low, or known JS-heavy host); render → extract → same pipeline; per-user cap on fallback minutes; cost logged per reading | S | Beta |
| **R2a** | **Bookmarklet** — POSTs the rendered DOM (or a SingleFile-style snapshot) from the user's own tab, authenticated by session; the fix for paywalls and auth-walled sites (Reddit, X) | S | Beta |
| **R2b** | **Email-in save address** — per-user inbound address (Resend inbound; new configuration, not the existing outbound digest); URL or forwarded newsletter → pipeline | S | Beta |
| **R2c** | **MV3 browser extension** (Chrome + Firefox) — one-click save of rendered DOM with the user's cookies; shows the novelty verdict inline when it arrives; store listings are also distribution surfaces | M | Launch window → H1 |
| **R3** | ✕ **Rejected:** hosted "computer in the cloud" capture; Instapaper-style credential vault. Revisit only if a stealth-fetch tier proves necessary, and then rent (Browserbase-class), never build. | — | — |

**Acceptance criteria**
- Fixture suite of ≥20 real hard URLs (JS-heavy, paywalled-with-session, Reddit, X, PDF, YouTube) with per-rung expected outcomes; R1 raises success on JS-heavy fixtures; R2 succeeds where the user's session has access.
- Failure states are legible to the user (what happened, which rung to try) — no silent "failed."
- Browser Run spend per user is capped and visible in ops metrics.

**Depends on:** R0/R1 none; R2 needs WS-A sessions. **Blocks:** nothing hard; raises beta satisfaction.

---

### WS-D · Frontend design & build `M design + M–L build`

**Goal.** Replace the agent-generated single-file SPA with a designed, componentized product UI whose three converting surfaces meet a "credible and calm" bar.

**In scope**
- **Design phase (M).** Design brief; references (Reader's information density, GoodLinks' restraint); type scale, spacing, and color tokens with full light/dark; the three converting surfaces designed first — **reading/detail view** (the connections narrative and verdict are the hero of the page), **digest email**, **landing page** (highest-stakes single artifact; carries the launch); then list/search, import, settings, onboarding, and the empty-state that explains why verdicts need history. Optional and recommended: a one-off professional design pass on those three surfaces — the only pre-revenue cash spend endorsed.
- **Build phase (M–L).** Decompose `App.tsx` into routed pages and a component library (keep React 19 / Vite / TanStack Query — no framework churn under the moratorium); design tokens as CSS custom properties; accessibility baseline (keyboard, focus, contrast, reduced motion); responsive to phone widths (reading on mobile web is in scope; native apps are not); onboarding flow: import → first save → first verdict; settings for tokens, digest, BYO key, billing portal; import UI with progress; usage meter.
- **Instrumentation.** Privacy-respecting product analytics on the funnel that matters: landing → trial → first import → first save → first verdict viewed → paid.

**Out of scope.** Native apps; theming beyond light/dark; a marketing CMS.

**Acceptance criteria**
- The three converting surfaces reviewed against the design brief and signed off; landing page passes a "would I pay this person $6" gut check from ≥3 beta users.
- Lighthouse a11y ≥ 95 on the main routes; keyboard-only path through save → detail works.
- Component tests replace the current monolithic `App.test.tsx`; visual regression on the detail view.

**Depends on:** design phase can start immediately (parallel to WS-A); build needs WS-A's auth for real flows. **Blocks:** launch quality.

---

### WS-E · Agent-integration pack `M · post-beta`

**Goal.** Make reading-lite the reading-memory layer for the user's AI agents — with the differentiator exposed as tools.

**In scope**
- **REST API hardening** (exists; add: OpenAPI spec, scoped tokens from WS-A, pagination, rate limits).
- **Hosted MCP server** (Streamable HTTP + OAuth 2.1, Workers-native): tools `save_reading(url)`, `search_readings(query)`, `get_reading(id)`, `what_do_i_know_about(topic)` (returns synthesized prior context + citations), `is_this_new_to_me(url)` (runs the novelty check without necessarily saving — the tool nobody else ships), `list_recent_connections()`. Consumable by Hermes (first-class), Claude, Cursor, Grok-the-assistant (BYO MCP).
- **AgentSkills-spec `SKILL.md`** wrapping the REST/MCP for OpenClaw's native path; published to ClawHub and Hermes' Skills Hub; the founder is the first user (self-hosts both).
- **Obsidian community plugin** (sync readings + connections into a vault; frontmatter format shipped in WS-F).
- **Positioning work.** A "for your agents" page; the launch narrative gains "your agents can ask what you already know."

**Out of scope.** Grok Bot native integration (no surface exists); Zapier/Make connectors (later, if demanded).

**Acceptance criteria**
- Hermes and Claude can save, search, and run `is_this_new_to_me` end-to-end against a test tenant using scoped tokens; tokens are revocable.
- ClawHub skill installs and works on a fresh OpenClaw; skill listed.
- MCP tools respect tenancy and metering (a save via MCP meters exactly like a save via UI).

**Depends on:** WS-A (scoped tokens), WS-B (metering). **Blocks:** nothing; multiplier.

---

### WS-F · Permanence pack `S–M`

**Goal.** Make "your archive outlives us" true and provable on day one.

**In scope**
- One-click full-archive export: markdown per reading (Obsidian-compatible frontmatter: title, url, saved_at, tags, entities, verdict, connections as wikilinks/URLs) + JSON manifests + raw originals — streamed as a zip from the R2 originals.
- Scheduled auto-export (weekly zip to email link or user-provided S3/R2 bucket).
- Published guarantee page: what we store, what you get out, and the commitment that shutdown means ≥90 days of export access.
- Import symmetric to export (round-trips).

**Acceptance criteria**
- Export of the founder corpus round-trips through import with zero loss; frontmatter opens cleanly in Obsidian.
- Guarantee page live before beta invites go out.

**Depends on:** WS-A. **Blocks:** beta.

---

### WS-G · Growth engine `M · ongoing`

**Goal.** A compounding acquisition asset that a no-audience solo dev can run inside 3–4 hours/week.

**In scope**
- **Product name + domain** (separate from bbell.dev, which remains the author/content brand); waitlist page with a demo of connections and the verdict on a canned sample corpus (verdicts on an empty archive are meaningless — the demo must show history).
- **Comparison/alternative SEO pages** — target 5–8 by launch at ~2/month: "Pocket alternative (2026)", "Readwise Reader alternatives", "Instapaper vs [product]", "Omnivore alternative", "best read-it-later with AI connections", "read-it-later with guaranteed export"; each import tool gets its own landing page. Repeat at every future competitor shutdown.
- **Weekly writing** on bbell.dev (rotation: agent-workflow deep-dives / build-in-public on this productization incl. costs-and-revenue transparency / the comparison pages), syndicated to X; substantive pieces to HN.
- **Community.** r/PKM, r/ObsidianMD, MPU forum — participate honestly, recruit beta users from "Readwise alternatives" threads.
- **Launch (WS-H) content:** Show HN post — *"I built a reading archive that tells you when you've read this before"* — with the verdict demo; r/PKM + r/ObsidianMD posts; Product Hunt for the badge.

**Acceptance criteria**
- Waitlist live by Sep 15; ≥2 SEO pages indexed by Oct 1; 5–8 by launch.
- 10–20 beta users recruited from the target communities.

**Depends on:** nothing (starts now). **Blocks:** launch.

---

### WS-H · Launch & operations `S`

**Goal.** Ship, then run it like a product.

**In scope.** Status page; error alerting on DLQ depth, queue lag, spend, fallback-minute burn; support inbox and a public changelog; on-call expectations for a solo operator (batch latency, provider outages); backups of R2 + Vectorize metadata; a runbook for provider-key rotation, spend-ceiling trip, and account-deletion requests.

**Acceptance criteria.** Alerts fire in a staging drill; runbook exercised once; first 25 paying customers.

---

## 6. Requirements that cut across every workstream

- **Isolation is a property, not a feature.** Every new code path is tenant-scoped by construction; the isolation test suite is a merge gate.
- **Cost is metered at the source.** Every LLM and Browser Run call writes a meter event with user, purpose, tokens/minutes, and cost.
- **The differentiator stays the hero.** UI, email, MCP tools, and marketing all lead with connections + verdict.
- **Moratorium applies inside the project.** No framework migrations, no Go rewrite, no speculative abstractions; integrations are post-beta multipliers.

---

# Part III — Sequencing, sizing, decisions

## 7. Roadmap

| Phase | Window | Workstreams active | Exit criteria |
|---|---|---|---|
| **0 · Seeds** | Aug 15 – Sep 15 | WS-G (name, domain, waitlist, first 2 SEO pages, cadence); **WS-D design phase starts** (parallel, low-hours) | Waitlist live; design brief + tokens drafted |
| **1 · Build** | Sep – Nov | **WS-A** (critical path) → WS-B; WS-D design continues; WS-C R0/R1 in a spare week if any | Beta invite-ready; billing in sandbox |
| **2 · Beta** | Nov – Dec | WS-F; WS-C R1/R2a/R2b; **WS-D build** (three surfaces first); WS-B import tools; 10–20 users; pricing final | 3 testimonials; <5% pipeline failures; funnel instrumented |
| **3 · Launch** | Dec – Jan (Feb tolerated) | WS-H; WS-G launch content; paid tiers live | First 25 paying customers |
| **4 · Compound** | 2027 H1 | WS-E (MCP + skills + Obsidian plugin); WS-C R2c extension; WS-D remaining screens; WS-G to 15+ pages | 100–150 subscribers |

**Capacity honesty.** WS-A alone is 80–120 focused hours — essentially the entire Sep–Nov build budget at 8–10 h/week. Adding WS-D's build in the same window is not possible; that is why design *thinking* runs in parallel (cheap hours) and design *build* lands in beta on the three surfaces first. Explicit slip tolerance: 4–8 weeks; launch may move to Feb 2027 without changing strategy. If the waitlist is dead at ~6 weeks, the named downgrade is selling provisioned single-tenant instances (scripts largely exist) rather than sunk-costing the full build.

## 8. Effort summary

| Workstream | Effort | Phase |
|---|---|---|
| WS-A Multi-tenant core | L (8–12 wks) | 1 |
| WS-B Billing, metering, imports | M | 1–2 |
| WS-C Capture ladder | S+S+S+S, then M (extension) | 2 → 4 |
| WS-D Frontend design & build | M design ∥ M–L build | 0–2 → 4 |
| WS-E Agent-integration pack | M | 4 |
| WS-F Permanence pack | S–M | 2 |
| WS-G Growth engine | M ongoing (3–4 h/wk) | 0 → ∞ |
| WS-H Launch & ops | S | 3 |

## 9. Repo visibility — recommendation: **make it private now**

**Facts (checked 2026-08-15).** `brian-bell/reading-lite` is public, MIT-licensed, 0 stars / 0 forks / 0 watchers; `package.json` is already `"private": true`; no releases; git history contains no API keys or token literals (scanned); the only personal datum ever committed is the founder's email in an old `wrangler.toml` `EMAIL_TO` (cosmetic, and blank on the current branch); tracked config files are examples and infra bindings, not secrets. Nobody depends on this repo.

**Why private, and why now.**
1. **The upcoming code is the business.** WS-A/B/E add tenancy logic, billing webhooks, spend controls, abuse heuristics, and marketing content — the parts a copycat wants and users don't need to read. Every survivor in the category is closed-source with open *integrations* (Readwise, Instapaper, Matter); the OSS read-later story is Omnivore's, and it ended in an acquihire and deletion. OSS is a strategy for the *tool* spaces in the portfolio (Approach), not for this SaaS.
2. **Zero cost today.** With no stars, forks, or dependents, flipping visibility strands nobody. Waiting until launch means the pre-launch commit history — with pricing experiments, security hardening, and abuse rules — is cloneable in the interim.
3. **License optics.** MIT + a paid SaaS is legal but muddled; a private repo removes the question. Publish an OSS *edge* instead: the MCP server, the SKILL.md, the import parsers, the export format spec — the integration surfaces that drive adoption and cost nothing to give away.

**Caveats to know.** History already fetched by anyone stays theirs (immaterial here — no watchers). Some GitHub-free features (Pages, unlimited Actions minutes) change on private repos; the project deploys via Wrangler, not Pages, and its CI is light. If you *want* a public "reading-lite" as a portfolio artifact, keep the old name public as an archived snapshot with a README pointing to the product, and do the product work in a new private repo under the product's name — cleaner than flipping a repo whose name is a working title anyway.

**Recommendation in one line:** make the current repo private today (or archive it public + start the product private under its real name), and plan a small OSS edge (MCP server + skill + parsers) for Phase 4.

## 10. Open decisions (owner: Brian)

- Product name and domain (blocks the waitlist — decide this week).
- Merchant of record: Paddle vs Lemon Squeezy (both fine; Paddle's posted fees are lower).
- Design pass: DIY sprint only, or DIY + a paid pass on the three surfaces.
- Batch-by-default: accept hours-of-latency connections as product behavior, or launch interactive with the 60-cap and add batch later.
- Repo: flip private in place vs archive-public + new private repo under the product name.

## 11. Sources

Consolidated in the [reading-lite product brief](https://claude.ai/code/artifact/a1af4c2c-63fe-4ab5-8168-f05552ea5643) and the [portfolio strategy](https://claude.ai/code/artifact/cf7e942c-9a9a-4880-897e-c89c25e361c6). Key primary sources: readwise.io/pricing and docs.readwise.io (saving-content); recall.it/pricing; instapaper.com/docs (paywall content, Logged-In Sites); docs.karakeep.app (SingleFile, MCP); developers.cloudflare.com/browser-run/pricing; hermes-agent.nousresearch.com/docs (MCP); docs.openclaw.ai/tools/skills; docs.x.ai (connectors, remote MCP); Grok Bot launch coverage 2026-08-11..14; HN threads 44063662 (Pocket), 44075451 (subscription fatigue), 46880866 (Ask HN 2026); Reddit v. Perplexity/Oxylabs (Oct 2025); the reading-lite repo (`src/`, `wrangler.toml`, `.summarizer-comparisons`).
