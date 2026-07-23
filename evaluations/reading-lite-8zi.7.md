# Provider summarization quality and staging handoff

Date: 2026-07-23

Beads: `reading-lite-8zi.7`

Branch: `feature/openai-summarization`

Status: **approved — ready for production rollout**

## Decision gate

On 2026-07-23, the operator explicitly approved `gpt-5.6-terra` at `low`
reasoning effort as the production default. This preserves the checked-in
configuration:

- `SUMMARIZER_PROVIDER=openai`
- `OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra`
- `OPENAI_SUMMARIZATION_REASONING_EFFORT=low`

Both providers passed their full executable staging matrix: realtime submit,
import, reprocess, and failure behavior; fresh and recovery batches; and
provider-pinned resume after the environment selected the other provider.
Replacement long-lived R2 credentials now pass a signed read through the
supported corpus client, and the production Anthropic key authenticates
successfully. Staging was restored to the approved OpenAI configuration after
the Anthropic run. No production deployment was attempted.

The automatic rubric favored Luna/low on this small corpus, but that result did
not override the human-approved Terra/low default.

## Fixed non-secret corpus

The repeatable corpus lives in
`scripts/summarizer-eval/fixtures.ts` and covers:

- a long technical argument;
- a short essay;
- a missing source title;
- dense named entities;
- imported YouTube markdown;
- imported Reddit markdown;
- duplicate, familiar, and novel similarity cases;
- prompt-injection text embedded in an article.

Each case pins required facts, retrieval terms, expected people and
organizations, novelty, allowed/expected connection IDs, and forbidden
injection output. The scorer records schema success, fact and retrieval
coverage, entity precision/recall/F1, novelty accuracy, connection boundaries,
injection resistance, p50/p95 latency, tokens, and dated cost estimates.

## Quality matrix

Command:

```sh
npm run summarizer-eval -- --execute --output-dir .summarizer-eval/full
```

Raw results and full generated summaries remain in the gitignored
`.summarizer-eval/full/` directory. The compact results were:

| Candidate | Schema | Strict material pass | Facts | Retrieval | Entities | Novelty | Connection bounds | Injection | p50 | p95 | Sync cost | Batch estimate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Anthropic Sonnet 4.6 | 100% | 40% | 69% | 73% | 99% | 100% | 100% | 100% | 9.73s | 21.51s | $0.1175 | $0.0588 |
| Terra none | 100% | 40% | 81% | 63% | 89% | 100% | 100% | 100% | 3.36s | 3.77s | $0.0548 | $0.0274 |
| Terra low | 100% | 60% | 79% | 67% | 89% | 100% | 100% | 100% | 2.81s | 4.30s | $0.0545 | $0.0272 |
| Terra medium | 100% | 40% | 75% | 67% | 89% | 100% | 100% | 100% | 2.97s | 6.98s | $0.0543 | $0.0271 |
| Luna low | 100% | 70% | 79% | 70% | 99% | 100% | 100% | 100% | 2.36s | 3.27s | $0.0221 | $0.0111 |
| Sol low | 100% | 40% | 73% | 53% | 99% | 100% | 100% | 100% | 4.10s | 6.04s | $0.0995 | $0.0498 |

The strict material-pass score is a deterministic regression signal, not a
substitute for human reading. Exact phrase and exact entity expectations make
it intentionally conservative. All 60 provider calls produced schema-valid
results, selected the expected novelty verdict, used only supplied connection
IDs, and ignored the prompt injection. No candidate cleared an 80% strict
material-pass bar. Luna/low had the strongest automatic score, lowest latency,
and lowest measured cost. Sonnet 4.6 tied Sol/Terra-none/Terra-medium on strict
material pass, led retrieval coverage, tied Luna/Sol on entities, and was the
slowest and most expensive candidate. Compact title/TLDR evidence appeared
broadly faithful across candidates.

Pricing is dated 2026-07-23. OpenAI rates came from the official
[GPT-5.6 announcement](https://openai.com/index/gpt-5-6/) and
[Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
Anthropic Sonnet 4.6 rates came from the official
[Claude pricing sheet](https://www-cdn.anthropic.com/files/4zrzovbb/website/5678bc2f5978e5bcd4f1fe7c14b2c72284dcf9f8.pdf).
Batch estimates apply the providers' documented 50% discount.

## Human decision

The operator reviewed the handoff and accepted Terra/low as the production
default on 2026-07-23. No per-candidate numeric worksheet scores were supplied;
the explicit default decision is the approval record.

## Live staging evidence

### OpenAI realtime

Deployed version: `c0549b79-529f-4e54-b94e-364adcd33e16`

The provider smoke exercised a fetched URL, markdown import, reprocess, a
deliberate fetch failure, diagnostics, and list visibility:

| Behavior | Reading | Result |
| --- | --- | --- |
| URL submit + reprocess | `rd_1GDHCB23CJ` | ready twice; the exact reprocess attempt became `last_attempt:succeeded`; OpenAI / `gpt-5.6-terra` |
| Markdown import | `rd_W2Q99Q69G2` | ready; OpenAI / `gpt-5.6-terra` |
| Deliberate unreachable URL | `rd_6YKATP58G0` | failed at `fetch_source` with retryable `BadStatusError` |
| List/diagnostics | all three | list status converged to manifest status; by-id/by-url pointers matched; attempt diagnostics present |

Evidence: `.summarizer-eval/staging-openai-final.json` (gitignored), followed
by a convergence read that proved ready/ready/failed manifest and index status.

### Anthropic realtime

Validated-key deployment: `cb7c3161-1a6a-45fc-bdfc-ccaf89c73413`

Wrangler version inspection confirmed `SUMMARIZER_PROVIDER=anthropic`. The
provider smoke then exercised the same realtime contract as OpenAI:

| Behavior | Reading | Result |
| --- | --- | --- |
| URL submit + reprocess | `rd_NR58ETKHVF` | ready twice; the exact reprocess attempt became `last_attempt:succeeded`; Anthropic / `claude-sonnet-4-6` |
| Markdown import | `rd_DBR3NR8GG2` | ready; Anthropic / `claude-sonnet-4-6` |
| Deliberate unreachable URL | `rd_W29H6X602Y` | failed at `fetch_source` with retryable `BadStatusError` |
| List/diagnostics | all three | list status converged to manifest status; by-id/by-url pointers matched; attempt diagnostics present |

Evidence: `.summarizer-eval/staging-anthropic-final.json` (gitignored).

### Restored staging state

Staging was restored from checked-in configuration:

- version: `1d46db94-378b-4916-a7de-88850a9683a7`
- `SUMMARIZER_PROVIDER=openai`
- model: `gpt-5.6-terra`
- effort: `low`

### Batch verification

At the time of the live batch matrix, the configured long-lived S3 credential
was stale. A gitignored, localhost-only Worker therefore used Wrangler's
authenticated remote R2 binding, while the replacement
`CORPUS_CF_API_TOKEN` accessed both Vectorize indexes through the existing
Vectorize REST client. That workaround exercised the existing batch pipeline
against the real `reading-lite-staging` R2 bucket and Vectorize index without
creating a persistent R2 credential. After the matrix completed, the operator
replaced the S3 credentials and a signed read through the supported corpus
client succeeded; future CLI runs no longer require the workaround.

Both staging queue consumers were removed before execution, verified absent,
and restored afterward with their original settings:

- main queue: batch 1, timeout 5 seconds, retries 3, concurrency 3, staging DLQ;
- DLQ: batch 10, timeout 5 seconds, retries 3, concurrency 1.

OpenAI fresh ingest:

- reading: `rd_FNZ3MG0XK6`;
- batch: `batch_6a61b3b7cacc81909d562b1162fba8ea`;
- the poller was stopped only after the V2 sidecar was durably
  `provider:openai`, `phase:submitted`, with that batch ID and
  `gpt-5.6-terra`;
- `SUMMARIZER_PROVIDER` was changed to `anthropic`;
- the next run resumed the same OpenAI batch, created no replacement batch,
  completed 1/1, wrote a `ready` manifest, and cleared the sidecar;
- terminal usage records OpenAI / `gpt-5.6-terra`.

OpenAI recovery:

- a fresh reading was deliberately failed with an invalid model in batch
  `batch_6a61b4d1207481909787bbbb71904dc4`;
- the resulting failed reading was `rd_WQJCJJA72M` with
  `OpenAIBatchFailed` at `summarize`;
- recovery batch `batch_6a61b55d2b60819095fa87c06cd1c66e` re-extracted the
  live Bankrate source, completed 1/1 with the valid Terra model, and restored
  that same reading to `ready`;
- the terminal manifest has no active/error state and records OpenAI /
  `gpt-5.6-terra` usage.

Anthropic fresh ingest:

- reading: `rd_QANGXW3R30`;
- batch: `msgbatch_013TCqs6BEf22dtUaVdghtiM`;
- the poller was stopped only after the V2 sidecar was durably
  `provider:anthropic`, `phase:submitted`, with that batch ID and
  `claude-sonnet-4-6`;
- `SUMMARIZER_PROVIDER` was changed to `openai`;
- the next run resumed the same Anthropic batch, created no replacement batch,
  completed 1/1, wrote a `ready` manifest, and cleared the sidecar;
- terminal usage records Anthropic / `claude-sonnet-4-6`.

Anthropic recovery:

- controlled invalid-model batch `msgbatch_01LyUbDUaSvvXgKeeh3M6Wpo` created
  failed reading `rd_7RZATDK3WJ` with `BatchRequestError` at `summarize`;
- after one transient source timeout, recovery batch
  `msgbatch_013U2522NhJVkxmZcRAjVWG8` re-extracted the live Bankrate source,
  completed 1/1 with Sonnet 4.6, and restored that same reading to `ready`;
- the terminal manifest has no active/error state and records Anthropic /
  `claude-sonnet-4-6` usage.

Together, these runs prove fresh batch, recovery batch, and sidecar-pinned
resume for both providers and in both environment-change directions.

## Operator readiness

The final operator gates were completed on 2026-07-23:

- the Anthropic key in `.prd.vars` authenticated against the Anthropic API;
- `CORPUS_R2_ACCESS_KEY` and `CORPUS_R2_SECRET_KEY` performed a signed read
  from `reading-lite-staging` through the repository's supported corpus client;
- the previously replaced `CORPUS_CF_API_TOKEN` has working Vectorize access;
- Terra/low was explicitly approved as the production default.

## Production and rollback

For a later production rollout:

1. run all root and SPA gates again;
2. inspect active sidecars before deployment;
3. deploy the Worker to production through the dry-run-first wrapper;
4. run one production smoke reading and inspect usage/diagnostics.

Rollback is an explicit provider change, never automatic fallback. Set
`SUMMARIZER_PROVIDER=anthropic` only after confirming a valid production
Anthropic secret, deploy, and verify a new reading. In-flight batch sidecars
remain pinned to their recorded provider and must be allowed to resume there.
