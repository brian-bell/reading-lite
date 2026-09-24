# Reading Lite product brief

Updated September 6, 2026. This replaces the August portfolio and
subscription-first proposal. The [scope](reading-lite-scope.md) defines the
work and acceptance criteria. Git history preserves the earlier plans.

## Direction

Reading Lite remains a personal project for now. Improve Brian's daily reading
workflow and prepare a free hosted tier for an open-source launch. Users bring
their own AI API key, or BYOK. The main work is the UI redesign and provider
settings for each tenant.

Launch when Brian enjoys using it and another reader can adopt it without his
help. There is no fixed date or revenue target.

A paid tier may follow, with AI included or more hosting capacity. Decide what
it offers and what it costs after people use the free tier. Defer billing and
paid account features.

## Product promise and audience

**A reading library that connects what you save to what you already know.**

Reading Lite compares each saved article with related readings in the user's
archive. It explains the connections and assesses what the article adds. Those
explanations should help the reader decide what deserves their attention and
which earlier readings to revisit.

Build for Brian first. At launch, invite readers who want the same workflow and
will connect an AI API key, but would rather avoid running their own server.
Learn what other readers need before adding features for them.

The bet is that connections and novelty verdicts help people read. This brief
does not claim that competitors lack them. An empty archive gives the model
little context, so show an example during setup. Let users see why reading
history matters before asking them to import an archive.

## Starting point

The service runs at `readinglite.ai` on Cloudflare Workers, Durable Objects,
R2, and Queues, with reading state, embeddings, and the control plane in
PostgreSQL with pgvector ([ADR 0005](../decisions/0005-postgresql-storage.md)).
A TanStack Start frontend on its own Worker serves the public hosts
([issue #335](https://github.com/brian-bell/reading-lite/issues/335)); the React
SPA stays deployed to Pages as the rollback target. It already has:

- URL submission, Markdown import, background processing, summaries, connections,
  novelty verdicts, and reprocessing.
- A library with text search and tags, reading details, captured content, and
  diagnostics. Vector similarity supports processing and an API endpoint;
  natural-language semantic search is not the current library search behavior.
- Tenant-scoped storage and similarity, magic-link sessions, scoped API tokens,
  account settings, notifications, digests, and account-deletion machinery.
- Request quotas, processing leases, hosted provider spend admission, and
  extraction safeguards, with documented operational limitations.
- REST and bearer-authenticated MCP access for existing reading workflows.

AI credentials and provider/model choices are currently deployment-wide. OpenAI
provides embeddings even when Anthropic supplies summaries. Provider setup in
the new frontend, tenant provider settings, and self-service full-archive export
are planned work.
Architecture and API details belong in the [architecture guide](../architecture.md)
and [API guide](../api.md).

## What to build next

### Redesign the reading interface

Start the redesign with the reading detail page. Set the typography and layout
for source text, summaries, novelty verdicts, and connections to other readings.
Then use those choices in the library, search, capture, processing status, and
account settings.

Make the controls accessible and the layouts work on desktop and phone screens.
Keep existing workflows. Put diagnostics within reach when processing fails,
without filling the reading page with operator details.

Provider setup is part of this design. Show what the key enables, who pays,
what is connected, and how to recover from credential or provider failures.
Use the sample library to explain connections before key setup. Design the
digest and launch page after the reading interface.

### Give each tenant its own provider settings

Give each account provider settings and encrypted credentials, with controls to
connect, replace, and remove a key. Background jobs must use that account's
settings and credentials. Missing or invalid credentials must never trigger a
silent fallback to Brian's production key.

Start with one OpenAI key for summaries and embeddings. This is the recommended
launch choice, still to be confirmed. Keep the two roles separate in the
configuration. Supporting Anthropic summaries also requires an embedding
provider; settle that before offering it during setup.

Move Brian's account to these settings before inviting other users. Preserve
his corpus and existing processing behavior. Specify what a settings change
does to queued jobs, retries, and stored embeddings.

The hosted service must decrypt users' keys to run background jobs. Tell users
that when they connect a key. Keys must stay out of browser persistent
storage, logs, queue payloads, reading artifacts, and exports. Removing a key
stops future use without taking away access to existing readings.

## Free hosted launch and sustainability

The free tier includes the core reading experience, using the user's key for AI
processing. Reading Lite charges no subscription for that tier. Users pay their
AI provider and stay within the published hosting limits.

Keep existing API/MCP access and data export in the free tier. A reader who
never upgrades should still have a useful library.

BYOK leaves hosting, extraction, queues, vector storage, email, and support costs
with Brian. Choose a hosting budget and measure usage before setting limits.
Track provider usage separately from hosting costs, and label cost estimates
as estimates. Do not use the old margin claims or per-reading prices as current
evidence. Hosted queue processing does
not receive Batch API discounts merely because it runs asynchronously.

The earlier [paid economics measurement](../193-v2.1-handoff.md) remains deferred.
This direction does not authorize a provider run, production budget change, or
reuse of an old execution proposal.

## Open source and data ownership

Publish the application source as part of launch, retaining the existing
[MIT license](../../LICENSE). Review repository contents and history first,
including private corpus material and operational evidence. Publishing the
repository is a separate action that still needs approval.

Ship setup instructions and an archive export alongside the source. Users need
their captured content, summaries, metadata, and connections even if they leave
the service. State the hosting and support limits.

A polished self-hosting installer, a portable backend, and local-model support
are not launch requirements. Ship on the current Cloudflare architecture.

## When to invite other readers

Brian should prefer the redesigned interface, find useful connections, and
recover from processing failures through the app. His account must use the same
provider settings that other readers will use.

Invite a small group next. Can they connect a key and read their first article
without help? Do they return to the library? Can they export it? Record where
they get stuck, which processing jobs fail, and how much hosting and support
they need. Use those results to decide whether to open signup and what limits
to set.

## What could get in the way

- Key setup can prevent people from reaching the first useful reading. Address
  it with an example, clear setup instructions, and errors that explain the fix.
- Free hosting can exceed a sustainable cost or support burden. Start with an
  invited beta, enforce limits, and expand within an explicit budget.
- An article that fails to import or gets an unhelpful connection gives the
  reader little reason to return. Fix observed failures and explain which
  sources the service cannot capture.
- Provider credentials create a new security responsibility. Tenant isolation,
  revocation, key lifecycle, and retry behavior are acceptance criteria.
- Personal use can conceal onboarding problems. Test the complete workflow with
  other readers before opening access.

Defer billing, growth campaigns, native apps, teams, RSS/newsletter ingestion,
new agent tools, an Obsidian plugin, and broad capture automation. These may be
valuable later. Revisit them when daily use or beta feedback shows a need.
