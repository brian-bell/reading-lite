---
name: compare-summary-effort
description: Compare OpenAI reasoning-effort summaries locally for an existing reading-lite production reading while leaving production unchanged. Use when a user wants to rerun one captured article at low, medium, high, xhigh, or max effort; compare those structured summaries with the production baseline; or inspect quality, latency, reasoning-token, and cost tradeoffs for a reading URL or id.
---

# Compare Summary Effort

Use the bundled runner from the reading-lite repository root. It downloads the
stored production Markdown with authenticated `GET` requests, verifies its hash,
freezes one comparison input, calls the repository's real OpenAI summarizer, and
writes local JSON and Markdown reports. It never updates a manifest, vector, list
row, or other production state.

## Workflow

1. Run the dry-run first:

   ```zsh
   npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
     --target 'https://example.com/article'
   ```

   Accept either a canonical source URL or a reading id. Credentials resolve in
   this order: process environment, `.prd.vars`, `.dev.vars`.

2. Review the resolved reading id, model, effort matrix, frozen-context count,
   pricing date, and conservative cost ceiling. The default matrix is `low`,
   `medium`, `high`, and `xhigh`. Override it by repeating `--effort`; reserve
   `max` for an explicitly requested quality-first comparison.

3. Check current official OpenAI pricing when the runner's pricing date is stale
   or the model changed. Pass current standard rates with `--input-price`,
   `--output-price`, and `--price-date`. Do not silently rely on an old rate.

4. Obtain explicit user approval for the displayed paid-call matrix and cost
   ceiling immediately before execution. A current-turn instruction that already
   approves those calls and that ceiling is sufficient; do not ask twice.

5. Execute only after approval:

   ```zsh
   npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
     --target 'https://example.com/article' \
     --execute
   ```

   Use `--output-dir <path>` when the user requests a specific destination.
   Otherwise artifacts go under
   `.summarizer-comparisons/<reading-id>/<timestamp>/`, which is gitignored.

6. Read `report.md` and `results.json`. Compare factual coverage, specificity,
   synthesis, useful connections, entity quality, latency, reasoning tokens, and
   actual estimated cost. Give the user a concise recommendation; do not equate
   more reasoning tokens with better quality without evidence in the outputs.

## Comparison Integrity

- Keep the model, captured article, prompt, schema, and reconstructed similarity
  context identical across local candidates. The fresh `low` run is the fair
  within-matrix control; the production output is contextual baseline evidence.
- The original full Vectorize top-K is not persisted. The runner reconstructs a
  stable context from the connections selected in the production manifest and
  resolves their current URL/title/TLDR. State this limitation in the handoff.
- Stop if the reading is not `ready` with captured content, its hash differs from
  the manifest, a related reading cannot be resolved, or credentials are absent.
- Never use reprocess, import, queue, R2-write, or Vectorize-write operations for
  this workflow. Never deploy a model or effort change as part of a comparison.
- Do not copy the full article into result artifacts. The runner stores source
  identity, hash, frozen context, structured summaries, usage, latency, and cost.

## Useful Options

```zsh
# Compare only high and xhigh with a model override.
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
  --target rd_EXAMPLE \
  --model gpt-5.6-terra \
  --effort high \
  --effort xhigh

# Show all options without reading production or calling OpenAI.
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts --help
```
