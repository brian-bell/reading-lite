# Issue 193: measurement fixture revision 193-v2.1

Version: **193-v2.1**, September 6, 2026 UTC. This revision supersedes only the
context-fixture selection in [193-v2](limit-policy-measurement-proposal.md).
Brian authorized this revision and its local copy packet. Remote copying,
deployment, policy changes, provider calls, and production activation remain
outside that authorization. The original proposal and evidence remain intact.

## Exact revision

Exclude context seed `rd_45XAY3N8MM`, leaving **90 seeds**. Its ready manifest
specifies a 10,608-byte capture, but both raw and extracted files contain a
1,054-byte replacement; the raw SHA256 also differs. A failed August 30
reprocess wrote those files before summarization failed, then restored only
the earlier manifest. The retained legacy copy has the same mismatch. Searches
of local artifacts and candidate staging keys found no hash-verified original.
The full 91-seed integrity audit found this one failure and 90 passing seeds.

The **65 measured inputs are unchanged**: 60 representative readings, ten in
each original stratum, plus five stress readings. Preserve their exact IDs,
order, frozen raw/Markdown hashes, population weights, and reporting lanes.
The action mapping remains **54 imports and 11 same-ID reprocesses**. The
excluded seed is not a measured target. No replacement source is introduced.

Three measured targets historically selected the excluded connection:

| Target | Previous selected connections | Revised selected connections |
| --- | ---: | ---: |
| `rd_0JY59XCBKC` | 3 | 2 |
| `rd_9NPKRZQ9PC` | 5 | 4 |
| `rd_C66A4QVN8W` | 3 | 2 |

These counts describe the frozen selected-connection reconstruction, not a
prediction of hosted Vectorize top-K. Other targets can also see a changed
hosted neighbourhood. Keep the original strata for weighting and record actual
context IDs, scores, counts and request fingerprints for every measured run.
Copied manifests may retain historical references to the excluded ID; those
references are provenance, not an instruction to seed it. Do not rewrite
production relationships or fabricate a replacement vector.

## Economics and interpretation

Report results as prospective Terra/high measurements using revised staging
fixture **193-v2.1**. This revision changes context availability, not measured
source content. Neither revision reproduces historical full-corpus top-K.

All decision rules, accounting requirements, failure/stress reporting, and
proposed $25 shared additional staging charge ceiling from 193-v2 remain.
The original $15.071564 partial quote is historical and is **not a quote for
this revised hosted run**. Reconstructing three shortened connection lists
would still not establish the actual hosted requests. Refresh available exact
request quotes after staging preparation and account for all paid stages,
retries, and uncertain maxima under the separately approved live guard budget.
No paid execution is authorized by the fixture revision.

## Private artifacts and application gates

Private root: `.summarizer-comparisons/193-v2.1/`.

- `revision.json`: exclusion rationale, original/revised input hashes, and the
  three affected historical connection lists.
- `copy-input.json`: exactly 90 seeds and the unchanged 65 target specifications.
- `copy-packet/`: materialized payloads, destination preconditions, vectors,
  ledger IDs, merged list, target action map, and SHA256SUMS.
- `verification.json`: independent local packet verification results.

Apply the [context-copy application contract](staging-context-copy.md) only
under separate remote-write approval. Revalidate live source/destination state,
inspect quota/reservations through the updated private status capability after
its separately approved deployment, secure a staging writer window, and review
current financial baselines before any paid run. Local packet preparation does
not reserve resources or lock its observations.

## Local preparation result

The packet was generated and independently verified on September 6, 2026 UTC:
90 seed manifests/vectors, 447 conditional object creates plus one conditional
list update, and 389 content-addressed blobs (27,149,805 payload bytes). The
merged list contains 139 rows; all 49 existing rows are preserved exactly.
All 65 frozen target hashes and the 54/11 mapping passed verification. The
packet records 66 indexed title/TLDR differences and retains the production
vector metadata used as context. No attempt journals or checkpoints are copied.

The private verification record binds this revision to plan SHA256
`5c65c14010564026c7c019c2858de72fe0badb56c65fc5c5c05f713e69882177`.
Packet checksum, permissions, identities, payload references, frozen inputs,
and list-preservation checks all passed. The 193-v2 evidence is unchanged.
No remote application, deployment, policy update, or paid execution occurred.

## Subsequent approved stages

Status instrumentation was subsequently deployed to staging and verified, and
the 90-seed context packet was applied and verified under a reserved staging
writer window. These approvals did not authorize paid execution. See the
[next-stage handoff](193-v2.1-handoff.md) for the resulting state and evidence.
