# reading-lite

Save a URL and get a summary, connections to earlier readings, and a verdict
on whether it adds something new to your library. Reading Lite stores captured
content and summaries in Cloudflare R2, with a Worker for processing and a React
app for reading, searching, and managing your account.

The canonical host is [readinglite.ai](https://readinglite.ai).
[readinglite.app](https://readinglite.app) also serves the app;
[reading-lite.bbell.dev](https://reading-lite.bbell.dev) remains available for
compatibility and rollback. Browser sessions are separate on each host.

## Using the app

Sign in with an emailed magic link, then submit a URL. Processing runs in the
background. The detail page shows the TL;DR, summary, tags, entities, connections,
and captured content. Search matches titles, TL;DRs, URLs, and keywords; tag
chips filter the list. The app refreshes queries after submit and reprocess but
does not poll pending readings. Refresh to see a later result.

The Security page manages sessions, API tokens, account deletion, immediate
notification mail, and daily or weekly digests. Digest cadence `off` disables
digests independently of immediate notifications.

OpenAI is the default summarizer; Anthropic is optional. Both use OpenAI
embeddings. The selected provider must be configured correctly; there is no
automatic fallback. See [configuration](docs/configuration.md).

## Local development

Use Node 22.12 or newer for the current development toolchain. The operator's
Node 20.19.x setup has a separate [supported ops path](docs/operations.md#operator-node);
do not upgrade that machine just to run the CLI.

In the repository root:

```sh
npm ci
cp .dev.vars.example .dev.vars   # first setup only; preserve an existing file
npm run dev
```

This applies local D1 migrations, imports `dev-local-token` as the founder
bearer, and starts the Worker at `http://127.0.0.1:8787`. The example provider
keys are placeholders. In a second terminal:

```sh
cd web
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` and `/health` to the Worker.
Request a magic link in the app, then retrieve it from
`http://127.0.0.1:8787/api/dev/mailbox?email=<your-email>` on loopback.
`LOCAL_MAIL_SINK=1` keeps local login mail in that outbox.

Local R2 starts empty. Local development has no Queue or Vectorize binding, so
submit, import, and reprocess return 503, and vector similarity returns no
matches. List, detail, content, lookup, and `q` text search work with
[seeded local data](docs/operations.md#seeding-local-r2). Integration tests cover
the processing pipeline with queue, Vectorize, and provider fakes.

## Verification

```sh
npm run test:quiet
npm run typecheck
cd web
npm test
npm run build
```

`test:quiet` runs the same Worker and Node Vitest projects as `npm test`, with
Workers-pool log noise filtered. CI uses `npm test`. There is no lint script.
The SPA build includes its TypeScript check.

## API and MCP

Use scoped bearer tokens for scripts and MCP clients. The
[API guide](docs/api.md) covers authentication, submit/poll behavior, Markdown
imports, and reprocessing. [OpenAPI](docs/openapi.yaml) defines request and
response schemas.

For a remote MCP client:

```json
{
  "name": "reading-lite",
  "url": "https://readinglite.ai/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

Keep the token out of git. The connector has eight tools for listing, searching,
reading content, submitting URLs, importing Markdown, reprocessing, and
diagnostics. See [MCP setup and routes](docs/api.md#mcp-connector).

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
- [CONTEXT.md](CONTEXT.md), domain terminology.
- [Hosted provider spend](docs/paid-provider-spend.md), budgets and accounting.
- [Staging context preparation](docs/staging-context-copy.md), local fixture packets.
- [System map](docs/system-map/README.md), interactive architecture overview.
- [Product scope](docs/product/reading-lite-scope.md) and
  [architecture decisions](docs/decisions/0001-tenant-control-plane.md), planning history.
- [Founder cutover](docs/founder-cutover.md), completed migration and retained evidence.
