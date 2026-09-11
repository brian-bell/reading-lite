# API and MCP

The canonical API base is `https://readinglite.ai`. The same Worker also serves
`readinglite.app`. Staging is `https://staging.readinglite.ai` and
`https://staging.readinglite.app`.
[OpenAPI](openapi.yaml) defines the full schemas. Routes and validation live in
[`src/router.ts`](../src/router.ts) and [`src/schemas/`](../src/schemas/).

## Authentication

Scripts use `Authorization: Bearer <token>`. Create scoped tokens from a signed-in
session; creation returns the secret once. The founder bootstrap imports the
legacy `READER_API_TOKEN` into D1. Runtime authentication never falls back to that
secret when the D1 lookup fails.

The browser uses a host-only `__Host-session` cookie with `Secure`, `HttpOnly`,
`Path=/`, `SameSite=Lax`, and `Max-Age=7776000`. Login survives browser restarts;
D1 enforces 30-day inactivity and 90-day absolute expiry. A session on one host
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
| `GET /api/readings/lookup?url=` | 200 `{ id }` for a valid owner, including pending/failed, otherwise 404. No pointer claims, repair writes, or deep scans |
| `GET /api/readings/:id` | Full manifest with pending/ready/failed status, plus read-time `relationship_targets` |
| `GET /api/readings/:id/diagnostics` | Manifest, pointers, list row, R2 inventory, and recent attempt records |
| `POST /api/readings/:id/reprocess` | Fresh attempt on the same ID; optional `force` bypasses an active-attempt conflict, and optional `source: { kind: "markdown", markdown, title? }` supplies replacement text |
| `GET /api/readings/:id/content` | Streams `extracted.md`; 404 if content is not captured |
| `GET /api/readings/:id/content/raw` | Raw bytes with their stored content type |
| `DELETE /api/readings/:id` | Requires `readings:delete`; 409 while a non-stale attempt runs, 404 for unknown ID. Returns `{ id, vector_delete_requested, list_row_removed, by_url_released, objects_deleted }` |
| `POST /api/readings/similar` | `{ query_embedding: number[1536], k? }`; top-K matches in the caller's Vectorize namespace |

Read routes require `readings:read`; submit/reprocess/similar require
`readings:write`, and Markdown import requires `readings:import`.
List filtering reads the tenant's R2 `index/list.json`, maintained during
activation and terminal writes. Missing list indexes trigger scan-and-rebuild;
text search does not require Vectorize.

Supplied Markdown reprocessing takes precedence over stored text. Only success
changes `source_type` to `markdown`, enabling later source-less reuse. A failed
attempt preserves a previously ready manifest. Content artifacts can still
have changed; see [reprocessing limits](architecture.md#reprocessing-and-recovery).
Markdown must fit the 128 KB queue-message limit; an oversized envelope rolls
activation back and returns 503.

Single-reading purge requests vector deletion first, releases only its own
by-url pointer, removes the list row and objects, and deletes by-id last for
retry recovery. Other readings can retain inbound connections that return 404
until [purge-connections](operations.md#purging-connections-to-a-deleted-reading)
runs. A vector deletion acknowledgement is not proof of immediate absence.

The manifest includes source/content metadata, summary and entities, novelty,
connections, similarity, provider usage, and active/last attempts. Offline tension
refresh adds directional `tensions` and `tensions_judged`. Use
[the manifest schema](../src/schemas/manifest.ts) for exact optional fields;
[diagnostics](operations.md#diagnosing-a-single-reading) explains recovery.

The detail response also carries `relationship_targets`, a map from each
connection and tension target id to `{ url, title?, status }`, resolved at read
time from the same tenant's list index. It is never stored on the manifest, and
an id absent from the map is removed or unavailable. MCP `get_reading` omits it.

## MCP connector

`POST /mcp` is a stateless Streamable HTTP MCP server. Tools dispatch internally
through the authenticated HTTP API using the caller's bearer token. There is
no OAuth and no network re-fetch of the public host.

| Tools | Result or action |
|---|---|
| `list_readings`, `search_readings` | Metadata, with pagination/filtering |
| `get_reading`, `get_reading_content` | Manifest or opt-in extracted Markdown by ID |
| `get_diagnostics` | Pointer/content/attempt diagnostics |
| `submit_url`, `import_markdown`, `reprocess_reading` | Corpus writes subject to the caller's scopes |

Successful imports include `public_url` and `public_markdown_link` when
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
