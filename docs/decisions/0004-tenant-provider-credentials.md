# ADR 0004: Tenant provider credentials (BYOK) and archive export

- **Status:** Accepted. The settings API (`reading-lite-gh341.3`), key
  resolution at dispatch (`reading-lite-gh341.4`), provider error
  classification (`reading-lite-gh341.5`), and configuration snapshots
  (`reading-lite-gh341.6`) are implemented. Spend attribution and the rollout
  are not (`reading-lite-gh341` remains open).
- **Amended 2026-10-03** (`reading-lite-gh341.15`): Anthropic tenant keys.
  A tenant may add an optional Anthropic key and choose it for summaries and
  the relationship judges; embeddings stay on OpenAI. The amendment is written
  into the sections below and summarized in
  [Anthropic tenant keys](#anthropic-tenant-keys-amended-2026-10-03). It is
  approved before its storage work (`reading-lite-gh341.15.2`) starts.
  Written before [ADR 0005](0005-postgresql-storage.md). Credential storage is
  PostgreSQL. Processing checkpoints live on `reading_attempts.checkpoint`.
- **Date:** 2026-09-10
- **Decision owners:** Brian Bell
- **Task:** [#341](https://github.com/brian-bell/reading-lite/issues/341), under
  [#335](https://github.com/brian-bell/reading-lite/issues/335)
- **Scope:** Phase 6 backend contracts: provider credentials, processing
  configuration, spend attribution, and full-archive export
- **Satisfies:** #341's first acceptance criterion ("Brian approves the
  credential/model and queued-job/retry contract before storage/API
  implementation") and the matching open choices in the
  [product scope](../product/reading-lite-scope.md#deferred-work-and-open-choices)

## Context

Hosted processing uses deployment-wide secrets from `env`: `OPENAI_API_KEY`,
optional `ANTHROPIC_API_KEY`, `SUMMARIZER_PROVIDER`, and model and effort
variables. Four paid call sites read them:

| Call site | Where | Provider |
| --- | --- | --- |
| Source embedding | `embed_source` in `src/process-reading.ts` | OpenAI `text-embedding-3-small`, 1536 dimensions |
| Summarization | `summarize` in `src/process-reading.ts` | `SUMMARIZER_PROVIDER` (production and staging since 2026-09: Anthropic `claude-sonnet-5-5`, effort `medium`; the OpenAI model is `gpt-5.6-terra`) |
| Summary embedding | `embed_summary` in `src/process-reading.ts` | OpenAI embeddings |
| Weekly relationship refresh (connections and tensions) | `src/relationship-judge.ts` and `src/tension-judge.ts`, founder-only (`src/relationship-refresh.ts`) | `SUMMARIZER_PROVIDER` |

Every hosted provider fetch goes through `createPaidFetch`
(`src/control-plane/paid-dispatch.ts`): a tenant-plus-global daily spend
reservation in `GlobalUsageGuard`, a processing lease presented inside the HTTP
retry loop, and a fresh operation id per attempt. Spend denial defers the same
attempt for up to `PROCESSING_DEFER_MAX_AGE_MS` (24 hours). Provider 429s raise
`RateLimitedError`, which the queue retries with a delay. Source-embedding and
summary results are checkpointed per attempt on `reading_attempts.checkpoint`,
so redelivery skips completed calls.
See [paid spend](../paid-provider-spend.md).

There is no per-tenant credential storage, provider setting, or export route.
The [product scope](../product/reading-lite-scope.md) section B requires tenant
credentials with no fallback to Brian's key, encryption under a separate
server secret, masked metadata only, defined queued-work and retry behavior,
recorded configuration per attempt, and distinguishable user-funded and
operator-funded requests.

## Decision

### Providers and models

- A tenant connects **one OpenAI key**, required, which always pays for
  embeddings. The embedding space stays OpenAI `text-embedding-3-small` at 1536
  dimensions; there is no second embedding space.
- A tenant may also connect **one Anthropic key** (amended 2026-10-03). It is
  used only when the tenant selects Anthropic as the summarization provider.
- `user_settings.summarization_provider` is `openai` (the default) or
  `anthropic`. Summaries, the relationship judge, and the tension judge follow
  it. Selecting `anthropic` requires an `active` Anthropic key. Removing the
  Anthropic key resets the selection to `openai` in the same transaction. An
  Anthropic key marked `invalid` leaves the selection alone, so the reader sees
  `needs_provider_key` and intake refuses until the key is replaced, rather
  than silently switching providers.
- Whoami names the key that needs attention: beside the boolean
  `needs_provider_key`, `provider_key_provider` is `openai`, `anthropic`, or
  null. A missing or invalid OpenAI key wins, because embeddings need it
  whichever provider summarizes. The intake 409 `provider_key_required` body
  carries the same `provider`, so capture and the library can name the
  provider without loading provider settings.
- Each provider has **one fixed, catalog-verified model**: OpenAI
  `gpt-5.6-terra`, Anthropic `ANTHROPIC_MODEL` (`claude-sonnet-5-5`).
  Tenants choose only the reasoning effort: low, medium, or high, default high.
  The effort setting is shared between providers. Sonnet 5.5 accepts exactly
  those three (`ANTHROPIC_EFFORTS_BY_MODEL`), and `parseAnthropicEffort`
  validates it when the configuration is resolved, failing closed. Changing a
  model for everyone is an operator change with its own catalog, evaluation,
  and snapshot updates.
- MCP gains no provider tools.

### No fallback, including for Brian

- Hosted processing never uses deployment keys once an environment enables
  tenant keys. A missing, invalid, removed, or undecryptable key fails closed.
- Brian's account moves to his own stored key, through the same settings path new
  readers use.
- The weekly relationship refresh stays founder-only and is paid by Brian's
  tenant key for his selected summarization provider. In tenant mode both judges
  use the tenant's provider and effort, not `SUMMARIZER_PROVIDER` or the
  deployment effort variables. Opening it to other tenants needs a separate
  consent and cap design after beta.
- Rollout uses an environment switch, `TENANT_PROVIDER_KEYS=1`, that selects
  resolution wholesale: on means tenant keys only, off means deployment keys
  only. There is never a per-request fallback. Staging switches first, then
  production after Brian's production keys are connected and Anthropic is
  selected, so his first tenant-mode reading stays on Sonnet 5.5. Rollback turns
  the switch off while deployment keys are still configured. Deployment keys are
  removed from the Worker after an observation period; operator tools use
  locally supplied keys.

### Storage and encryption

- New PostgreSQL storage holds one row per tenant and provider (`openai` or
  `anthropic`), each with its own validation, mask, and status: ciphertext, IV,
  key version, a credential version that increments on every replace, the last
  four characters, status (`active` or `invalid`), and validated, created, and
  updated times. Effort is a separate tenant setting.
- Keys are encrypted with AES-256-GCM. The encryption key is derived by HKDF from
  a new `PROVIDER_KEY_SECRET`, separate from `AUTH_ROOT_SECRET`, with the key
  version in the HKDF info. The tenant id and credential version are bound as
  additional authenticated data, so a ciphertext copied to another tenant or
  credential version fails to decrypt. The provider is deliberately not in the
  AAD (accepted 2026-10-03): a ciphertext swapped between a tenant's two rows
  decrypts and sends one of that tenant's own keys to the other provider, which
  answers 401. No key crosses tenants.
- Rotation mirrors the auth root: `PROVIDER_KEY_PREVIOUS_SECRET` decrypts during
  a bounded window, and a plan-first `ops` command (`provider-keys reencrypt`)
  re-encrypts rows under the new version. Losing the secret makes stored keys
  unrecoverable; readers reconnect their keys, and no reading data is affected.
- Plaintext appears only in Worker memory for the duration of a provider call. It
  never enters logs, queue messages, checkpoints, manifests, attempt records,
  exports, browser storage, or responses. Provider error text is redacted before
  it is stored or returned, because OpenAI 401 messages echo part of the key.
  Anthropic error bodies are treated the same way.

### Settings API

- Connect, replace, remove, and read masked status through session-only account
  routes with CSRF. Connect, replace, and remove also require recent sign-in (the
  existing 10-minute rule). Bearer tokens get 403, so ordinary API and MCP tokens
  cannot read or manage credentials.
- The routes are `GET`, `POST`, and `DELETE /api/auth/provider`, beside
  `/api/auth/settings`. `POST` and `DELETE /api/auth/provider/anthropic`
  connect, replace, and remove the Anthropic key with the same gates. The
  provider selection is changed through `POST /api/auth/provider/preferences`
  beside effort and the cap, and is refused unless the Anthropic key is
  `active`. `/api/account` requires recent sign-in on every method, and effort
  and cap changes do not, so they do not live there. Connect and replace are
  `POST` because cookie CSRF covers `POST` and `DELETE`; `PUT` is exempt. `POST
  /api/auth/provider/preferences` changes effort and the daily cap with the
  settings route's gates (session, CSRF, no recent sign-in).
- Responses carry masked metadata only: provider, last four characters, status,
  and validated time, plus effort and the daily cap (the reader's cap, the
  effective cap, and the operator default on `tenant_limits`). The reader may
  lower the cap and may not set it above that default. The response is
  additive: `credential` stays the OpenAI view, and `anthropic_credential` (the
  same masked shape, or null) and `summarization_provider` are added.
- **Validation** on connect and replace calls OpenAI's free model-list endpoint
  and confirms the summarization and embedding models are available. It proves
  the key is valid and has access, not that billing has credit. A failed check
  rejects the key without storing it.
- Anthropic validation is a free `GET https://api.anthropic.com/v1/models/{ANTHROPIC_MODEL}`
  with `x-api-key` and `anthropic-version`, redirect manual, the body discarded
  on any non-200: 401 is `invalid_key`, 403 or 404 is `model_access`, anything
  else (including a timeout) is `provider_unavailable`.

### Dispatch, attempts, and checkpoints

- Each attempt records a configuration snapshot without secrets: provider,
  summarization model, effort, embedding model, and catalog version. Checkpoints
  are reused only when the snapshot matches; otherwise the stage runs again.
  Each delivery resolves the current settings, so a change made while an
  attempt is pending applies to its stages that have not run yet, and a
  completed stage whose configuration it changes runs again on the next
  delivery (a changed effort reruns the summary, not the source embedding).
- The key is resolved from PostgreSQL at every dispatch authorization, not once
  per attempt, for the provider the spend quote names (`quote.provider`). The
  paid fetch sets `x-api-key` for Anthropic and `authorization: Bearer` for
  OpenAI, and strips the other header. Marking a key invalid is fenced by
  provider and credential version, so an Anthropic 401 marks only the Anthropic
  row, and a 401 to a replaced key marks nothing. A replacement takes effect at
  the next call. Checkpoints survive a key replacement, because outputs do not
  depend on which key paid.
- The credential read must be strongly consistent with the removal write (no
  read-replica lag), so an acknowledged removal blocks every later dispatch.
- Requests already sent when a key is removed may finish and incur charges. The
  settings UI discloses this.

### Queued work and provider errors

| Condition | Behavior |
| --- | --- |
| No active key at intake (save, import, reprocess, inbox promote) | Refuse up front with 409 `provider_key_required`; nothing is claimed or reserved (decided 2026-09-24, gh341.11). Returning an existing reading is refused too |
| Key missing or removed at dispatch | Fail the attempt now with a "connect a key, then retry" error; no deferral |
| Decryption failure | Fail the attempt now; log for the operator; no fallback |
| Provider 401 | Fail the attempt now and mark the stored key `invalid`; settings shows "replace your key" |
| Provider 403 | Fail the attempt now with a model-access error; the key stays `active`, since a valid key without model or project access is not fixed by replacing it (amended 2026-09-30, gh341.5) |
| Provider 429 with `insufficient_quota` | Fail the attempt now with a billing message; no retry. Checked before the generic 429 path |
| Provider 429 rate limit | Existing `RateLimitedError` queue retry, then deferral |
| Provider 5xx or timeout | Existing HTTP retries within the spend and lease protections |
| Spend or hosting limit | Existing deferral through `DeferPaidWorkError` |

The table names OpenAI's responses. A tenant Anthropic key maps onto the same
codes (amended 2026-10-03):

| Anthropic response | Code and behavior |
| --- | --- |
| 401 `authentication_error` | `provider_key_invalid`; mark the Anthropic row `invalid` |
| 403 `permission_error`, 404 `not_found_error` | `provider_model_access`; the key stays `active` |
| 402 `billing_error`, or 400 `invalid_request_error` whose message names the credit balance | `provider_insufficient_quota` (`hosted_provider_quota` on deployment keys); no retry. The credit-balance shape is confirmed on staging with a real key (`reading-lite-gh341.15.8`) |
| 429 whose message names the organization's spend limit (a usage-tier monthly cap, which keeps failing until access resumes and may carry no `retry-after`) | `provider_insufficient_quota`; no retry. Checked before the generic 429 path, as OpenAI's `insufficient_quota` is. The shape is confirmed on staging with the credit-balance one (`reading-lite-gh341.15.8`) |
| Any other 429 | `RateLimitedError` queue retry, then deferral |
| 529 or other 5xx | Existing HTTP retries |

With Anthropic selected, a missing Anthropic key fails `summarize` and the
judges with `provider_key_required` while the OpenAI key keeps paying for
embeddings. There is no fallback to the OpenAI key or to deployment keys.

Failures use the existing `error.code` and `error.stage` fields with distinct
codes, so the frontend's failure mapping can separate key problems from provider
and hosting limits. The manifest error gains an optional `provider` so failure
copy can name the provider; no codes are added. Retries remain user-initiated
reprocesses.

### Spend and hosting limits

- Every hosted provider call keeps its spend reservation, lease check, and
  admission inside the retry loop.
- Each spend operation records who pays: `tenant` or `operator`. With tenant keys
  enabled, every hosted call is tenant-funded; operator-funded work is limited to
  operator tools, which stay outside hosted enforcement.
- The tenant daily cap starts at an operator-set default. Readers can lower their
  own cap but not raise it. The global daily cap remains an operator
  hosting-capacity control.
- Hosting limits (submissions per hour, monthly readings, concurrency) stay
  separate from spend and apply regardless of who pays.

### Account deletion

Deletion start writes the `users.status = deleting` fence in its own statement.
It then deletes every stored credential row and revokes sessions and tokens. That
second step runs again when the account is already deleting, so a crash after
the fence still removes the credential. A later failure does not roll the fence
back. There is no cancel path during the grace period, so nothing recoverable
is lost. Teardown still checks that no credential rows remain.

### Archive export

- A background job on a new, separate export queue builds one zip under the
  tenant's R2 root, written in parts so large archives stay within Worker limits
  and can resume after interruption. Its DLQ marks the export failed.
- Contents: every reading's manifest (summary, metadata, relationships),
  extracted Markdown, raw original, the list index, and a report listing missing
  artifacts per reading. Readings of every status are included.
- Excluded: attempt logs, processing checkpoints, internal pointers and
  tombstones, vectors, provider credentials, sessions, tokens, spend and quota
  records, and other internal security records.
- Download is session-only through an authenticated backend route, never a
  public URL. The zip expires and is deleted after seven days. Account wipes
  remove it with the rest of the tenant root.
- One export may be in progress per tenant, with at most one new export per day.
  This is a hosting limit and works without a connected key.

### Anthropic tenant keys (amended 2026-10-03)

Production and staging moved to `SUMMARIZER_PROVIDER=anthropic` on deployment
keys while tenant mode stayed wired to OpenAI. Turning on
`TENANT_PROVIDER_KEYS` would have moved every tenant, including Brian's corpus
and the founder refresh, from Sonnet 5.5 to `gpt-5.6-terra`. So Anthropic BYOK
ships before the rollout (`reading-lite-gh341.13` waits on it). In summary:

1. An optional Anthropic credential row beside the required OpenAI one.
2. `summarization_provider`, reset to `openai` when the Anthropic key is removed.
3. One fixed Anthropic model, `ANTHROPIC_MODEL`, with the shared effort.
4. Free single-model `GET` validation.
5. Provider-aware dispatch headers and a provider-fenced `markInvalid`.
6. The Anthropic failure table above, with an optional `provider` on errors.
7. An additive settings response and `/api/auth/provider/anthropic` routes.
8. Tenant, not provider, in the AAD.
9. Both judges follow the tenant's provider and effort.

## Consequences

- Phase 6 gains backend slices: credential storage and settings API, dispatch
  resolution and error classification, configuration snapshots, spend
  attribution, the rollout switch, deletion changes, and the export job and queue.
  None depend on the new frontend, so they can proceed alongside Phases 3–5.
- Tests with two tenants must prove correct credential dispatch through HTTP
  retries and queue redelivery, no fallback when the switch is on, and no
  credential access through reading API or MCP tokens.
- A fifth queue (export) joins reading, digest, relationship refresh, and wipe;
  each keeps its own DLQ behavior.
- Brian's processing cost moves to his own OpenAI and Anthropic accounts. Paid
  staging validation still requires separate approval.
- The global spend cap now limits user-funded throughput. Revisit its role once
  beta measurements separate hosting capacity from provider spend.

## Alternatives considered

- **OpenAI plus optional Anthropic at launch.** Deferred on 2026-09-10 for its
  two keys and extra failure states; accepted on 2026-10-03, because production
  had moved to Sonnet 5.5 and an OpenAI-only tenant mode would have changed
  Brian's summaries at rollout.
- **Anthropic-only tenants.** Embeddings need OpenAI, and a second embedding
  space would split similarity. Rejected; the OpenAI key stays required.
- **Falling back to OpenAI when the Anthropic key is invalid.** A silent provider
  change mid-library hides the problem, the same reason deployment-key fallback
  is rejected. The selection stays and the reader replaces the key.
- **Provider in the AAD.** Would catch a swapped row, but the swap needs
  database write access, and its worst case is a 401 with the tenant's own
  key. Not worth re-encrypting existing rows.
- **A curated model list.** Each model needs pricing, evaluation, and snapshot
  coverage; deferred in favor of effort choice on one model.
- **Founder keeps deployment keys.** It is the fallback the scope forbids and
  would not exercise the new-reader path. Rejected.
- **Per-tenant Durable Object for key storage.** Another storage path for
  deletion, rotation, and backup. Rejected.
- **Paid validation call.** Proves billing but charges the user; rejected for the
  free model-list check.
- **Deferring queued work up to 24 hours after key removal.** Hides the problem;
  rejected for an immediate actionable failure.
- **Pinning the key per attempt.** Replacing a key would fail in-progress work.
  Rejected for fresh resolution at each dispatch.
- **Streaming the export on request.** No stored copy, but large archives hit
  per-request limits and cannot resume. Rejected.
