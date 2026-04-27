# PRD — `reading-lite`: Cloudflare Worker Reading Service

> Source: `plans/000-re-design.md`. Scope-narrowed per user direction: **all new code in this greenfield repo (`reading-lite`)**; no changes to `brian-bell/backlite`. The Backlite-side coexistence/cleanup tracks from the source plan are explicitly out of scope.

This document is intended to be filed as a GitHub issue once approved. Repo: `brian-bell/reading-lite`.

---

## Context

Reading mode in Backlite currently runs through a heavy task-orchestrator pipeline (Docker → Claude Code agent → SQLite + filesystem) for what is fundamentally a single-shot LLM call: fetch URL, extract main content, summarize, judge novelty against past readings, persist. The orchestration machinery (lifecycle Coordinator, image router, polling, container provisioning, retries, output storage, webhooks) is overkill.

`plans/000-re-design.md` argues that reading mode can be lifted out into a standalone Cloudflare Worker with R2 as the source of truth and Vectorize as the similarity index. A single `messages.create` call with one forced tool use replaces the entire agent layer. The remaining work — fetch, extract, embed, persist, search — is plain HTTP + storage.

This PRD turns that argument into a buildable spec for a greenfield repo. The reader is the user himself; there is no team. Backlite continues to own its reading mode for now and will be retired in a separate effort outside this repo's scope.

## Problem Statement

I want to add interesting URLs to a personal reading library and quickly get a Claude-generated TL;DR, tags, and a "have I read something like this before?" novelty verdict — without standing up Docker, an orchestrator, or a SQLite database. Today this requires running the full Backlite stack locally, which is heavyweight for what is essentially one HTTP call to Claude per URL.

## Solution

A single Cloudflare Worker (`reading-lite`) exposes a small HTTP API. `POST /readings { url }` returns a reading id immediately and finishes the work in the background. Behind the scenes the Worker fetches the URL, extracts the main content, calls Claude once with a forced-tool-use schema to produce structured output (title, tldr, tags, keywords, people, orgs, novelty verdict, connections, summary markdown), embeds the TL;DR via OpenAI, and writes the result to R2 + Cloudflare Vectorize. A polling endpoint reports `pending` → `ready` | `failed`. Other endpoints list, fetch, look up by URL, and query similar readings.

A one-shot TypeScript migration script in this repo backfills existing readings from a Backlite SQLite snapshot + content directory into R2 + Vectorize, so day one of the new service has historical context.

## User Stories

1. As the user, I want to `POST /readings { url }` and get back a reading id within ~100 ms, so that my client doesn't block on a slow LLM call.
2. As the user, I want to poll `GET /readings/:id` and see the manifest's `status` flip from `pending` to `ready`, so that I can show a progress state in any future UI.
3. As the user, when a URL fails to fetch or extract, I want the manifest to land in `status: "failed"` with a structured `error` field, so that I can see what went wrong without grepping logs.
4. As the user, when I submit a URL that has already been ingested, I want the API to return the existing reading id without re-fetching or re-summarizing, so that I don't waste tokens or duplicate entries.
5. As the user, I want `GET /readings/lookup?url=` to return `{ id }` for known URLs and 404 otherwise, so that a future client can dedup before submitting.
6. As the user, I want `GET /readings` to return a paginated list of readings newest-first via a cursor, so that a future UI can build an infinite scroll.
7. As the user, I want `GET /readings/:id` to return the full manifest (title, tldr, tags, keywords, people, orgs, novelty verdict, connections, summary markdown, content metadata, usage), so that I can render a detail view without secondary calls.
8. As the user, I want `GET /readings/:id/content` to stream the extracted markdown when the source was HTML, so that I can read the cleaned article inline.
9. As the user, I want `GET /readings/:id/content/raw` to stream the raw bytes with the original `content_type`, so that I can fall back to the original PDF/JSON/text when extraction is unhelpful.
10. As the user, I want `POST /readings/similar { query_embedding }` to return top-K similar readings with id, url, title, tags, created_at, and score, so that I can ask "what have I read on this topic?" cheaply.
11. As the user, I want each manifest to record Anthropic input/output token counts and OpenAI embedding token counts in a `usage` block, so that I can estimate cost per reading later without re-deriving from logs.
12. As the user, I want every endpoint except `/health` to require a single bearer token from a Workers secret, so that the API is not openly callable.
13. As the user, I want CORS to be enabled for an env-configured allowlist of origins, so that a future browser SPA can call the API without a proxy while server-only callers still work.
14. As the user, I want HTML pages to be passed through `linkedom` + `@mozilla/readability` + `turndown` to produce clean markdown, so that the Claude prompt sees readable prose, not chrome.
15. As the user, I want non-HTML sources (PDF, JSON, plain text) stored as raw bytes and passed through to Claude as text where possible, so that the pipeline doesn't break on common non-HTML inputs.
16. As the user, I want fetches bounded by an explicit timeout and response-size cap, so that a slow or huge URL can't hang or balloon a Worker invocation.
17. As the user, I want manifests in `status: "pending"` longer than a soft TTL (5 min) to be treated as stale on read, so that a Worker that crashed mid-flight doesn't leave readings stuck forever.
18. As the user, I want similarity search to use a Vectorize index with cosine distance and 1536 dimensions, so that historical readings embedded with OpenAI `text-embedding-3-small` migrate without re-embedding.
19. As the user, I want a one-shot TypeScript migration script in this repo that reads a Backlite SQLite snapshot + content directory, writes manifests/raw/extracted to R2, writes the by-url pointer, and upserts to Vectorize, so that day one of the new service has my existing readings.
20. As the user, I want the migration script to be idempotent (R2 conditional writes, Vectorize upsert by id), so that I can re-run it safely against the same target.
21. As the user, I want the migration script to emit a CSV of `(id, status, error)` to stdout, so that I can verify coverage row-by-row.
22. As the user, I want `wrangler dev` with R2 + Vectorize bindings to a staging environment, so that I can iterate locally without burning prod data.
23. As the user, I want a `health` endpoint that does not require auth and returns 200 OK quickly, so that uptime checks are trivial.
24. As the user, I want the Anthropic call to use forced tool use (`tool_choice: {type: "tool", name: "emit_reading"}`), so that the LLM output is schema-valid in one shot and I never have to parse free-form prose.
25. As the user, I want Zod-typed schemas for both the Anthropic tool input and the manifest, so that bad LLM output is rejected at the boundary with a clear error and the rest of the system handles only valid records.
26. As the user, I want top-K similar readings (id + tldr + url) included as context in the Claude prompt, so that the novelty verdict and connections list are grounded in my actual library.
27. As the user, I want each module (extractor, Anthropic client, embeddings client, R2 store, Vectorize store) to expose a small functional interface that can be unit-tested with `fetch`/binding stubs, so that I can iterate on one piece without the whole stack.
28. As the user, I want integration tests that run the full Worker against Miniflare with in-memory R2 and a stubbed Vectorize, so that I can catch wiring bugs locally before deploying.
29. As the user, I want the README and `wrangler.toml` to make local-dev setup obvious (which secrets, which bindings), so that I can come back to this repo months from now and remember how to run it.

## Implementation Decisions

### Architecture

- **Single Cloudflare Worker** (`reading-lite`). One entry point, one router, multiple internal modules. R2 is the source of truth; Vectorize is the derived similarity index. No SQLite, no Docker.
- **Async submission** via `ctx.waitUntil()`. `POST /readings` writes a `pending` manifest, returns 202 with the id, and the background promise does fetch → extract → embed-query → Claude → embed-tldr → R2 writes → Vectorize upsert. On any failure the manifest is rewritten as `status: "failed"` with a structured error and **no** by-url pointer is written.
- **Dedup** via a single conditional R2 GET on `index/by-url/{sha256(url)}` before kicking off the background work. If present, return the existing manifest immediately.
- **Stale `pending` handling.** On read, manifests in `pending` older than 5 minutes (configurable) are surfaced as `stale_pending` so a future client can decide whether to retry. The Worker does not auto-retry stale readings in v1.

### Modules (deep, testable in isolation)

All four modules confirmed by user as the testable seams:

1. **`extractor`** — Pure pipeline. Inputs: response bytes + `content-type` header + URL. Outputs: `{ markdown?, raw, content_type, title? }`. Internals: content-type sniff → for HTML, `linkedom` + `@mozilla/readability` + `turndown`; for PDF/JSON/text, pass through. Enforces fetch timeout and size cap. Injected `fetch` for testability.
2. **`anthropic`** — Builds the prompt (extracted text + top-K similar context), calls `messages.create` with one tool definition (`emit_reading`) and `tool_choice` forcing it, validates tool input against a Zod schema, returns a typed reading record + `usage`. Injected `fetch`.
3. **`embeddings`** — Thin wrapper around OpenAI `text-embedding-3-small`. Inputs: text. Outputs: `{ embedding: number[1536], usage }`. Injected `fetch`.
4. **`stores`** — Two thin stores:
   - `ReadingStore` over R2: read/write manifest, raw bytes, extracted markdown, by-url pointer. All writes use conditional headers where idempotency matters.
   - `SimilarityStore` over Vectorize: `upsert(id, embedding, metadata)` and `query(embedding, k)`.

The Worker entry composes these four modules; the entry itself stays thin and is exercised through integration tests.

### Data layout (R2)

```
readings/
  YYYY/MM/DDTHHMMSSZ-{id}/
    manifest.json
    raw.{html|pdf|json|txt|bin}
    extracted.md         # only when source was HTML
index/
  by-url/{sha256(url)}   # tiny pointer object → { id, key_prefix }
```

The timestamped key prefix gives newest-first listing via R2 list-with-prefix + reverse cursor without a secondary index. The `key_prefix` stored in the by-url pointer lets `GET /readings/:id` resolve the manifest location without listing.

### Manifest schema (Zod)

Fields: `id`, `url`, `url_hash`, `status` (`pending` | `ready` | `failed`), `error?`, `title?`, `tldr?`, `tags?`, `keywords?`, `people?`, `orgs?`, `novelty_verdict?`, `connections?`, `summary_markdown?`, `content_type`, `content_status` (`captured` | `raw_only` | `failed`), `content_bytes`, `extracted_bytes?`, `content_sha256`, `fetched_at?`, `created_at`, `updated_at`, `usage?` (`anthropic_input_tokens`, `anthropic_output_tokens`, `openai_embedding_tokens`).

Note: the embedding vector lives in Vectorize, **not** the manifest, so manifests stay small.

### API surface

| Method + path | Auth | Behavior |
|---|---|---|
| `GET /health` | none | 200 OK |
| `POST /readings` | bearer | 202 with `{ id, status: "pending" }`; background fills it. If URL exists, returns 200 with existing record. |
| `GET /readings` | bearer | Paginated newest-first list via R2 list + cursor. |
| `GET /readings/:id` | bearer | Returns the full manifest. |
| `GET /readings/:id/content` | bearer | Streams `extracted.md`. 404 when `content_status != "captured"`. |
| `GET /readings/:id/content/raw` | bearer | Streams raw bytes with stored `content_type`. |
| `GET /readings/lookup?url=` | bearer | 200 `{ id }` or 404. |
| `POST /readings/similar` | bearer | Vectorize `query()` over body's `query_embedding`; returns top-K with metadata + scores. |

CORS: env-configured allowlist of origins (`CORS_ALLOWED_ORIGINS`, comma-separated). Bearer token still mandatory for browser callers.

### Auth

Single bearer token in a Workers secret (`READER_API_TOKEN`), checked in middleware on every route except `/health`. Constant-time compare. Future scoped tokens can move to KV; not v1.

### Vectorize

Index: 1536 dimensions, cosine distance metric. Metadata stored alongside vectors: `url`, `title`, `tags`, `created_at`. Locked to OpenAI `text-embedding-3-small` to allow drop-in migration of Backlite's existing embeddings.

### Migration script (`scripts/migrate.ts`)

A standalone TypeScript script in this repo (Node, run via `tsx`). Inputs: path to a Backlite SQLite file and the corresponding content directory; outputs to a configured R2 bucket + Vectorize index using the Cloudflare REST APIs (or S3-compatible API for R2).

Steps per row, ordered:

1. `SELECT * FROM readings ORDER BY created_at`.
2. Compute key prefix from row's `created_at`. PUT `manifest.json` to R2 with `If-None-Match: *`.
3. Copy raw + extracted bytes from `{content_dir}/readings/{id}/...` into the same prefix.
4. PUT `index/by-url/{sha256(url)}` pointer.
5. Parse the row's existing `embedding` JSON column; upsert `(id, embedding, metadata)` into Vectorize.
6. Append `(id, status, error)` to a CSV report on stdout.

Idempotent: re-runs against the same source + target either no-op or overwrite by-id. Does not mutate the Backlite DB or content directory (read-only).

### Repo layout

```
/src
  index.ts               # Worker entry + router + middleware
  /modules
    extractor/           # fetch + html→md + sniff
    anthropic/           # prompt + tool-use call + zod validation
    embeddings/          # openai text-embedding-3-small
    stores/
      reading-store.ts   # R2
      similarity-store.ts# Vectorize
  /schemas               # zod schemas (manifest, tool input, api types)
/scripts
  migrate.ts             # one-shot Backlite → R2/Vectorize backfill
/test
  /unit                  # per-module
  /integration           # miniflare + worker entry
wrangler.toml
package.json
README.md
```

## Testing Decisions

**What makes a good test in this repo:**

- Test external behavior, not internals. Each module's interface (inputs → outputs + side effects on injected dependencies) is what tests assert against.
- Inject `fetch` and bindings rather than mocking module internals. This lets tests pass realistic inputs and observe realistic outputs without coupling to implementation.
- Integration tests exercise the Worker end-to-end through HTTP, against Miniflare's in-memory R2 and a stubbed Vectorize binding. They are the ground truth for "does the wiring work."
- Unit tests cover the pure modules (extractor, schema validation, prompt builder, embeddings client, anthropic client) where setup is cheap.

**Modules that get unit tests:**

- `extractor` — input HTML/PDF/JSON/text fixtures → asserted markdown + content_type + size cap behavior + timeout behavior (with a slow injected `fetch`).
- `anthropic` — recorded `messages.create` responses (success + tool-validation-failure) → asserted typed output + usage extraction + error path.
- `embeddings` — recorded OpenAI responses → asserted `{ embedding, usage }` shape; bad-shape responses rejected.
- `schemas` — zod schemas validated against representative good and bad payloads.
- `stores/reading-store` — against an in-memory R2 stub: round-trip manifest, raw, extracted; conditional-write semantics for the by-url pointer.
- `stores/similarity-store` — against a stub Vectorize binding: upsert + query shape.

**Integration tests** (Vitest + `@cloudflare/vitest-pool-workers` or Miniflare equivalent) cover:

- Submit-and-poll: `POST /readings` → 202 → `GET /readings/:id` reports `pending` then `ready`. Anthropic + OpenAI fetches stubbed.
- Dedup: second `POST` with the same URL returns the existing id; no second Vectorize upsert.
- Lookup: known URL → 200 with id; unknown → 404.
- Similar: `POST /readings/similar` returns expected ordering against seeded Vectorize stub.
- Failure: unreachable URL → manifest ends `status: "failed"`, no by-url pointer.
- Auth: missing/wrong bearer → 401 on every protected route; `/health` works without.
- CORS: preflight from an allowlisted origin succeeds; from a non-allowlisted origin fails.

**Migration script tests** (vitest, Node):

- Given a small fixture SQLite file + a fixture content directory, the script produces the expected R2 keys, the expected Vectorize upserts, and the expected CSV report. R2 + Vectorize are stubbed at the HTTP-client layer.

**No live-API tests in CI.** Anthropic, OpenAI, and Vectorize are stubbed in all automated tests. Manual smoke against staging bindings is part of the Verification Plan.

## Out of Scope

- **Any change to `brian-bell/backlite`.** No SPA flag, no orchestrator changes, no Backlite-side cleanup, no removal of read-mode code from Backlite. Backlite continues to own reading mode for now; retirement is a separate effort.
- **Browser SPA.** Not in this repo. CORS is configured so a future SPA can be added elsewhere; the API contract is the only artifact this repo owns.
- **Cloudflare Browser Rendering** for JS-heavy pages or paywalled content. v1 uses `linkedom` + Readability only.
- **Multi-tenant auth, scoped tokens, KV-stored credentials.** Single bearer token, single user.
- **Cost dashboards or aggregation.** Raw `usage` fields land on the manifest; no rollup.
- **Auto-retry of stale `pending` readings.** Surfaced on read; manual re-submit only.
- **Workers AI bge-base-en (768 dim) or any non-1536-dim embedding.** Locked to OpenAI `text-embedding-3-small` to preserve migrated vectors.
- **Cloudflare Queues.** Background work uses `ctx.waitUntil()` only; queue-based processing is a future option if reliability requires it.

## Verification Plan

1. **Local dev.** `wrangler dev` with R2 bound to a staging bucket and Vectorize bound to a staging 1536-dim cosine index. `READER_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CORS_ALLOWED_ORIGINS` set as wrangler secrets/vars.
2. **Submit & poll.** `POST /readings { url: "https://example.com/article" }` returns 202; `GET /readings/{id}` reports `pending` then `ready` within ~30s. Confirm `manifest.json`, `raw.html`, `extracted.md` in R2 and a Vectorize entry at id.
3. **Dedup.** Submit the same URL again → 200 with the existing id; no duplicate Vectorize upsert; no second by-url pointer write.
4. **Lookup.** `GET /readings/lookup?url=…` resolves to `{ id }`; an unknown URL returns 404.
5. **Similar.** `POST /readings/similar` with a fresh query embedding returns sensible top-K with monotonic descending scores.
6. **Failure path.** Submit an unreachable URL; manifest ends `status: "failed"` with a structured `error`, no by-url pointer is written, Vectorize has no entry.
7. **Auth.** `curl` without bearer → 401 on every protected route; `/health` works without.
8. **CORS.** Browser preflight from an allowlisted origin succeeds; non-allowlisted origin fails.
9. **Cost tracking.** Confirm `manifest.usage.anthropic_input_tokens`, `anthropic_output_tokens`, and `openai_embedding_tokens` are populated for a successful reading.
10. **Migration dry-run.** Run `scripts/migrate.ts` against a copy of a Backlite SQLite snapshot + content dir, targeting a staging R2 bucket and Vectorize index. Diff: every row produces a manifest; manifest fields match the SQLite row; raw + extracted bytes match the originals (sha256); Vectorize count == row count. Re-running the script is idempotent.

## Further Notes

- **Why `linkedom` over `jsdom`.** `jsdom` doesn't run in Workers (no full DOM). `linkedom` does, and `@mozilla/readability` + `turndown` work against it. The plan acknowledges this as the v1 trade-off.
- **Why `ctx.waitUntil()` over Cloudflare Queues.** Simpler. The work is short (5–30s) and the user is one person. Queues become attractive if reliability becomes a concern; the manifest's `pending`/`failed` states are designed to make that swap straightforward.
- **Why R2 alone, no D1.** Personal scale. Listing N readings = N small object reads at most; the timestamped key prefix gives newest-first ordering without a secondary index. If list/filter performance ever bites, a denormalized list manifest or D1 can be added without changing the API surface.
- **Embedding dimension is load-bearing.** The 1536-dim cosine Vectorize index is locked to allow Backlite migration. Switching to bge-base-en (768) requires a re-embed + fresh index — explicitly out of scope.
- **Manifest `status` field is the contract for async-ness.** Any future client (SPA, CLI) only needs to know: `pending` → poll, `ready` → render, `failed` → show error, `stale_pending` → offer re-submit.
