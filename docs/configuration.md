# Configuration

Non-secret variables live in [`wrangler.toml`](../wrangler.toml). Each environment
sets its own values; staging and production do not inherit local bindings or vars.
The table lists application defaults and checked-in overrides.

| Var | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated origin allowlist for browser callers. Empty disables CORS preflight. |
| `MCP_ALLOWED_ORIGINS` | code default: `https://readinglite.ai`, `https://readinglite.app`; local sets `https://reading-lite.bbell.dev`; production sets both public hosts; staging sets its old host plus `https://staging.readinglite.ai` and `https://staging.readinglite.app` | Comma-separated Origin allowlist for `POST /mcp`. Requests with no Origin pass; unknown Origins are 403. |
| `PENDING_TTL_SECONDS` | `900` | A `pending` manifest whose active attempt is older than this is treated as stale; reads surface it as failed, and a new attempt may supersede it. |
| `FETCH_TIMEOUT_MS` | `20000` | Hard timeout for the source URL fetch. |
| `FETCH_MAX_BYTES` | `10485760` | Hard cap of 10 MiB on source response size. |
| `SUMMARIZER_PROVIDER` | `openai` | Summarization backend: `openai` or `anthropic`. Invalid values fail closed; there is no automatic fallback. |
| `OPENAI_SUMMARIZATION_MODEL` | `gpt-5.6-terra` | OpenAI Responses model used when the selected provider is OpenAI. |
| `OPENAI_SUMMARIZATION_REASONING_EFFORT` | `low` locally; `high` in staging and production | OpenAI reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` | `low` locally; `high` in staging and production | Anthropic `output_config.effort` when the selected provider is Anthropic. Claude Sonnet 5 accepts `low`, `medium`, `high`, `xhigh`, or `max`. Invalid values, including OpenAI-only `none`, efforts the configured model cannot take, and pairs that 400 with thinking disabled, fail closed. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Model passed to `messages.create` when the selected provider is Anthropic. |
| `EMAIL_FROM` | `""` | Sender for notification emails on a verified Resend domain. Empty skips send. |
| `EMAIL_TO` | `""` | Unused. Immediate notifications go to the current verified account email, `users.email_display`. |
| `WEB_BASE_URL` | `http://127.0.0.1:5173` locally; `https://staging.readinglite.ai/` in staging; `https://readinglite.ai/` in production | Canonical base for digest mail, reading-notification mail, and MCP `public_url`. Magic-link mail prefers the request's recognized public host and falls back here. |
| `RETRY_MAX_ATTEMPTS` | `"3"` | In-call retry attempts for transient Anthropic/OpenAI failures. |
| `RETRY_BASE_DELAY_MS` | `"500"` | Base exponential-backoff delay for transient upstream retries. |
| `RETRY_MAX_DELAY_MS` | `"8000"` | Maximum in-call backoff for transient failures. A 429 leaves the retry loop as `RateLimitedError` for queue rescheduling. |

Set secrets with `wrangler secret put --env staging|production`. See
[required secrets](operations.md#secrets) for provider credentials, auth roots,
mail, and operator dotenv files.

## Tenant storage and hosted budgets

`TENANT_DATA_PLANE=1` is pinned in staging and production. Local development
leaves it unset. Read [tenant storage](architecture.md#tenant-storage) before
changing it; removing the pin can hide readings created after cutover.

Hosted paid work also depends on D1 policy and the GlobalUsageGuard spend ledger.
Provider credentials alone do not authorize dispatch. A missing global daily
cap, unsupported catalog, disabled paid-work switch, or exhausted tenant/global
budget blocks admission. Use the [paid-provider spend guide](paid-provider-spend.md)
for policy commands, accounting, and their limits.

`LOCAL_MAIL_SINK=1` is local-only. Never set it in staging or production.
`TURNSTILE_SITE_KEY` is public configuration; `TURNSTILE_SECRET_KEY` is a secret.
Open signup on staging/production requires successful verification before auth
mail can be sent. Staging bootstrap uses `invite_only`.
