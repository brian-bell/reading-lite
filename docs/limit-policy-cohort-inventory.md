# Issue 193: read-only cohort inventory

Version `193-v2`, recorded September 6, 2026 UTC. This is evidence for a measurement proposal, not production approval. Issue: [#193](https://github.com/brian-bell/reading-lite/issues/193). Companion: [measurement proposal](limit-policy-measurement-proposal.md).

## Scope and provenance

Repository base: `2897208420082bb65b601be7ff2889c0d6c37160`, fetched from `origin/main` before work. Inventory: 00:38:11–00:39:21 UTC; selected-input verification completed 00:41:50 UTC. Used the existing production credential and authenticated GET requests to `readinglite.ai`: whoami, paginated list, manifests, captured Markdown, and raw content. No provider requests, intake, reprocess, policy commands, deployment, or production content writes were issued. Ordinary authentication bookkeeping may update token last-used state on GET requests.

Scope is one authenticated tenant's list-visible corpus. This is neither a multi-tenant inventory nor a deep R2 audit. Six list pages returned 573 unique IDs; all 573 manifests were read. The first page's IDs were unchanged on a final read. This provides a basic stability check, not an atomic snapshot of every page or manifest. Pending or unlisted artifacts may be absent.

The private, gitignored packet is `.summarizer-comparisons/193-v2-inventory/` in this worktree. It contains metadata-only inventory, deterministic selection, verification/quote results, GET request paths, reproduction scripts, and checksums. Raw article text, titles, summaries, URLs, email, and credentials are not persisted in the packet; host names and reading/connection IDs are. Content was processed in memory for verification and quoting. Do not publish the private packet implicitly.

## Population

- 573 list-visible readings: **559 ready, 14 failed, zero pending**.
- 544 captured, 15 raw-only, 14 failed-content records. All 544 captured records have `extracted_bytes` and are ready; these form the replay-eligible population.
- Source types: 305 URL, 149 Markdown, 119 unspecified legacy records.
- Creation dates: April 28 through September 5, 2026. This is an accumulated archive, not a recent-arrivals sample.
- 230 manifests record `gpt-5.6-terra`; 329 have legacy usage; 14 have no usage. All 230 Terra records are ready.
- **No manifest exposes reasoning effort.** Model, effort, service tier, request fingerprint, deployment provenance, and billing route cannot be reconstructed as a complete tuple from this inventory.
- 482 have a last-attempt summary; last triggers across the population are 209 reprocess, 137 submit, 136 import, and 91 absent. This mixed processing history is another reason not to label the archive a synchronous Terra/high run.
- Frequent hosts include X (121), YouTube (60), and GitHub (36). Domain is a content-mix indicator, not evidence that a particular extraction route succeeded.
- Current failure codes: `BadStatusError` 8; `XThreadOutsideRecentWindowError` 2; `RedditManualImportError` 2; `OpenAISourceRejectedError` 1; `QueueRetriesExhaustedError` 1. These are current terminal states, not a historical attempt-failure rate.

## Historical usage signal

Repricing the 230 persisted Terra usage records with the repository's **catalog 1** rates, including their recorded combined source/summary embedding tokens:

| Statistic | USD |
| --- | ---: |
| Mean | 0.018434 |
| p50 | 0.015676 |
| p95 | 0.045732 |
| Maximum | 0.066581 |
| Total across 230 records | 4.239795 |

These are unrounded arithmetic estimates from stored successful usage, not settled guard charges, provider invoices, or verified Terra/high measurements. They exclude missing/failed prior calls, retained uncertain reservations, and per-operation rounding. Historical batch/service-tier provenance is unknown. They cannot establish an all-in margin or observed spend total.

Formula: `(uncached input × 2 + cached input × 0.2 + cache-write input × 2.5 + output × 12 + embedding tokens × 0.02) / 1,000,000`, with the catalog's long-context rates above 272,000 input tokens. Reasoning tokens are already included in output tokens and are not added again. The calculation is catalog repricing, not a fresh assertion about current vendor prices; reverify official pricing before paid execution. Percentiles use nearest rank.

## Reproducible selection

Eligibility: ready, captured, known extracted size. Define length using UTF-8 `extracted_bytes`: short ≤4,000; medium >4,000 and ≤20,000; long >20,000. Define context groups by **selected connection count**, sparse 0–1 and connected ≥2. This is a proxy for context density, not historical full Vectorize top-K.

Within each of the six strata, sort ascending by SHA256 of UTF-8 `193-v2:<reading-id>` and take the first ten. No selection depends on measured cost or model. The immutable selected IDs are in `selection.json`; record its checksum with any later execution.

| Stratum | Population | Selected | Population weight |
| --- | ---: | ---: | ---: |
| Long, connected | 75 | 10 | 75/544 |
| Long, sparse | 58 | 10 | 58/544 |
| Medium, connected | 129 | 10 | 129/544 |
| Medium, sparse | 139 | 10 | 139/544 |
| Short, connected | 63 | 10 | 63/544 |
| Short, sparse | 80 | 10 | 80/544 |
| Total | 544 | 60 | 1 |

The 60 contain 29 URL, 16 Markdown, and 15 unspecified sources, including 17 X, six YouTube, and six GitHub readings. Source type and host are audited, not additional stratification dimensions. Weighted results represent this captured archive's length/context mix, not all customer saves.

Separately take the five largest captured sources, breaking ties by ID. None overlaps the 60. Sizes are 291,100; 283,308; 171,755; 170,953; and 160,258 extracted bytes. These five are stress cases and must not be folded into the representative mean. Their IDs are recorded in the private selection packet.

## Verification and reservation quotes

All **65/65** targets passed manifest-schema parsing, raw-content SHA256 agreement with both the live manifest and inventory snapshot, and extracted-byte-count agreement. All selected connection targets resolved through schema-valid manifests. The frozen Markdown and reconstructed context have separate SHA256 hashes. There were zero verification errors. The verification phase made 275 successful GET requests; the inventory made 581. Early access probes are not included in these successful-run counts.

Requests were built locally with the actual `buildSummarizeRequestBody`, `gpt-5.6-terra`, `high`, and 8,192 maximum output tokens. Context reconstructs the currently selected connection IDs' URL/title/TLDR, without historical scores. The production original full similarity prompt is not reproduced. No provider fetch occurred. `quotePaidRequest` from catalog 1 produced:

| Group | Summary holds, sum | Source-embedding holds, sum | Largest summary hold |
| --- | ---: | ---: | ---: |
| Main cohort, 60 | $10.135422 | $0.008391 | $0.467277 |
| Long-source stress, 5 | $4.926825 | $0.000926 | $1.662126 |
| Combined | $15.062247 | $0.009317 | $1.662126 |

Source-embedding requests use the production 8,000 UTF-16-character truncation rule with a trailing high-surrogate trim. Quotes use serialized UTF-8 request bytes plus 1,024 framing tokens; the most expensive input category bounds the reservation. This explains why standard-tier input reservations use 2.5 microdollars/token while ordinary uncached usage reprices at 2.

**The combined $15.071564 is not a complete-run ceiling.** It covers one summary and source-embedding request per frozen input only. New summary-embedding payloads are unknown until generation; retries, uncertainty, staged-context preparation, and different hosted context are additional. The largest frozen request is 301,910 bytes and invokes the catalog's conservative long-context tier. A $1 tenant daily budget cannot admit that request even on an otherwise empty day.

## What remains unknown

Effort provenance, historical paid retries, unreconciled charges, complete historical prompt context, fresh-extraction behavior, prospective customer mix, and end-to-end latency under a known deployment are not established. No live production configuration or authoritative accounting was queried in this inventory. Current token/usage evidence cannot replace a prospectively instrumented hosted measurement. The first-page stability check and per-target hash checks do not prove global snapshot isolation.
