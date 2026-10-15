# API and MCP

The canonical API base is `https://readinglite.ai`. The same Worker also serves
`readinglite.app`. Staging is `https://staging.readinglite.ai` and
`https://staging.readinglite.app`.
[OpenAPI](openapi.yaml) defines the full schemas. Routes and validation live in
[`src/router.ts`](../src/router.ts) and [`src/schemas/`](../src/schemas/).

## Authentication

Scripts use `Authorization: Bearer <token>`. Create scoped tokens from a signed-in
session; creation returns the secret once. The founder bootstrap imports the
legacy `READER_API_TOKEN` into PostgreSQL. Runtime authentication never falls back
to that secret when the database lookup fails.

The browser uses a host-only `__Host-session` cookie with `Secure`, `HttpOnly`,
`Path=/`, `SameSite=Lax`, and `Max-Age=7776000`. Login survives browser restarts;
the server enforces 30-day inactivity and 90-day absolute expiry. A session on one host
does not authenticate another. Bearer tokens work across the served hosts.

Cookie writes require an allowed origin and `X-CSRF-Token`, issued by
`GET /api/whoami` for session principals. A bad CSRF token returns 403 without
logging the caller out. Bearer requests are exempt from CSRF. Some account
operations require a session and recent authentication even if a bearer has
reading scopes.

`/health`, login options, challenge, and redeem are public entry points with
their own guards. The local-only `/api/dev/mailbox?email=` also requires no
principal, but only runs with the local mail sink on loopback. Logout handles
its own session/CSRF checks. Other application routes require authentication.

### Account routes

| Method and path | Behavior |
|---|---|
| `GET /health` | 200 `ok` |
| `GET /api/whoami` | Tenant/user identity, principal type, tenant data-plane flag, email; session principals also receive `csrf_token` |
| `GET /api/auth/login-options` | Same-origin, `no-store`; returns a Turnstile site key only for configured open signup, otherwise `null`; accepts origin-less same-origin GET through `Sec-Fetch-Site` |
| `POST /api/auth/challenge` | `{ email, turnstile_token? }`; eligible mail contains a 15-minute, newest-only magic link. Open signup requires Turnstile on staging/production; eligibility and Turnstile no-send outcomes use `{ ok: true }` |
| `POST /api/auth/redeem` | `{ credential, redemption_id }`; sets the session cookie. A live same-user session refreshes recent-auth time |
| `POST /api/auth/logout` | Revokes the session and clears its cookie; cookie CSRF required |
| `GET /api/auth/sessions` | Lists caller sessions, marks current and usable states, and warns at the 10-session cap; expired rows remain visible |
| `DELETE /api/auth/sessions/:id` | Revokes one session; clearing the current session also clears its cookie. No security mail |
| `POST /api/auth/sessions/revoke-all` | Revokes all sessions, logs out, and sends security mail; no recent-auth requirement |
| `POST /api/auth/email-change` | `{ email }`; session and recent auth required. Requests verification at the new address through the challenge/redeem flow |
| `POST /api/auth/tokens` | Session and recent auth required; `{ name, scopes, expires_at_ms? }`. Returns 201 with the token once; defaults to 90-day expiry; 409 at 10 active tokens, including the founder legacy token. Sends security mail |
| `GET /api/auth/tokens` | Session-only token metadata, including usable state; never returns secrets |
| `DELETE /api/auth/tokens/:id` | Session-only soft revoke; 404 if not owned; no recent-auth requirement or security mail |
| `GET /api/auth/settings` | Session-only full settings row; 404 when missing |
| `POST /api/auth/settings` | Session-only `{ notify_immediate }` plus optional `digest_cadence`, `time_zone`, `digest_hour_local`, `digest_weekday`; returns full settings. Cadence `off` disables digests |
| `POST /api/auth/provider/anthropic` | Session, CSRF, and recent sign-in. Body `{ api_key }`. Proves the key with a free `GET https://api.anthropic.com/v1/models/{ANTHROPIC_MODEL}` (`x-api-key`, `anthropic-version: 2023-06-01`, redirect manual; a non-200 body is discarded unread). 200 stores the encrypted key and returns masked settings only. Anthropic 401 is 400 `invalid_key`; 403 or 404 is 400 `model_access`; anything else, including a timeout or network failure, is 503 `provider_unavailable`. A failed check stores nothing. The write locks the user row and answers 403 with nothing stored when the user is missing or not active. Bearer 403. The key is never returned |
| `DELETE /api/auth/provider/anthropic` | Session, CSRF, and recent sign-in. Removes the Anthropic key and, when summarization was set to Anthropic, resets `summarization_provider` to `openai` in the same transaction. Returns masked settings. Bearer 403. Selecting Anthropic again without an active key is 400 `anthropic_key_required` from `POST /api/auth/provider/preferences` |
| `DELETE /api/account` | Session, CSRF, and recent auth required; `{ confirm: "delete" }`. Marks deleting, revokes sessions/tokens, sends security mail, and clears the cookie. Deferred wipe and cron teardown follow the [deletion rules](operations.md#account-deletion) |

## Reading routes

New submit/import requests return 202 `{ id, status: "pending", poll }`.
Poll `GET /api/readings/:id` until ready or failed. The app itself does not
poll. Ready/pending URL owners return 200 with the existing manifest; failed
owners reprocess under the same ID. Tenant rate/quota denials return 429 with
`Retry-After` and `reset_at`.

| Method and path | Behavior |
|---|---|
| `POST /api/readings` | `{ url, email? }`; notification defaults to true and goes to the current verified account address |
| `POST /api/readings/import-markdown` | `{ source_url, markdown, title?, email? }`; uses the URL for ownership and supplied Markdown for content. Email defaults to false; send-time import is always silent |
| `GET /api/readings` | Newest-first list; `q` matches title/TLDR/URL/keywords by case-insensitive substring; `tag` is an exact case-insensitive tag. `offset` defaults to 0, `limit` to 20 with range 1 to 100. Returns `{ readings, limit, offset, has_more }` |
| `GET /api/readings/lookup?url=` | 200 `{ id }` for a valid owner, including pending/failed, otherwise 404. No claims, repair writes, or scans |
| `GET /api/readings/relationships` | The tenant's relationship graph in one read: `{ readings, relationships }`. See [the relationships read](#the-relationships-read) |
| `GET /api/readings/:id` | Full manifest with pending/ready/failed status, plus read-time `relationship_targets` |
| `GET /api/readings/:id/diagnostics` | Manifest, list row, URL ownership (reported in the `pointers` shape), the R2 objects under its key prefix, and up to 20 recent attempt records |
| `POST /api/readings/:id/reprocess` | Fresh attempt on the same ID; optional `force` bypasses an active-attempt conflict, and optional `source: { kind: "markdown", markdown, title? }` supplies replacement text |
| `GET /api/readings/:id/content` | Streams the extracted Markdown; 404 if content is not captured |
| `GET /api/readings/:id/content/raw` | Raw bytes with their stored content type |
| `DELETE /api/readings/:id` | Requires `readings:delete`; 409 while a non-stale attempt runs, 404 for unknown ID. Returns `{ id, vector_delete_requested, list_row_removed, by_url_released, objects_deleted }` |
| `POST /api/readings/similar` | `{ query_embedding: number[1536], k? }` (`k` defaults to 10, max 50); returns `{ items }`, an exact cosine scan over the caller's ready readings' embeddings |

Read routes require `readings:read`; submit/reprocess/similar require
`readings:write`, and Markdown import requires `readings:import`.
List filtering is one query over the tenant's `readings` rows in PostgreSQL;
text search does not use embeddings.

Supplied Markdown reprocessing takes precedence over stored text. Only success
changes `source_type` to `markdown`, enabling later source-less reuse. Each
attempt writes under its own revision prefix, so a failed attempt leaves a
previously ready reading's content, summary, and embedding intact; see
[reprocessing](architecture.md#reprocessing-and-recovery).
Markdown must fit the 128 KB queue-message limit; an oversized envelope rolls
activation back and returns 503.

Single-reading purge deletes the reading's row in one transaction (its URL
ownership, revisions, relationships, embedding, attempts, and jobs cascade),
then deletes its R2 prefix. `by_url_released` is false when another reading
owns the URL; `vector_delete_requested` and `list_row_removed` are always true,
because the embedding and list row are the reading's own rows. A retried DELETE
is a 404. Other readings can retain inbound connections that return 404
until [purge-connections](operations.md#purging-connections-to-a-deleted-reading)
runs.

The manifest includes source/content metadata, summary and entities, novelty,
connections, similarity, provider usage, and active/last attempts. Offline tension
refresh adds directional `tensions` and `tensions_judged`. Use
[the manifest schema](../src/schemas/manifest.ts) for exact optional fields;
[diagnostics](operations.md#diagnosing-a-single-reading) explains recovery.

The detail response also carries `relationship_targets`, a map from each
connection and tension target id to `{ url, title?, status, created_at }`,
resolved at read time from the same tenant's reading rows. It is never stored on
the manifest, and an id absent from the map is removed or unavailable. MCP
`get_reading` omits it.

Each list row carries `connection_count` and `tension_count`: the reading's own
connections and tensions whose target still exists. Archive `index.json` items
do not carry them.

### The relationships read

`GET /api/readings/relationships` backs the Threads pages. `relationships` holds
every `reading_relationships` row whose target is a live reading, ordered by
`source_id`, then kind, then the row's position, each as
`{ source_id, kind, target_id, tension_kind?, reason }`; `tension_kind` appears
only on tensions. `readings` holds every ready reading, including ones with no
relationship, plus any reading at either end of a listed row, ordered by id,
each as `{ id, url, title?, status, tags?, created_at }` with read-time
staleness applied. It is one statement, so the two lists are one snapshot. A
purged target's rows are omitted rather than reported dangling. There is no
paging and no paid call.

## Desk routes

The desk holds at most three readings the reader means to read next
(reading-lite-kl7y.6). It lives in `reading_desk`, a side table cascading from
`readings`, so a purge or wipe frees the slot. Writes require `readings:write`
and answer 200 `{ desk: [id, …] }` in position order.

| Method and path | Behavior |
|---|---|
| `POST /api/desk` | `{ id }`; appends the reading. A reading already on the desk returns 200 unchanged, whatever its status. 404 for an unknown id; 409 `not_ready` unless the reading is ready; 409 `desk_full` `{ limit: 3 }` for a fourth |
| `DELETE /api/desk/:id` | Removes the reading; a reading not on the desk is a no-op. 404 for an unknown id |
| `DELETE /api/desk` | Clears the desk |

Each write takes the tenant's desk lock and the reading row `FOR SHARE`, then
renumbers the desk 1..n, closing a gap a purge left. A write never updates the
reading row, so it changes neither its `updated_at` nor the version a
concurrent reprocess compares. List rows and `GET /api/readings/:id` carry
`desk_position` (1–3) only for a reading on the desk; it is response state, not
part of the stored manifest, and the [archive](archive-export.md) carries it.

`GET /api/desk?since=<ISO>` (`readings:read`, reading-lite-kl7y.7) is the desk
page's one read: a READ ONLY snapshot whose rows are list items after read-time
staleness, grouped by the status staleness leaves them with.

| Group | Rows | Order and bound |
|---|---|---|
| `on_desk` | The desk, any status | Position; at most 3 |
| `needs_you` | Failed, or ready with a failed reprocess as `last_attempt` and no attempt running. A ready reading leaves when that reprocess `finished_at` is more than 7 days before the request | Newest first; 20, plus `needs_you_total` |
| `processing` | Pending | Newest first; 20, plus `processing_total` |
| `ready_since` | Ready, `created_at` after `since`, not on the desk | Newest first; 10, plus `ready_since_total` |

Without `since`, `ready_since` is empty and its total 0; a `since` that is not
an ISO date-time is 400. A ready reading leaves `needs_you` when its failed
reprocess `finished_at` is more than 7 days before the request, and it can
still be in `ready_since`. Exactly 7 days stays, a missing `finished_at`
stays, a running reprocess that has only passed the pending TTL stays, and
`status: failed` is not aged. The frontend's server render reads it through
`FrontendReads.desk`, with `since` from the reader's `rl_visit` cookie.

## Inbox routes

Markdown staged for review before it becomes a reading (reading-lite-gh423).
Staging writes only the inbox row: no reading, URL claim, attempt, job,
embedding or queue message, and no reading quota; it is charged one request
against the request rate. Inbox items never appear in the reading list, search,
similarity or `/lookup` until they are promoted.

| Method and path | Behavior |
|---|---|
| `POST /api/inbox` | `{ source_url, markdown, title? }` (title at most 1000 characters); requires `readings:import`. 201 `{ inbox_item_id, replaced: false }` for a new item; 200 `{ inbox_item_id, replaced: true }` when it overwrites the URL's item (same id; an omitted title clears it). A ready or pending reading that owns the URL returns 200 `{ existing: true, reading }`, stages nothing, and discards any item staged for the URL earlier; a failed owner adds `corpus_reading: { id, status }`. 413 `markdown_too_large` when the JSON of `source_url`, `title` and `markdown` exceeds 126,976 bytes (the 128,000-byte promote message less its envelope; an untitled item for a failed owner counts the owner's title, which promote keeps), or for a body too large to hold an item, with or without Content-Length; 429 `inbox_full` for a new URL at 200 items (an overwrite is allowed); 429 request rate; 403 for an account no longer active |
| `GET /api/inbox` | `{ items }`: every item's metadata (`id`, `url`, `title`, `markdown_bytes`, `created_at`, `updated_at`), most recently staged first; requires `readings:read` |
| `GET /api/inbox/:id` | One item with its `markdown`; 404 for an unknown id; requires `readings:read` |
| `POST /api/inbox/:id/promote` | Optional `{ email? }` (default `false`); requires `readings:import`. Imports the item's Markdown, URL and title exactly as `POST /api/readings/import-markdown` would, and answers with that route's status and body plus `inbox_item_id`: 202 for a new URL or an in-place re-import of a failed owner, 200 with the manifest for a ready or pending owner, and 409, 429, 503 or 403 as import-markdown gives them. The item is deleted only on 202 or 200; if it was re-staged while the import ran, the newer item is kept and the body adds `inbox_item_retained: true`. Every other outcome keeps the item. 413 `markdown_too_large` when the promote message would exceed 126,976 bytes, which happens only when an untitled item's failed owner lends a title stage did not count. 404 for an unknown id. The request rate and reading quota are charged here, not at stage |
| `DELETE /api/inbox/:id` | Discards the item (204); 404 for an unknown id; requires `readings:import` |

## MCP connector

`POST /mcp` is a stateless Streamable HTTP MCP server. Tools dispatch internally
through the authenticated HTTP API using the caller's bearer token. There is
no OAuth and no network re-fetch of the public host.

| Tools | Result or action |
|---|---|
| `list_readings`, `search_readings` | Metadata, with pagination/filtering |
| `get_reading`, `get_reading_content` | Manifest or opt-in extracted Markdown by ID |
| `get_diagnostics` | URL-ownership/content/attempt diagnostics |
| `submit_url`, `reprocess_reading` | Corpus writes subject to the caller's scopes. `reprocess_reading` refuses a Markdown source without dispatching |
| `delete_reading` | Deletes one reading through `DELETE /api/readings/:id` (requires `readings:delete`) and returns the purge report. A 404 or 409 from that route is a tool error with `http_status` and `error` |
| `import_markdown` | Stages Markdown through `POST /api/inbox`: `{ inbox_item_id, replaced, corpus_reading? }`, never a `public_url`. A ready or pending owner returns `{ existing: true, reading, public_url }` and stages nothing |
| `list_inbox`, `get_inbox_item`, `discard_inbox_item` | The caller's inbox: metadata, one item's Markdown (chunked like `get_reading_content`), or a discard |

There is no promote tool: agent-supplied Markdown reaches the library only when
a person promotes it with `POST /api/inbox/:id/promote`, which the web app's
Inbox page does with "Add to library". Results that name a
reading include `public_url` and `public_markdown_link` when
`WEB_BASE_URL` is configured. Production uses `https://readinglite.ai/`.
Use the [README connector example](../README.md#api-and-mcp) with your client's
remote-connector configuration. Never commit the bearer token.

`/api/mcp` is an alias covered by `/api/*`, useful when the dedicated `/mcp*`
route has not been attached. Both paths exist on the two production public
hosts and the two staging public hosts.
Local MCP is `http://127.0.0.1:8787/mcp`. Stdio-only clients can use
`npx mcp-remote https://readinglite.ai/mcp` with their bridge's authentication
configuration. [Operator MCP notes](operations.md#mcp-connector) cover origins,
route permissions, and handshake checks.
