# Product Brief: Reading-Lite (flagship) + Portfolio Roadmap

> Generated: 2026-08-15 | Based on: codebase analysis of ~15 repos + 4-dimension market research (competitors, trends, pain points, distribution) | Decisions incorporated from two interview rounds with Brian | v1.1 same date: capture-reliability ladder, agent-integration pack (P10), and design workstream added after follow-up research on Brian's three challenges

## Executive Summary

Brian's portfolio contains one product with a genuinely unclaimed market differentiator: **reading-lite**, a deployed personal reading archive whose per-save written cross-reference narrative ("connections") is unmatched in the current read-later market, and whose novelty verdict (novel/familiar/duplicate) exceeds its nearest precedent — Saner.AI stops at an exact-duplicate warning, with no familiar/novel spectrum or written synthesis — even as adjacent products (Recall's $38/mo tier, Trelk, Sublime) prove users pay for the connections *job*. The market opening is real and time-stamped: Pocket (20M+ users) died July 2025 and Omnivore died November 2024, creating a displaced, distrustful population that the surviving category courts through comparison-SEO pages and migration funnels. The recommended move is to productize reading-lite as a multi-tenant "reading memory" SaaS with hybrid pricing ($6/mo hosted, metered + $24/yr BYO-API-key tier), launched with permanence positioning (guaranteed export + Obsidian integration) — while executing a kill-list/moratorium that stops the portfolio's documented pattern of rebuilding instead of shipping. Two smaller tracks ride along: a validation-gated MegaClock bet (one-time-purchase macOS app in a verified-open niche with thin demand evidence) and a draft-season ffb write-up that must happen within 2–3 weeks or not at all. Agent-tooling (Approach) stays free OSS and becomes the content flywheel: the research shows that layer is where paid products die (Terragon, Bloop/Vibe Kanban) but where audience compounds fastest.

## Current Product State

### What It Does

reading-lite (deployed at readinglite.ai; also readinglite.app; reading-lite.bbell.dev retained for compatibility/rollback; in daily personal use, 331 readings ingested — 321 ready, 10 failed): `POST /api/readings {url}` → dedupe by URL hash → queue → fetch + extract (readability/turndown) → embed (`text-embedding-3-small`) → query Vectorize for top-K similar prior readings → LLM summarization with structured output (TL;DR, summary, tags, entities, **connections to prior readings, novelty verdict**) → R2 manifest → email digest via Resend. SPA provides list, semantic search, tags, detail. The differentiator is implemented and working today, not aspirational: the summarizer sees your prior related readings and writes explicit cross-references plus a `novelty_verdict`.

Portfolio context (surveyed, dispositioned below): MegaClock (macOS clock-wall app, 5 of 7 milestones unbuilt, monetization plan already specced), AIUsageBar (done but structurally high-maintenance; launch declined — stays personal), Approach ecosystem (v0.10.2, Homebrew cask, releases every few days — the real product of the agent-tooling cluster), ffb (excellent engineering, non-viable market), plus session-tui/hank/grindstone/backflow (superseded prototypes → kill list).

### Target User

Primary: the **Readwise-curious prosumer** — heavy readers who save 20–100+ articles/month, already keep a PKM (Obsidian/Notion), feel the "bookmark graveyard" guilt, and find Readwise Reader's $9.99–12.99/mo "more machine than they need." Secondary: the subscription-averse HN/self-hosting crowd (served by the BYO-API-key tier, competing against free Karakeep on "zero ops + smarter than tagging"). Displaced Pocket/Omnivore users overlap both segments and are reachable through migration content.

### Technical Foundation

- **Stack**: TypeScript, Hono, Zod on Cloudflare Workers + R2 + Vectorize + Queues + Pages; OpenAI (default summarizer + embeddings), Anthropic optional; Resend email.
- **Architecture**: queue-driven pipeline Worker + SPA; staging/production environments with idempotent setup/teardown scripts.
- **Maturity signals**: 102 test files over ~5,900 LOC; dead-letter queue with recovery handler; R2 compare-and-set on index writes; 429→queue-retry backpressure; measured cost per reading ($0.0542 at production settings, from checked-in comparison runs).

### Strengths

- **Unclaimed differentiator, already built**: written cross-reference narrative + novelty verdict at ingest — competitor research found nothing equivalent (Recall = visual graph, Trelk = graph + daily briefing, Readwise = manual highlight-triggered surfacing).
- **Measured unit economics with levers**: ~$0.055/reading interactive (dominated by summarization; embeddings <$0.001), and the queue-async pipeline makes provider batch pricing (50% discount → ~$0.028/reading) a natural fit — the hosted tier specced below is margin-positive by construction even without that lever (Brian's own usage: ~80 readings/month).
- **Operationally careful pipeline** (DLQ, CAS, staleness overlay, retry semantics) — the hard 20% most solo SaaS launches lack.
- **Owner is the user**: 4 months of daily dogfooding; the product exists because the graveyard problem is real for its builder.

### Gaps

- **Single-tenant everywhere**: one shared bearer token; flat global R2 namespace; one Vectorize index with unfiltered top-K; `EMAIL_TO` hardcoded. Two structural cross-tenant leaks if naively multi-user: global URL dedup returns another user's manifest; global similarity would cite other users' readings inside the connections feature itself.
- **No commercial layer**: no accounts, billing, quotas, abuse controls, ToS/privacy, or landing page — true of every repo in the portfolio.
- **Unmetered LLM spend**: the checked-in bulk importer could burn a month's revenue in minutes if exposed; hard spend ceilings required.
- **SSRF surface**: the Worker fetches arbitrary user-supplied URLs server-side; needs hardening before hostile users exist.
- **Naming**: "reading-lite" is a working title on a personal subdomain; product name + domain needed before any public waitlist.

## Market Landscape

### Market Overview

No credible TAM exists for read-it-later; the honest proxies: Pocket had 20M+ registered users at death, Readwise is bootstrapped-profitable at $9.99–12.99/mo since ~2017, and the category re-fragmented after two shutdowns into ~15 players across three lanes (AI-native, self-hosted, design-premium). Pocket's death was a verdict on *free ad-scale* read-later, not on paid: multiple $28–456/yr products are visibly sustaining and shipping. Willingness-to-pay is proven; the money is prosumers paying for a workflow, not casual savers.

### Competitors

| Competitor | Positioning | Pricing | Key Strength | Key Weakness |
|------------|-------------|---------|--------------|--------------|
| Readwise Reader | "The power-reader's all-in-one app" + Ghostreader AI | $9.99/mo annual, $12.99 monthly; no free tier | Category leader; integration ecosystem (Obsidian); breadth (RSS/epub/TTS) | "Overpriced," bloated for casual users; connections are manual/highlight-triggered, no ingest-time synthesis |
| Recall | "Turn Your Knowledge Into Your Edge" | Free 10 summaries/mo; Plus $10/mo; Max $38/mo (bulk connect) | Auto knowledge graph + connection viz; proof users pay for connections | Connections are graph links, not written analysis; "not yet fully baked" (MPU forum); chat "poor results" |
| Trelk | "Read. Think. Connect ideas." | One-time purchase, on-device AI | Validates connections + daily synthesis thesis; no subscription | iOS-only, on-device model quality ceiling, new/unproven |
| Instapaper | Classic minimalist read-it-later | Free; Premium $5.99/mo / $59.99/yr | 15-year trust; Kobo default; Instapaper 10 momentum | Effectively zero AI (their roadmap lists summarization as *requested*) |
| Raindrop.io | "All-in-one bookmark manager" | Free generous; Pro $28/yr | Best free organizer; #1 Pocket-refugee destination | No reading intelligence at all; solo-dev sustainability question; anchors prices low |
| Karakeep (ex-Hoarder) | Self-hosted bookmark-everything + AI tagging | Free OSS (~28k stars) | The free/self-host default for technical users; local Ollama support | Per-item AI only (tags/summaries); self-host ops burden; memory-leak-class bugs at scale |
| Matter | "Save. Read. Grow." | ~$60–80/yr | Best-in-class TTS/audio; $9.15M raised | iOS+web only; no Android after 4 years of promises; no synthesis |
| GoodLinks | Native private Apple read-later | $9.99 one-time + feature-pack IAP | Proves one-time pricing demand on Apple platforms | Apple-only; per-article summaries only (v3.3) |

### Where We Lead

- **Ingest-time written synthesis + novelty verdict** — unique in the surveyed market (medium confidence: absence of evidence after targeted search; nearest neighbors do less: Recall = visual graph, Trelk = graph + daily briefing, Sublime = related-ideas surfacing at save, Saner.AI = duplicate warning, Readwise = manual highlight-triggered surfacing).
- **Cost discipline**: $0.055/reading measured vs. competitors bundling AI into $120–456/yr plans; room to price in the $5–6/mo band users say they'd pay — profitably, per the Pricing construction.
- **Permanence-ready architecture**: R2-stored raw + extracted markdown per reading makes "your archive outlives us, export anytime" implementable in days, not months.

### Where We Lag

- No mobile apps, no browser extension, no RSS/newsletter ingestion, no TTS, no highlights — Readwise/Matter breadth is years ahead.
- Zero brand, zero users beyond the builder, zero SEO authority; every competitor has a head start on distribution.
- Web-only capture (URL submission); competitors capture from share sheets, email, extensions.

### Market Trends Affecting Us

- **Browser-level AI summarization commoditized** (Chrome/Gemini, Safari/Apple Intelligence): single-doc summaries are worth ~$0 → *opportunity* for cross-document memory, which browsers can't do without your archive; *threat* to any per-article-summary pitch.
- **Two category shutdowns → permanence anxiety**: "will this app also die?" is now a stated purchase criterion (HN Pocket thread, 1,222 pts) → *opportunity*: guaranteed export + local-first messaging as price of admission.
- **Subscription fatigue in the exact demographic** (DoubleMemory Show HN comments) → *threat* to pure subscription; *opportunity* for the hybrid BYO-key tier.
- **AI-search killed generic blog SEO but not commercial-intent comparison pages** (~74% zero-click informational vs ~31% transactional) → the SEO plan must be comparison/alternative pages, not tutorials.

## User Pain Points in This Space

- **Platform-death trauma**: Pocket shutdown HN thread 1,222 pts/761 comments, dominant sentiment = distrust of cloud read-later; Omnivore gave ~2 weeks before deleting data — *addressed*: permanence positioning, day-one export, published data-outlives-us guarantee.
- **The bookmark graveyard**: "where my good intentions go to die" (Ask HN 2026); users with 32,000 unread saves; ~84% of saves never reopened — *addressed head-on*: the novelty verdict + connections narrative makes the archive answer back; this is the core product thesis and the marketing story.
- **Retrieval failure**: saved ≠ findable (Pocket search decay; MPU mymind complaints) — *addressed*: semantic search over embeddings is already built.
- **Readwise price/complexity**: $120/yr "buys more machine than most people need"; documented cancellation posts — *addressed*: a focused $6/mo alternative, well under the $10 kill zone.
- **Synthesis hunger, unmet**: MPU power user's dealbreakers were linking between saved items and retrieval; Recall's connections "not fully baked"; a 2025–26 product wave markets connection-finding but none dominant — *addressed*: this is the differentiator.
- **Counter-signal**: a vocal minimalist segment explicitly rejects AI features ("I don't need notes or AI summaries" — Ask HN OP) — *not our user*; do not chase.

## Proposed Features

Priority order reflects dependency and sequencing, not raw ICE (each component scored 1–10; ICE = I×C×E).

### Priority 1: Kill List & Rewrite Moratorium (portfolio hygiene)
- **What**: Archive backflow (idle since May; final commit was adding a license). Add LICENSE + "superseded by Approach" note to session-tui (currently unlicensed — legally unusable by anyone). Pick ONE name for hank/fbd/federated-beads, publish the finished artifact, stop. Grindstone: fold its concepts into Approach's future GUI; no separate product. AIUsageBar: stays personal (launch declined in interview). skilled: continues as the active hobby project — its v1 cask release is optional reputation work outside this roadmap's budget, and in no case a monetization attempt. backlite: keep as personal infra. Six-month rule: no rewrites of existing projects; new ideas get a landing page before code.
- **Why**: The portfolio's documented pattern — three skill managers, two orchestrators, two reading services, wtui→grindstone→Approach — each rewrite reset distribution to zero (agent-tooling survey, cross-cutting patterns). Capacity is the scarce input for everything below.
- **Effort**: S — one weekend; all dispositions are edits, licenses, and README banners.
- **Impact**: Medium directly, high as an enabler — reclaims the hours that fund the flagship.
- **ICE Score**: 5×9×9 = **405**

### Priority 2: Multi-Tenant Core (auth, tenancy, isolation)
- **What**: Magic-link auth; per-user R2 key prefixes (`u/{user_id}/...`) with corpus migration for the existing 331 readings; Vectorize metadata filtering per user; per-user email destinations; SSRF hardening on the fetch path; drop the extract-agent Reddit path from the hosted product (drives a logged-in Chrome session — cannot ship hosted). Dedup policy: extraction cache (raw/markdown of public URLs) may stay global; summaries, connections, and similarity strictly per-user — preserves most of the cost savings without the two cross-tenant leaks the survey identified.
- **Why**: Brian chose straight-to-multi-tenant over single-tenant instances (interview round 2). The survey's gap list is explicit: retenanting touches every store module; the leaks (global by-url manifest reuse, cross-user connections) are structural, not cosmetic.
- **Effort**: L — 8–12 focused weeks per the codebase survey; the pipeline itself needs almost nothing.
- **Impact**: High — nothing can be sold without it.
- **ICE Score**: 9×7×4 = **252**

### Priority 3: Hybrid Billing, Metering & Spend Ceiling
- **What**: Paddle or Lemon Squeezy as merchant of record with two tiers: hosted $6/mo metered (100 readings/mo, overage credit packs) and BYO-API-key tier ($24/yr — user's OpenAI/Anthropic key, our pipeline + storage). Hard per-user and global LLM spend ceilings; rate limits on submission. **Import economics** (reconciles metering with the migration-funnel strategy in P5): migrated archives are backfilled embeddings-only at <$0.001/item — a 5,000-item Pocket export costs ~$4 one-time and becomes immediately searchable and usable as connection targets; per-item synthesis applies only to new readings going forward, with optional import credit packs for retroactive synthesis and bulk synthesis routed to the BYO-key tier.
- **Why**: Interview decision (hybrid). Research triangulates the band: ~$5/mo cited as sellable to Readwise refugees, $10/mo the kill zone, one-time/BYO demanded by the HN crowd ("I just don't try things out if needing a subscription is an inevitability"); $6 stays well inside the comfortable band while making the tier margin-positive by construction (Pricing section). The metering requirement is a survey finding: the bulk importer can blow through a month's revenue in minutes.
- **Effort**: M — billing is commodity; metering hooks into the existing queue pipeline.
- **Impact**: Medium-high — converts both researched segments; caps downside risk.
- **ICE Score**: 6×7×8 = **336**

### Priority 4: Permanence Pack — Obsidian Export + Guaranteed Export
- **What**: One-click full-archive export (markdown + JSON manifests, from the R2 originals already stored); scheduled auto-export option; Obsidian-compatible markdown (frontmatter with tags/entities/connections); published "your data outlives us" guarantee page. Later: an Obsidian community plugin for sync.
- **Why**: Post-Pocket/Omnivore, export trust is the price of admission (pain-points: platform-death trauma, HIGH confidence). Readwise's Obsidian plugin is its de-facto distribution into the 1M+-user PKM community (distribution research). The R2 architecture makes this days of work — a cheap claim competitors bought with years.
- **Effort**: S for bare export (the R2-stored originals make it days of work); M for the full pack (scheduled auto-export, Obsidian frontmatter format, guarantee page). The community plugin is a later, separate M.
- **Impact**: High — converts the segment's #1 stated fear into a differentiator.
- **ICE Score**: 7×8×7 = **392**

### Priority 5: Comparison-SEO & Migration Funnel Engine
- **What**: Product site with 5–8 commercial-intent pages by launch: "Pocket alternative (2026)", "Readwise Reader alternatives", "Instapaper vs [product]", "best read-it-later with AI connections", plus import tools (Pocket CSV export, Omnivore JSON, Instapaper CSV, Readwise export) each with a landing page — import economics per P3's embeddings-only backfill, so the funnel's promise is affordable by design. Repeat the playbook at every future competitor funeral ("this category kills an app yearly" — distribution research).
- **Why**: Revealed-preference channel: virtually every surviving app runs these pages (Readless, Noverload, Mente, Screvi, plus Zapier/TechCrunch roundups dominating SERPs). Commercial-intent pages survived AI search (~31% zero-click vs 74% informational).
- **Effort**: M ongoing — ~2 pages/month inside P7's content rotation (2 in Phase 0 + ~2/mo through Dec reaches the 5–8-page launch target); import parsers are S each.
- **Impact**: High — the only compounding acquisition asset available to a no-audience solo dev.
- **ICE Score**: 8×7×7 = **392**

### Priority 6: Launch Sequence — Waitlist → Private Beta → Show HN
- **What**: Now: named product + domain + waitlist page (while building P2). ~Nov: private beta for waitlist + a few Readwise-refugee volunteers from r/PKM. Launch: Show HN ("Show HN: I built a reading archive that tells you when you've read this before") with the novelty verdict as the demo hook — demonstrated via a landing-page interactive demo running on a canned sample corpus, since verdicts on an empty archive are meaningless, and via import-first onboarding (P3) so trial users' verdicts fire against their own history from reading #1; simultaneous r/PKM, r/ObsidianMD posts; Product Hunt for the badge only (0.1% conversion anecdote — never the main event).
- **Why**: Readwise Reader's Show HN hit 326 points; HN is a spike not a channel (distribution research), so it lands after SEO pages exist to catch the wake. Beta-before-launch de-risks the straight-to-multi-tenant path Brian chose, which otherwise defers all demand validation to the end.
- **Effort**: M — spread across the build.
- **Impact**: High — first-users event.
- **ICE Score**: 8×6×6 = **288**

### Priority 7: Content Flywheel — Weekly Deep-Dives on bbell.dev
- **What**: One post/week alternating: (a) agent-workflow deep-dives (Approach, worktrees, session orchestration — his daily practice), (b) build-in-public posts on the reading-lite productization (revenue/costs transparency genre included), (c) the comparison pages from P5. Syndicate to X as threads; submit substantive ones to HN. Approach itself stays free OSS with its cask — it is the credibility subject, not the product.
- **Why**: Technical deep-dives are the compounding channel in the agent space (steipete archetype; awesome-claude-code 52.4k stars ecosystem), and the agent-tooling market research is unambiguous that the tool layer itself doesn't monetize (Terragon dead, Bloop dead with 18.6k stars, Conductor free on $22M VC). Audience built here transfers to every launch. Brian confirmed weekly capacity (interview round 1: ongoing presence).
- **Effort**: S per week, ongoing — 3–4h of the 15h budget.
- **Impact**: High over 12 months; near-zero in month one. Honest lag.
- **ICE Score**: 7×7×6 = **294**

### Priority 8: ffb Draft-Season Post (time-boxed: next 2–3 weeks only)
- **What**: One evening: "How I built a consensus draft board with DuckDB and a $0 data stack" — pipeline architecture, VORP math, the deterministic mock-draft design. Publish before Labor Day weekend (peak draft window); post to r/fantasyfootball data threads + HN.
- **Why**: ffb is unviable as a product (XL effort, 3-week/year buying window, ESPN scraping can't go commercial — SaaS survey) but is ready-made content; drafts happen in the next 2–3 weeks (survey timing observation). A low-cost first writing rep: the transferable audience is the HN/technical-readers slice, not r/fantasyfootball (which maps to no portfolio persona).
- **Effort**: S — the work exists; this is writing.
- **Impact**: Low-medium; costs almost nothing.
- **ICE Score**: 3×5×8 = **120**

### Priority 9: MegaClock Validation Gate (2 weeks, then go/kill)
- **What**: Before any further build: landing page with rendered wall mockups + 30-second concept video; waitlist; posts to r/macapps (235k members, "solution request" culture) and X. Gate: ≥100–150 waitlist signups or unmistakable qualitative pull → schedule the cut-down build for Q1–Q2 2027 (grid-only, save/open, profile export, Pro unlock at $9.99 launch / $14.99 later, direct-sale via merchant-of-record first, Mac App Store + Featuring Nomination second — the surveyed launch spec already contains most of this). Below gate → kill, write up the validation as a build-in-public post, keep the codebase as a hobby.
- **Why**: Competitor research verified the niche is open (no styled multi-clock wall with shareable layouts exists on macOS) with a $10–18 one-time ceiling (Dato $18, Cadran €9.99) — but pain-point research found demand evidence the thinnest of the entire study (free Fliqlo/built-ins dominate; traders buy hardware). Thin evidence + L-sized build (XL as originally specced; persistence layer doesn't exist yet) = validate first. Brian selected this track knowing the gate (interview round 2).
- **Effort**: S for the gate; L for the build if passed.
- **Impact**: Medium — side-income scale by base rates (~81% of apps never cross $1k/mo; Lunar took years to ~$100k/yr).
- **ICE Score**: 5×4×7 = **140**

### Priority 10: Agent-Integration Pack — MCP Server + Agent Skills (post-beta)
- **What**: Expose the existing REST API as a hosted Streamable-HTTP MCP server with OAuth (natively consumable by Hermes Agent, Grok-the-assistant via BYO-MCP, Claude, Cursor), plus a thin AgentSkills-spec SKILL.md published to ClawHub (~5,400-skill registry) and Hermes' Skills Hub — OpenClaw's native surface, where MCP is second-class via bridges. The agent-native differentiator: expose the novelty verdict and connections as tools (`is_this_new_to_me(url)`, `what_do_i_know_about(topic)`) so agents consult reading memory before acting — Readwise's MCP only searches highlights; no surveyed product exposes a novelty check. Sequenced strictly post-beta: requires P2's scoped tokens.
- **Why**: MCP access is now table stakes in the category (verified 2026-08-15: Recall ships it on the free tier; Readwise has an official MCP — "Give your AI access to everything you've read"; Karakeep and Raindrop both official) — so this is catch-up and differentiation in one. The consumer positioning "the memory layer for your AI agents" is unclaimed: the phrase belongs to dev-infra (Mem0, Supermemory) — and Supermemory *started as a bookmarks app* and pivoted, so the lane is visible and speed matters. Brian self-hosts OpenClaw and Hermes Agent (deployment plans in ~/dev/hermes) — he is the target user — and builds skill tooling (skilled), making the SKILL.md path near-zero marginal learning. Grok Bot itself (launched 2026-08-11, $120–300/mo tiers) exposes no third-party connector/MCP surface — it would drive reading-lite's web UI as a human would; Grok-the-assistant consumes BYO MCP.
- **Effort**: M — the API exists; the MCP server wraps it (Workers-native MCP tooling available); skills are thin wrappers.
- **Impact**: High for the technical segment and the launch narrative; table-stakes insurance for the category.
- **ICE Score**: 7×7×7 = **343**

## Distribution & Go-To-Market Strategy

### Primary Channel

**Comparison/alternative SEO + migration funnels** (P5). It is the read-later category's revealed-preference channel, it matches a solo dev with no audience (compounds without a following), and it survives AI search because the intent is commercial. Every page doubles as a migration funnel with an import tool.

### Secondary Channels

1. **PKM communities (r/PKM, r/ObsidianMD, MPU forum)**: where the Readwise-curious persona already discusses these tools weekly; participate honestly (the r/macapps playbook transposed), never spam — beta recruits come from here.
2. **Hacker News (launch spikes)**: Show HN at public launch with the novelty-verdict demo; the transparency-post genre (costs, revenue) reliably travels and is planned into P7.
3. **Obsidian integration surface**: export format at launch, community plugin later — Readwise proved the plugin directory is quiet, durable distribution into exactly this persona.

### Packaging Recommendation

Hosted web SaaS, single product, two tiers (hosted-metered / BYO-key), with guaranteed export as a headline feature, not a settings item. No mobile apps at launch — an explicit solo-capacity tradeoff, not a persona claim: competitor breadth there (Matter iOS-first, GoodLinks Apple-native) is unmatchable at 15h/week. Launch capture friction is mitigated cheaply instead: a bookmarklet and an email-in save address (S each; the email path uses the same vendor — Resend inbound — but is new inbound configuration, not the existing outbound digest), with a browser extension as the first post-launch capture surface. Keep the product name separate from bbell.dev (bbell.dev is the author/content brand feeding it).

**Capture-reliability ladder** (Worker-side fetch is known-unreliable for some content types; this replaces any single-mechanism assumption): Rung 0 — existing Worker fetch (free). Rung 1 — Cloudflare Browser Run fallback for JS-heavy pages, auto-triggered on thin extractions (<100-word heuristic — the same signal the community Readwise repair extension uses): $0.09/browser-hour → $0.000125–0.0005/page, with 10 browser-hours/mo already included in the Workers Paid plan (~1,800–7,200 fallback pages before any marginal cost). Rung 2 — bookmarklet (beta) then MV3 extension (launch window) capturing the rendered DOM from the user's own session: the category-standard and only legitimate fix for paywalled and bot-blocked content (Readwise's docs say extension capture exists for exactly this; Instapaper ships Logged-In Sites; Karakeep integrates SingleFile) — Reddit and X are auth walls, unreachable by any cloud fetcher regardless of IP, and Reddit is actively suing scrapers (Perplexity, Oxylabs et al., Oct 2025). Rejected rungs: operating a "computer in the cloud" (consumer versions are $120–300/mo general agents — Grok Bot, ChatGPT agent mode — and building one is the Space C absorption trap; dev-infra like Browserbase exists if a stealth fetch tier is ever truly needed) and Instapaper-style credential vaults (custody of users' publisher passwords is untenable liability for a $6/mo solo product).

**Design bar**: the current SPA is agent-generated and reads as such; in a category with a design-premium lane (GoodLinks, Matter) where the buyer stares at typography for hours, the launch bar is "credible and calm," concentrated on the three surfaces that convert: the reading/detail view, the digest email, and the landing page. One focused design sprint in Phase 2 (references: Reader's information density, GoodLinks' restraint) on a disciplined component system; a one-off professional design pass on those three surfaces is the only recommended pre-revenue cash spend.

### Pricing Recommendation

- Hosted: **$6/mo or $60/yr, 100 readings/mo included.** The arithmetic, worst-case-first: net revenue after merchant-of-record fees (~10% + 50¢) ≈ $4.90/mo. The queue-async pipeline qualifies every summarization for provider batch pricing (50% discount → ~$0.028/reading), so COGS at the full 100-reading cap ≈ $2.80 → **~43% worst-case gross margin**, and ~54% at the founder-median 80 readings/mo. Batch's real tradeoff is latency, not quality (same models, up-to-24h completion): the queue-and-email-digest architecture tolerates it, but connections may take hours to appear — own that as explicit product behavior, with an operational fallback trigger: if p90 time-to-summary exceeds ~4 hours or beta users push back, drop to interactive pricing with a 60-reading cap (60 × $0.055 = $3.30 < $4.90 net) — margin-positive by construction either way. Annual billing ($60/yr nets ~$4.46/mo) stays positive in both modes: ~37% at cap batched, ~26% in the interactive fallback. Overage: $3 credit packs per 50 readings (~$1.40 COGS batched); packs reprice to $3 per 25 readings whenever the interactive fallback is active. Final cap tuned from beta telemetry. Positioning: under Readwise's $10 kill zone, above Raindrop's $28/yr organizer anchor.
- BYO-API-key: **$24/yr** — user's own key; near-zero COGS; the designated home for heavy users and bulk retroactive synthesis; converts the subscription-averse; de-risks LLM price volatility.
- Trial (replaces a naive N-free-readings tier, which can never demonstrate the differentiator on an empty archive): landing-page interactive demo on a canned corpus + a 14-day full trial that begins with archive import (embeddings-only backfill per P3), so connections and novelty verdicts fire against the user's real history from their first reading.

### First 3 Growth Actions

1. **This month**: name + domain + waitlist page with a 60-second demo of the connections narrative and novelty verdict on real readings; ffb post published while draft season is live.
2. **During the build (Sep–Nov)**: 2 comparison-SEO pages/month live, indexed early so they have SERP age by launch; weekly build-in-public cadence starts.
3. **At beta (Nov)**: recruit 10–20 users from r/PKM "Readwise alternatives" threads and the waitlist; instrument reading volume to finalize metering; collect the 3 quotes that become the launch page's social proof.

## Roadmap (15h/week budget: ~8–10 build, 3–4 content, 1–2 community)

| Phase | Window | Deliverables | Exit criteria |
|---|---|---|---|
| 0 — Hygiene & seeds | Aug 15 – Sep 15 | Kill list executed; ffb post live; product name + domain + waitlist; first 2 SEO pages; content cadence starts | Waitlist exists; drafts window not missed |
| 1 — Multi-tenant build | Sep – Nov | P2 tenancy + P3 billing/metering; MegaClock gate run in one 2-week slice (~Oct), funded from content/community hours — not build hours | Private beta invite-ready; MegaClock go/kill decided |
| 2 — Beta | Nov – Dec | 10–20 beta users; P4 export pack ships (launch prerequisite); bookmarklet + email-in capture (S each); Browser Run fetch-fallback for JS-heavy pages (S); design sprint on the three converting surfaces; metering telemetry; pricing finalized; import tools for Pocket/Omnivore/Instapaper/Readwise | 3 testimonial quotes; <5% pipeline failure rate |
| 3 — Launch | Dec – Jan 2027 | Show HN + r/PKM + PH badge; paid tiers live | First 25 paying customers |
| 4 — Compound | 2027 H1 | SEO library to 15+ pages; browser extension (MV3); P10 agent-integration pack (MCP server + ClawHub/Hermes skills — pull forward if beta demand shows); Obsidian plugin; MegaClock cut-down build if gated GO (launch ~May) | 100–150 subscribers; MegaClock shipped or killed |

**Capacity note (explicit slip tolerance)**: P2 alone is 80–120 focused hours — essentially the entire Sep–Nov build budget at 8–10h/week. The roadmap carries a deliberate 4–8 week slip tolerance: launch may move to Feb 2027 without changing the strategy. Anything that competes with P2 for build hours gets cut or deferred first.

**Revenue math (honest)**: 100–150 subscribers at a blended ~$4.80/mo gross (70/30 hosted/BYO mix) = **$480–720/mo gross by mid-2027** (~$400–600 net at the stated MoR fee arithmetic); MegaClock (if built) adds $150–400/mo at Mac-utility base rates; combined **$1k/mo trajectory lands mid-to-late 2027** absent a distribution hit (front-page HN or creator pickup pulls it in by months). $1k/mo by early 2027 would require beating the category's base rates — plan for the slower curve, celebrate the faster one.

**Parked (explicit non-goals with revisit conditions)**: Approach paid/team layer (revisit only on loud inbound demand for a hosted/team surface — the OpenCode hosted-tier template is the only solo-compatible model observed); reading-lite-next Go rewrite (moratorium; the TS Workers version is the shipping base per survey recommendation); AIUsageBar public launch (declined; revisit as a reputation piece only if desired); backflow revival (archived).

## Risks & Considerations

- **Readwise ships novelty verdicts**: they could add ingest-time synthesis in one release. Mitigation: speed to launch, own the "reading memory" positioning and the sub-$10 band they won't chase (their bundle economics anchor them at $120/yr), and keep the BYO tier they structurally can't offer.
- **Unit-economics erosion**: LLM price or usage-pattern shifts could squeeze the hosted tier. Mitigation: the tier is margin-positive by construction at its cap in both batch and no-batch scenarios (Pricing section); hard spend ceilings specced in P3; BYO tier absorbs heavy users; reasoning-effort knob is a free cost lever (survey: medium effort costs the same as low); caps retuned from beta telemetry.
- **Straight-to-multi-tenant defers demand validation** (~3 months of build before revenue). Mitigation: waitlist + SEO pages + beta act as staged validation checkpoints; if the waitlist is dead at ~6 weeks, downgrade to the instances path (scripts exist) rather than sunk-cost the full build.
- **Legal/abuse surface**: storing full third-party article text; SSRF; DMCA. Mitigation: private-by-default archives (no public sharing at launch), fetch-hardening in P2, merchant-of-record for tax, ToS/privacy templates before beta, DMCA contact published.
- **Solo-capacity risk**: three tracks + a job. Mitigation: the moratorium (P1), MegaClock behind a hard gate, ffb time-boxed to one evening, content budget capped at 3–4h/week.
- **Platform risk on summarizer provider**: OpenAI/Anthropic pricing or policy shifts. Mitigation: provider abstraction already exists (OpenAI default, Anthropic optional); BYO tier shifts exposure to users.
- **Design-conversion risk**: the agent-generated SPA underselling a strong pipeline in a design-sensitive category (GoodLinks/Matter set the bar). Mitigation: Phase 2 design sprint scoped to the three converting surfaces; the landing page treated as the highest-stakes design artifact.
- **Agentic browsing shifts reading itself**: Grok Bot-class agents (persistent cloud VMs, $120–300/mo, launched Aug 2026) could become how some users consume the web, bypassing save-to-read workflows. Mitigation: position reading-lite as the archive those agents need — P10 makes it complementary infrastructure (agents write to and consult your reading memory) rather than a competing surface.

## Sources

Codebase: surveyor reports over /Users/brian/dev (reading-lite incl. `.summarizer-comparisons` cost data, wrangler.toml, store modules; megaclock specs/PRODUCT_SPEC §12 + LAUNCH_SPEC; swift-usage-bar docs/endpoints.md; ffb DESIGN.md + migrations; agent-tooling cluster + approachcontrol org).

Market (key load-bearing URLs):
- Pocket/Omnivore: techcrunch.com/2026/08/14 read-it-later alternatives; news.ycombinator.com/item?id=44063662 (1,222 pts); item?id=41985118; niemanlab.org Mozilla shutdown.
- Readwise: readwise.io/pricing; blog.readwise.io/why-were-bootstrapping-readwise; cancellation posts (medium.com/@robbieadler; abhimanyusharma77.medium.com).
- Connections competitors: recall.it/pricing; trelk.app; sublime.app/pricing (related-ideas surfacing, pay-what-feels-right); saner.ai (duplicate-save warning, near-identical to the novelty-verdict concept — pain-points research); talk.macpowerusers.com/t/40559 (junk drawers thread).
- Subscription fatigue: news.ycombinator.com/item?id=44075451 (DoubleMemory Show HN comments).
- Karakeep: github.com/karakeep-app/karakeep (+issues #462, #111, #2344).
- SEO/channels: comparison-page pattern (readless.app, supasidebar.com, noverload.com et al.); Product Hunt 2026 conversion posts (luka.to, producthunt.com/p/general); zero-click data (digitalapplied.com, omnibound.ai).
- Mac utilities: notes.alinpanaitiu.com (Lunar economics + App Store review timeline); startupsemail.substack.com MacWhisper; starterstory.com Screen Studio; docs.setapp.com/docs/distributing-revenue; developer.apple.com featuring nominations; sindresorhus.com/dato; cadranapp.com; fliqlo.com; codexbar.app + github.com/steipete/CodexBar; github.com/ryoppippi/ccusage; anthropics/claude-code#6958.
- Agent tooling: vibekanban.com/blog/shutdown; docs.terragonlabs.com/docs/resources/shutdown; conductor.build; nimbalyst.com; imbue.com/sculptor; github.com/smtg-ai/claude-squad; code.claude.com/docs/en/agent-teams; openai.com/index/introducing-the-codex-app; venturebeat.com Anthropic harness cutoff; thenewstack.io Agent SDK pause; sacra.com/c/cline; thenewstack.io OpenCode revenue; news.ycombinator.com/item?id=44533004 (Vibe Kanban 195 pts); item?id=44713757 (rate limits 609 pts).

- v1.1 capture & integrations: developers.cloudflare.com/browser-run/pricing; docs.readwise.io/reader/docs/saving-content; instapaper.com/docs/save/paywall-content (+ Instapaper 9.1 Logged-In Sites); docs.karakeep.app/integrations/singlefile + /integrations/mcp; readwise.io/mcp + github.com/readwiseio/readwise-mcp; recall.it/pricing (API+MCP on free tier); help.raindrop.io/mcp; docs.openclaw.ai/tools/skills (AgentSkills spec; ClawHub); hermes-agent.nousresearch.com/docs (MCP first-class: Streamable HTTP + OAuth 2.1); docs.x.ai/grok/connectors + /developers/tools/remote-mcp; Grok Bot launch coverage 2026-08-11..14 (unite.ai, venturebeat.com, 9to5mac.com — SpaceX/xAI/Cursor context); builtin.com Reddit v. Perplexity/Oxylabs scraping suit (Oct 2025); supermemory.ai + mem0.ai (memory-layer positioning is dev-infra-owned; Supermemory pivoted from a bookmarks app).

### Verification notes

Verified against primary sources: Readwise/Recall/Raindrop/Instapaper/Wallabag/Linkwarden pricing (vendor pricing pages); Setapp payout terms (Setapp docs); Pocket/Omnivore/Terragon/Vibe Kanban shutdowns (vendor posts); CodexBar/ccusage/Karakeep star counts (GitHub); reading-lite unit costs (checked-in comparison report). Single-source/low-confidence and flagged as such: Matter ARR, Readwise user counts, "84% of saves never reopened," second-brain TAM figures, Reddit sentiment (crawler-blocked; sourced indirectly), MegaClock demand (thinnest area — hence the gate).
