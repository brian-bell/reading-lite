---
name: compare-summary-effort
description: Compare OpenAI and Anthropic summaries locally for existing reading-lite production readings while leaving production unchanged. Use when a user wants to rerun one or more captured articles at OpenAI efforts (including max) and/or Claude Sonnet; compare structured summaries, latency, and estimated USD against the production baseline; or inspect Luna vs Sonnet quality on N reading URLs or ids.
---

# Compare Production Summarizers

Use the bundled runner from the reading-lite repository root. It downloads stored
production Markdown and raw captures with authenticated `GET` requests, verifies
each raw capture's hash, freezes one comparison input per reading, calls the
repository's real `summarizeReading()` path (same OpenAI and Anthropic request
builders as the Worker), and writes local JSON and Markdown reports. It never
updates a reading row, its embedding, or other production state. Production OpenAI
stays `gpt-5.6-terra`; this workflow does not change Worker config.

This is the repeatable entry point for a Luna vs Sonnet (or OpenAI-effort)
comparison on real production readings. Do not use `ops eval summarizer` for
that job — that command is the fixture-based quality matrix, not live readings.

## Workflow

1. Run the dry-run first. Repeat `--target` for N readings (ids or canonical
   source URLs):

   ```zsh
   npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
     --target 'rd_EXAMPLE' \
     --target 'https://example.com/article' \
     --model gpt-5.6-luna \
     --effort max
   ```

   Credentials resolve in this order: process environment, `.prd.vars`,
   `.dev.vars`.

2. Review the printed matrix: readings × candidates, frozen-context counts,
   pricing date, and conservative cost ceiling. The default matrix is OpenAI
   `low`, `medium`, `high`, and `xhigh` plus one Anthropic call to
   `claude-sonnet-5` at pinned **`effort=low`** (`output_config.effort`; ambient
   `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` cannot change a run). Override OpenAI candidates by
   repeating `--effort` (`none|low|medium|high|xhigh|max`). Reserve `max` for
   an explicitly requested quality-first comparison. Pass `--openai-only` to
   skip Sonnet.

3. Anthropic effort is pinned to the actual `output_config.effort` sent. Default
   is `low`. Pass `--anthropic-effort` (`low|medium|high|xhigh|max`) to pin a
   different Sonnet 5 effort. `"none"` is OpenAI-only and is rejected. Ambient
   `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` cannot change a run. Incompatible
   `--anthropic-model` / `--anthropic-effort` pairs fail at argv parse, before
   freeze or spend.

4. Check current official OpenAI and Anthropic pricing when the runner's pricing
   date is stale or a model changed. Pass current standard rates with
   `--input-price`, `--output-price`, `--anthropic-input-price`,
   `--anthropic-output-price`, and `--price-date`. Do not silently rely on an old
   rate.

5. Obtain explicit user approval for the displayed paid-call matrix and cost
   ceiling immediately before execution. A current-turn instruction that already
   approves those calls and that ceiling is sufficient; do not ask twice.

6. Execute only after approval (`--execute` is the only paid path). Provider
   requests are admitted against a tenant's daily spend cap plus the global
   cap, so `--execute` requires `--env staging|production` (whose spend
   authority) and `--billing-tenant usr_…` (who pays; production uses
   `/api/whoami`'s `tenant_id`). A denial or an unpriced `--model` stops the run
   before the provider is called:

   ```zsh
   npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
     --target 'rd_EXAMPLE' \
     --target 'https://example.com/article' \
     --model gpt-5.6-luna \
     --effort max \
     --env production \
     --billing-tenant 'usr_EXAMPLE' \
     --execute
   ```

   Use `--output-dir <path>` when the user requests a specific destination.
   Otherwise artifacts go under
   `.summarizer-comparisons/<reading-id>/<timestamp>/` (one reading) or
   `.summarizer-comparisons/<timestamp>/` (N readings), which is gitignored.
   The runner prints that checkpoint directory before the first paid call and
   rewrites `results.json` and `report.md` after every successful candidate. If a
   later candidate fails, preserve and report those partial artifacts.

7. Read `report.md` and `results.json`. They include structured outputs, usage,
   latency, and estimated USD per candidate × reading. Compare factual coverage,
   specificity, synthesis, useful connections, entity quality, latency, and
   actual estimated cost. Give the user a concise recommendation; do not equate
   more reasoning tokens with better quality without evidence in the outputs.

## Comparison Integrity

- Keep the captured article, prompt, schema, and reconstructed similarity
  context identical across local candidates for that reading. The fresh OpenAI
  run is the fair within-matrix control; the production output is contextual
  baseline evidence.
- The original full top-K is not persisted. The runner reconstructs a
  stable context from the connections the production reading stores and
  resolves their current URL/title/TLDR. State this limitation in the handoff.
- Stop if a reading is not `ready` with captured content, its hash differs from
  the one the row records, a related reading cannot be resolved, or credentials
  are absent.
- Never use reprocess, import, queue, R2-write, or any database write for
  this workflow. Never deploy a model or effort change as part of a comparison.
- Do not copy the full article into result artifacts. The runner stores source
  identity, hash, frozen context, structured summaries, usage, latency, and
  cost.

## Useful Options

```zsh
# Luna max vs Sonnet on two production readings (the usual cross-provider run).
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
  --target rd_ONE \
  --target rd_TWO \
  --model gpt-5.6-luna \
  --effort max

# OpenAI-only effort sweep (skip Anthropic).
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
  --target rd_EXAMPLE \
  --model gpt-5.6-terra \
  --effort high \
  --effort xhigh \
  --openai-only

# Show all options without reading production or calling providers.
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts --help
```
