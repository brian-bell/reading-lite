# Configuration

Non-secret variables live in [`wrangler.toml`](../wrangler.toml). Each environment
sets its own values; staging and production do not inherit local bindings or vars.
The table lists application defaults and checked-in overrides.

| Var | Default | Purpose |
|---|---|---|
| `APP_ENV` | `local`; `staging` and `production` in those environments | `staging` and `production` make the auth rate guard and Turnstile fail closed, require Resend for auth mail, and (staging only) apply the mail allowlist. |
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated origin allowlist for browser callers. Empty disables CORS preflight. |
| `MCP_ALLOWED_ORIGINS` | code default: `https://readinglite.ai`, `https://readinglite.app`; local sets `https://reading-lite.bbell.dev`; production sets the two public hosts; staging sets `https://staging.readinglite.ai` and `https://staging.readinglite.app` | Comma-separated Origin allowlist for `POST /mcp`. Requests with no Origin pass; unknown Origins are 403. |
| `PENDING_TTL_SECONDS` | `900` | A `pending` manifest whose active attempt is older than this is treated as stale; reads surface it as failed, and a new attempt may supersede it. |
| `FETCH_TIMEOUT_MS` | `20000` | Hard timeout for the source URL fetch. |
| `FETCH_MAX_BYTES` | `10485760` | Hard cap of 10 MiB on source response size. |
| `SUMMARIZER_PROVIDER` | `openai` locally; `anthropic` in staging and production | Summarization backend: `openai` or `anthropic`. Invalid values fail closed; there is no automatic fallback. |
| `OPENAI_SUMMARIZATION_MODEL` | `gpt-5.6-terra` | OpenAI Responses model used when the selected provider is OpenAI. |
| `OPENAI_SUMMARIZATION_REASONING_EFFORT` | `low` locally; `high` in staging and production | OpenAI reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` | `low` locally; `medium` in staging and production | Anthropic `output_config.effort` when the selected provider is Anthropic. Claude Sonnet 5.5 accepts `low`, `medium`, or `high` with `thinking: { type: "between_tools" }`. Invalid values, including OpenAI-only `none`, efforts the configured model cannot take, and pairs that 400 with that thinking setting (`xhigh` and `max` on Sonnet 5.5), fail closed. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model passed to `messages.create` when the selected provider is Anthropic. |
| `EMAIL_FROM` | `""` | Sender for notification emails on a verified Resend domain. Empty skips send. May include a display name (`Reading Lite <noreply@readinglite.app>`). Production uses that form; staging uses `RL Staging <noreply@staging.readinglite.app>`. |
| `EMAIL_TO` | `""` | Unused. Immediate notifications go to the current verified account email, `users.email_display`. |
| `AUTH_MAIL_ALLOWLIST` | unset; staging sets `""` | Staging only: comma-separated addresses that may receive auth, notification, and digest mail, plus `FOUNDER_EMAIL`. Ignored outside staging. |
| `WEB_BASE_URL` | `http://127.0.0.1:5174` locally (the `app/` dev server); `https://readinglite.ai/` in production; `https://staging.readinglite.ai/` in staging | Canonical base for digest mail, reading-notification mail, and MCP `public_url`. Magic-link mail prefers the request's recognized public host and falls back here. |
| `RETRY_MAX_ATTEMPTS` | `"3"` | In-call retry attempts for transient Anthropic/OpenAI failures. |
| `RETRY_BASE_DELAY_MS` | `"500"` | Base exponential-backoff delay for transient upstream retries. |
| `RETRY_MAX_DELAY_MS` | `"8000"` | Maximum in-call backoff for transient failures. A 429 leaves the retry loop as `RateLimitedError` for queue rescheduling. |
| `GUARD_POLICY_CACHE_MS` | unset (no caching); `5000` in staging and production | How long a usage-guard instance may reuse a tenant's limits row or the global concurrency limit. The deletion fence and paid-work switch are always read fresh. |
| `RELATIONSHIP_REFRESH` | unset; `1` in staging and production | Enables the weekly relationship scan and judge fan-out, which runs only for the active `FOUNDER_EMAIL` tenant with `TENANT_DATA_PLANE=1`. |
| `REFRESH_MAX_JUDGEMENTS` | `100`; staging `2`, production `100` | Weekly cap on relationship judgements, an integer from 1 to 1000. |
| `REFRESH_MAX_TENSION_JUDGEMENTS` | `100`; staging `2`, production `100` | Weekly cap on tension pair judgements, separate from `REFRESH_MAX_JUDGEMENTS`, an integer from 1 to 1000. |

Bindings are `READINGS_BUCKET` (R2), `HYPERDRIVE` (PostgreSQL; locally a
passthrough to the docker-compose `postgres` service on port 54329), the
`AUTH_RATE_GUARD`, `TENANT_USAGE_GUARD`, and `GLOBAL_USAGE_GUARD` Durable
Objects, and, in staging and production only, the `READING_JOBS`,
`DIGEST_JOBS`, `ACCOUNT_WIPE_JOBS`, `ARCHIVE_EXPORT_JOBS`, and
`RELATIONSHIP_REFRESH_JOBS` queues.
There is no D1 or Vectorize binding.

Set secrets with `wrangler secret put --env staging|production`. See
[required secrets](operations.md#secrets) for provider credentials, auth roots,
mail, and operator dotenv files.

## Tenant storage and hosted budgets

`TENANT_DATA_PLANE=1` is pinned in staging and production. Local development
leaves it unset. Read [tenant storage](architecture.md#tenant-storage) before
changing it; removing the pin can hide readings created after cutover.

Hosted paid work also depends on PostgreSQL policy rows and the GlobalUsageGuard
spend ledger. Provider credentials alone do not authorize dispatch. A missing global daily
cap, unsupported catalog, disabled paid-work switch, or exhausted tenant/global
budget blocks admission. Use the [paid-provider spend guide](paid-provider-spend.md)
for policy commands, accounting, and their limits.

`LOCAL_MAIL_SINK=1` is local-only. Never set it in staging or production.
`TURNSTILE_SITE_KEY` is public configuration; `TURNSTILE_SECRET_KEY` is a secret.
Open signup on staging/production requires successful verification before auth
mail can be sent. Staging bootstrap uses `invite_only`.
