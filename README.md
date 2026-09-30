# reading-lite

Save a URL and get a summary, connections to earlier readings, and a verdict
on whether it adds something new to your library. Reading Lite keeps captured
content in Cloudflare R2 and readings, summaries, embeddings, and accounts in
PostgreSQL with pgvector, with a Worker for processing and a TanStack Start
frontend for reading, searching, and managing your account.

The canonical host is [readinglite.ai](https://readinglite.ai).
[readinglite.app](https://readinglite.app) also serves the app. Browser
sessions are separate on each host.

## Using the app

Sign in with an emailed magic link, then submit a URL. Processing runs in the
background. The detail page shows the TL;DR, summary, tags, entities, connections,
and captured content. Search matches titles, TL;DRs, URLs, and keywords; tag
chips filter the list. While a reading is processing, its page and any library
page showing it check status on a bounded schedule (every 3 to 15 seconds,
stopping after 16 minutes or three failed checks); "Check status" tries once
more. A failed reading can be retried or recovered by importing a Markdown copy.

The account page manages sessions, API tokens, archive exports, account
deletion, immediate notification mail, and daily or weekly digests. Digest
cadence `off` disables digests independently of immediate notifications.

Staging and production summarize with Anthropic (Claude Sonnet 5, medium
effort); local development defaults to OpenAI. Both use OpenAI embeddings. The selected provider must be configured correctly; there is no
automatic fallback. See [configuration](docs/configuration.md).

## Local development

Use Node 22.12 or newer for local development
([operator Node](docs/operations.md#operator-node)) and Docker for the local
PostgreSQL container ([local Postgres](docs/operations.md#local-postgres)). In
the repository root:

```sh
npm ci
cp .dev.vars.example .dev.vars   # first setup only; preserve an existing file
npm run dev
```

This starts PostgreSQL 18 with pgvector on `127.0.0.1:54329`
(`docker compose up -d --wait postgres`), applies its migrations, imports
`dev-local-token` as the founder bearer, and starts the Worker at
`http://127.0.0.1:8787`. The example provider keys are placeholders. Sign-in
links point at the frontend on `:5174`. In a second terminal:

```sh
cd app
npm ci
npm run dev
```

Open `http://127.0.0.1:5174`; its dev server proxies `/api` to the Worker.
Request a magic link, then retrieve it from
`http://127.0.0.1:8787/api/dev/mailbox?email=<your-email>` on loopback.
`LOCAL_MAIL_SINK=1` keeps local login mail in that outbox. The
[reading-lite-local](.agents/skills/reading-lite-local/SKILL.md) skill runs
both for you.

Local R2 and PostgreSQL start empty. Local development has no Queue binding, so
submit, import, and reprocess return 503. List, detail, content, lookup, `q`
text search, and similarity work with
[seeded local data](docs/operations.md#seeding-local-data) (`npm run seed:local`).
Integration tests cover the processing pipeline with queue and provider fakes.

## Verification

```sh
npm run test:quiet
npm run types:check
npm run typecheck
```

`test:quiet` runs the same Worker and Node Vitest projects as `npm test`, with
Workers-pool log noise filtered. CI runs `npm run test:ci`. The suite needs the local
PostgreSQL container running (`docker compose up -d --wait postgres`); it
creates its own test databases there. Run it on Node 22. There is no lint script.
The frontend has its own checks in [app/README.md](app/README.md).

Worker runtime types are checked in as `worker-configuration.d.ts`. Run
`npm run types:generate` after changing Wrangler or the compatibility date/flags
in `wrangler.toml`, and commit the result; CI checks freshness with
`npm run types:check`.

## API and MCP

Use scoped bearer tokens for scripts and MCP clients. The
[API guide](docs/api.md) covers authentication, submit/poll behavior, Markdown
imports, the Markdown inbox, and reprocessing. [OpenAPI](docs/openapi.yaml) defines request and
response schemas.

For a remote MCP client:

```json
{
  "name": "reading-lite",
  "url": "https://readinglite.ai/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

Keep the token out of git. The connector has eleven tools for listing, searching,
reading content, submitting URLs, reprocessing, diagnostics, and staging
Markdown in the inbox for a person to review and promote. See [MCP setup and routes](docs/api.md#mcp-connector).

## Imports and operations

The operator CLI plans durable changes by default and applies them only with
`--execute`. Start with `npm run ops -- --help`.

[The operations runbook](docs/operations.md) covers deployment, staging, bookmark
and Markdown imports, provider batches, and corpus repair. Every `corpus` command
requires `--tenant`; live production uses the tenant ID from `/api/whoami`.

X threads use the recent-search API and need `X_API_BEARER_TOKEN`. Reddit needs
local recovery. YouTube imports can use basic metadata in the Worker; local
extraction adds description and transcript when available. See
[source-specific imports](docs/operations.md#sources-that-need-a-local-skill).

## Project documentation

- [Architecture](docs/architecture.md), module responsibilities and storage rules.
- [AGENTS.md](AGENTS.md), commands and constraints for coding agents.
- [app/README.md](app/README.md), the new frontend's commands and rules.
- [CONTEXT.md](CONTEXT.md), domain terminology.
- [Archive export format](docs/archive-export.md), the zip a reader downloads.
- [Hosted provider spend](docs/paid-provider-spend.md), budgets and accounting.
- [Staging context preparation](docs/staging-context-copy.md), local fixture packets.
- [Product brief](docs/product/reading-lite-portfolio-brief.md) and
  [product scope](docs/product/reading-lite-scope.md), what to build and why.
- [Architecture decisions](docs/decisions/), design history;
  [ADR 0005](docs/decisions/0005-postgresql-storage.md) covers PostgreSQL storage.
- [PostgreSQL cutover](docs/postgres-cutover.md) and
  [founder cutover](docs/founder-cutover.md), completed migrations and retained evidence.
