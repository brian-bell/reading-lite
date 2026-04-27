# Redesigning Reading Mode around the Claude API (Cloudflare Workers + R2)

## Context

Reading mode in Backlite today runs inside a full task-orchestrator container pipeline (Docker → Claude Code agent → SQLite + filesystem) even though it does fundamentally simple work: fetch URL, extract main content, summarize, judge novelty against past readings, persist. The orchestration machinery (lifecycle Coordinator, image router, polling, container provisioning, retries, output storage, webhooks) is overkill for an operation that — at the LLM layer — is essentially one call.

The user is asking whether reading mode could be lifted out into a standalone TypeScript service on Cloudflare Workers, with R2 as the source of truth instead of SQLite. This plan answers two questions: (1) what fraction of reading mode actually requires Claude Code vs. raw Anthropic API, and (2) what an R2-backed Worker design would look like.

## How much of reading mode actually needs Claude Code?

**Almost none of it.** Evidence from the existing reader image (`docker/reader/reader-entrypoint.sh:91-145` and `docker/skill-agent/skills/read/SKILL.md`):

- The "agent" is given a single fixed prompt with a deterministic 7-step recipe.
- Typical tool-call sequence is 4 calls: `read-lookup.sh` → `WebFetch`/`Read` → `read-similar.sh` → output JSON.
- `--max-turns 50` is essentially never used; multi-turn only kicks in for retry on transient failures.
- The output is a strict JSON schema (`internal/skillcontract/schema.json`). No free-form reasoning trace is consumed downstream.
- No code execution, no multi-page crawling, no PR creation (explicitly forbidden in the prompt).

What Claude Code provides today that we'd need to replace:

| Claude Code feature | Replacement in Worker world |
|---|---|
| `WebFetch` tool | `fetch()` in the Worker (with Readability/Turndown pre-extraction) |
| `Bash` tool calling `read-lookup.sh` / `read-similar.sh` | Direct R2 + Vectorize calls inside the Worker, fed to the model as context |
| Multi-turn retry on bad output | Tool-use forcing (`tool_choice: {type: "tool", name: "emit_reading"}`) gives schema-valid output in one shot; bounded retry on parse/validation failure |
| Stream-json cost notarization | `usage.input_tokens` / `usage.output_tokens` from the Anthropic API response |
| Status.json contract | Native TypeScript types from a Zod schema; no shell glue |

**Bottom line: a single `messages.create` call with one forced tool use replaces the whole agent layer.** The remaining work — fetch, extract, embed, persist, search — is plain HTTP/storage and doesn't need an agent at all.

## Recommended architecture

A single Cloudflare Worker (`backlite-reader`) that owns the full reading lifecycle. R2 is the source of truth; **Cloudflare Vectorize** is the derived similarity index. No SQLite, no Docker, no orchestrator.

**Resolved choices** (from user):

- **Vector search:** Cloudflare Vectorize. Use the OpenAI `text-embedding-3-small` index (1536 dim) so historical readings migrate without re-embedding.
- **Migration:** Existing SQLite `readings` rows + on-disk content are migrated into R2/Vectorize. This pins us to OpenAI 1536-dim embeddings; do not switch to Workers AI's bge-base-en (768 dim) without a re-embed pass.
- **Request model:** `POST /readings` is async via `ctx.waitUntil()`. The Worker returns `202` immediately with the reading id; the SPA polls `GET /readings/:id` until the manifest's `status` flips to `ready`.
- **Cutover:** Coexist during transition. Backlite's read mode stays operational; the Worker stands up alongside, the SPA gets a feature flag to point at one or the other, and the Backlite read-mode code is deleted only after the Worker is proven.

### Data flow (async)

```
POST /readings { url }
   → Worker computes urlHash = sha256(url); GET index/by-url/{urlHash} (dedup gate)
       - if exists and !force → return 200 { id, status: "ready" }
   → Worker mints id = bf_<ulid>, writes a stub manifest with status="pending" to R2
   → Worker returns 202 { id, status: "pending", poll: "/readings/{id}" } and enters ctx.waitUntil():
       · fetch URL via fetch() (timeout + size cap)
       · extract HTML→Markdown (linkedom + @mozilla/readability + turndown);
         pass through PDF/JSON/text as-is
       · embed extracted text → query Vectorize for top-K similar (context for the LLM)
       · Anthropic messages.create with:
            - extracted markdown (or raw text)
            - top-K similar readings (id + tldr + url) as context
            - one tool: emit_reading(title, tldr, tags, keywords, people, orgs,
                                     novelty_verdict, connections[], summary_markdown)
            - tool_choice: { type: "tool", name: "emit_reading" }
       · embed the final TL;DR via OpenAI text-embedding-3-small
       · R2 writes:
            - readings/{id}/manifest.json   (status="ready", full record)
            - readings/{id}/raw.{ext}       (raw bytes)
            - readings/{id}/extracted.md    (when html)
            - index/by-url/{urlHash}        (tiny pointer → {id})
       · Vectorize upsert(id, embedding, metadata={url, title, tags, created_at})
       · on failure: write manifest with status="failed", error="…"; do not write index pointer
GET /readings/{id}  → SPA polls until status == "ready" | "failed"
```

### R2 layout (single source of truth)

```
readings/
  {id}/
    manifest.json     ← full record: id, url, title, tldr, tags, keywords, people,
                         orgs, novelty_verdict, connections, summary_markdown,
                         content_type, content_status, content_bytes, extracted_bytes,
                         content_sha256, fetched_at, created_at
                         (NB: embedding lives in Vectorize, not in the manifest, to keep
                         manifests small and fast to list/scan)
    raw.{html|pdf|json|txt|bin}
    extracted.md      ← when html
index/
  by-url/{sha256(url)}   ← tiny object whose key OR body holds the canonical reading id
                            (used by /readings/lookup as an O(1) GET-or-404)
```

R2 list-with-prefix replaces `ListReadings`. For newest-first listing, embed a sortable timestamp in the key (e.g. `readings/2026/04/26T143022Z-{id}/manifest.json`) and reverse-cursor; alternatively keep flat IDs and rely on Vectorize / a separate manifest index. Start with the timestamped-key approach — it's the simplest and works without any secondary index.

### Similarity search — Vectorize

`POST /readings/similar` is a single Vectorize `query()` call against the index, returning top-K with metadata (id, url, title, tags, created_at). This replaces the current O(n) JSON-decode + in-memory cosine scan in `internal/store/sqlite.go:561-608`. Index dimension is **1536** (OpenAI `text-embedding-3-small`) so migrated rows drop in unchanged. Use cosine distance metric.

### Embedding — OpenAI text-embedding-3-small

One `fetch()` to `https://api.openai.com/v1/embeddings`, same as `internal/embeddings/embeddings.go` today. Port the body verbatim to TypeScript. Dimension 1536, locked-in by the migration constraint above.

### Auth

Single bearer token in a Workers secret, checked on every route except `/health`. Mirrors the current `BACKFLOW_API_KEY` short-circuit pattern (`internal/api/auth.go`). If you want scoped tokens later, store them in KV — but for a personal service, one token is enough.

### API surface

Mirrors today's reading endpoints so the existing web SPA can point at it with no changes:

| Method + path | Behavior |
|---|---|
| `POST /readings` | Submit a URL. Synchronously fetches, summarizes, embeds, persists. Returns manifest. (Replaces `POST /api/v1/tasks` with `task_mode=read`.) |
| `GET /readings` | List, paginated. R2 list-with-prefix + cursor. |
| `GET /readings/:id` | Read `readings/{id}/manifest.json` from R2. |
| `GET /readings/:id/content` | Stream `readings/{id}/extracted.md`. 404 when `content_status != "captured"`. |
| `GET /readings/:id/content/raw` | Stream `readings/{id}/raw.{ext}` with stored `content_type`. |
| `GET /readings/lookup?url=` | GET `index/by-url/{sha256(url)}` — returns `{id}` or 404. |
| `POST /readings/similar` | Vectorize `query()` (or in-Worker scan) over body's `query_embedding`. |

Notable simplifications vs. today: no async task lifecycle (no `pending` → `running` → `completed` states), no webhooks needed for the read flow itself (the request is synchronous; if the user wants async, return 202 + a manifest URL), no `force` flag dance because dedup is a single conditional R2 PUT.

### Coexistence + cutover

Backlite's reading mode stays operational throughout. Both systems run in parallel until the Worker is proven, then Backlite-side reading code is deleted.

**During coexistence:**

- The SPA gets a build-time / `localStorage` flag (`backlite.readerBackend = "backlite" | "worker"`) that swaps the base URL for `/api/v1/readings*` calls. Default to `backlite` until the Worker is trusted.
- The Worker is the authoritative target for new submissions once the SPA flag flips. Backlite's read-mode endpoints remain readable but are no longer written to (orchestrator's read-mode dispatch can be left in place or feature-flagged off via env).
- Migration runs once before the cutover, ideally onto a staging Worker first. Re-running the migration is idempotent (manifest writes use `If-None-Match`; Vectorize upserts are by id).

**Migration script (Go, in `cmd/readings-migrate/`):**

1. Open `BACKFLOW_DATABASE_PATH`, `SELECT *` from `readings` ordered by `created_at`.
2. For each row: write `readings/{id}/manifest.json` to R2 (S3-compatible API, `If-None-Match: *` for safety). Copy `{BACKFLOW_DATA_DIR}/readings/{id}/raw.*` and `extracted.md` to the same R2 prefix. Write `index/by-url/{sha256(url)}` pointer.
3. For each row: parse the existing `embedding` JSON column, upsert `(id, embedding, metadata)` into Vectorize.
4. Stream a CSV report of `(id, status, error)` to stdout for verification.

**End state cleanup (after Worker proven, separate PR):**

- Delete `docker/reader/` and `docker/skill-agent/skills/read/`.
- Drop `task_mode = "read"` from the model and image router (`internal/orchestrator/imagerouter`).
- Delete `internal/orchestrator/monitor.go:handleReadingCompletion` and the dispatch-time read guard in `internal/orchestrator/dispatch.go:49-85`.
- Remove the `readings` table (new migration), `internal/embeddings/`, `outputs.SaveReadingContent`, and the reading API endpoints (`internal/api/handlers.go:166-485`).
- Drop the SPA's `backlite` branch of the backend flag and its calls into Backlite for readings.

The cross-coupling check from exploration confirms this is safe: readings have no `parent_task_id`, the lifecycle Coordinator has no reading-specific paths, and self-review chaining is gated to `TaskMode=code` only (`internal/orchestrator/chain/chain.go:56`).

## Trade-offs worth flagging

- **HTML extraction in Workers.** `jsdom` doesn't run in Workers (no full DOM). Use `linkedom` (Workers-compatible) + `@mozilla/readability` + `turndown`. For pages that need a real browser (heavy JS, paywalls), Cloudflare Browser Rendering is the escape hatch — but it's not free. Start with linkedom; fall back only when needed.
- **R2 as sole source of truth.** Listing N readings = N small object reads (manifest fetch) unless you maintain a denormalized list manifest. For personal scale this is fine; for thousands of readings, add a "list manifest" object updated on each write, or move list/filter to D1.
- **No transactional dedup.** R2 supports conditional writes (If-None-Match), which is enough to make the URL-hash → manifest insert idempotent. The current SQLite `UPSERT` with unique URL index gives stricter guarantees, but for a personal reader the conditional-PUT pattern is sufficient.
- **Async semantics.** With `ctx.waitUntil()` the user sees `pending` for 5–30s. The manifest's `status` field (`pending` | `ready` | `failed`) drives SPA polling. Set a soft TTL on `pending` manifests (e.g. mark stale after 5 min) so a Worker that crashed mid-flight doesn't leave readings stuck.
- **Cost notarization.** Anthropic API responses include `usage` directly; record `input_tokens`/`output_tokens` (and OpenAI embedding token counts) on the manifest if you want cost tracking. Replaces today's stream-json scraping in `docker/skill-agent/entrypoint.sh`.
- **Migration constraint.** Because we're migrating existing rows, the Vectorize index dimension is locked to 1536 (OpenAI `text-embedding-3-small`). Switching to Workers AI bge-base-en (768 dim) would require a re-embed of every reading and a fresh index — out of scope here.

## Critical files referenced (today's implementation)

- `docker/reader/reader-entrypoint.sh:91-145` — the actual reading prompt (single-shot)
- `docker/reader/fetch-and-extract.sh` + `docker/reader/extractor/extract.js` — Readability/Turndown pipeline (port to TS for the Worker)
- `docker/skill-agent/skills/read/SKILL.md` — alternate skill-bundle prompt (same recipe)
- `internal/orchestrator/monitor.go:238-351` — `handleReadingCompletion` (replace with Worker write path)
- `internal/orchestrator/dispatch.go:49-85` — pre-dispatch URL dedup (replace with R2 conditional PUT)
- `internal/embeddings/embeddings.go` — single-call OpenAI embedder (port to TS verbatim)
- `internal/store/sqlite.go:561-608` — O(n) cosine similarity (replace with Vectorize)
- `internal/store/sqlite.go:384-502` — Reading CRUD (replace with R2 ops)
- `internal/api/handlers.go:166-485` — reading API endpoints (port to Worker routes)
- `internal/orchestrator/outputs/fs.go:62-91` — `SaveReadingContent` on-disk layout (move to R2)
- `internal/skillcontract/schema.json` — output schema (lift to Zod for the Worker's tool definition)
- `migrations/001_initial_schema.sql:57-75` + `migrations/003_reading_content.sql` — readings columns (input to migration script)
- `web/src/api.ts` + `web/src/App.tsx` — SPA consumer (point at Worker base URL)

## Verification plan

1. **Local dev.** `wrangler dev` with R2 bound to a staging bucket and Vectorize bound to a staging 1536-dim cosine index.
2. **Submit & poll.** `POST /readings { url: "https://example.com/article" }` returns 202; `GET /readings/{id}` reports `status: "pending"` then `status: "ready"` within ~30s. Confirm `manifest.json`, `raw.html`, `extracted.md` in R2 and a Vectorize entry at id.
3. **Dedup.** Submit the same URL again — 200 with the existing id, no duplicate Vectorize upsert, no second `index/by-url` pointer mutation.
4. **Lookup.** `GET /readings/lookup?url=…` resolves to `{id}`; an unknown URL returns 404.
5. **Similar.** `POST /readings/similar` with a fresh query embedding returns sensible top-K with monotonic descending scores.
6. **Failure path.** Submit an unreachable URL; manifest ends up `status: "failed"` with a structured `error`, no index pointer is written, Vectorize has no entry.
7. **Migration dry-run.** Run `cmd/readings-migrate` against a copy of production SQLite + content dir, targeting a staging R2 bucket and Vectorize index. Diff: every row produces a manifest; manifest fields match the SQLite row; raw + extracted bytes match the originals (sha256); Vectorize count == row count.
8. **SPA dual-backend.** Toggle `backlite.readerBackend` between `backlite` and `worker` in the SPA; list and detail pages render identically against either source. Submit through the worker path end-to-end.
9. **Cutover.** Run migration against production, flip the SPA flag default to `worker`, monitor for one week, then open a follow-up PR to delete read-mode code from Backlite.