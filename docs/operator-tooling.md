# Operator tooling inventory

One verdict per operator command and per storage-reading skill, decided against
the PostgreSQL + pgvector storage of [ADR 0005](decisions/0005-postgresql-storage.md).

Storage moved to PostgreSQL; R2 keeps captured content only. Since slice 1b
nothing writes `index/list.json`, a per-reading manifest, or a by-url pointer
object. A command that still reads one of those does not merely run slowly — it
reads a frozen or empty corpus and hands an operator a confidently wrong answer
just before they act on it. This inventory exists so every such command has a
decision on the record before any porting starts.

**This document is the source list for reading-lite-gh351.** gh351 retires from
this list and adds nothing to it: a command or skill that is not named here is
not retired by gh351.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| **port** | Survives, with its reads moved to a direct PostgreSQL connection (or, for deploy and staging, onto the new database lifecycle). A named later slice owns the port. |
| **Worker endpoint** | Survives, with its read moved behind HTTP on the Worker instead of a direct connection. |
| **retire now** | Its job cannot exist under the new schema. Deleted in this slice, with its libraries, registry entry and tests. |
| **retire in #351** | Its job is real today and disappears only when gh351 removes the resource it inspects. It must keep working until then, so it is **not** deleted here. |
| **unchanged** | Reads nothing that moved. It keeps working as written; where it resolves a handle through a module another slice rewrites, it recompiles against that module rather than changing behaviour. |

`retire now` and `retire in #351` are deliberately separate verdicts. They call
for opposite actions in this slice — one deletes the command, the other
requires it to keep running — so collapsing them into a single "retire" bucket
would give this inventory acceptance criteria that contradict each other.

No command earned **Worker endpoint**. Every surviving read is either an
operator-only query that has no business as a public endpoint, or already runs
over HTTP against the reading API. The verdict stays in the table above because
gh351 and the later slices read this vocabulary.

### How the counts reconcile

The identity is over **inventory rows, not files on disk**:

- 44 rows, one per file in `scripts/ops-lib/commands/` at the time of this slice.
- 18 port + 0 Worker endpoint + 8 retire now + 1 retire in #351 + 17 unchanged = 44.
- Completed ports marked **ported** below still count in the port total.
- Eight files are deleted, so `ls scripts/ops-lib/commands/` reads **36**
  afterwards. Checking 44 against the directory listing is the wrong check.

`scripts/account-lib/vector-ledger.ts` and `scripts/account-lib/operator-ledger.ts`
are deleted in this slice as well. They are libraries, not commands, and are not
counted among the eight.

### What else the ledger's retirement took with it

The ledger reached past its own commands, so retiring it touched four surviving
files. Each change is the minimum needed to compile and stay honest; the ports
themselves belong to the slices named in the table.

- `scripts/corpus-lib/batch/run.ts` and `batch/write-phase.ts`: the `ledger`
  dependency and the ledger-before-upsert write. Nothing replaces it — under
  the new schema an embedding commits and deletes inside its reading's
  transaction. reading-lite-gh347.4.2 ports the rest of this write phase.
- `scripts/account-lib/vectors.ts`: `bareRepairAction` and `repairBareVector`,
  which were `account audit-bare-vectors`'s repair machinery and had no other
  caller. `enumerateNamespace` stays — the residue scan uses it.
- `scripts/account-lib/residue.ts`: ledger sources were removed in 4.6. Slice
  4.3 replaces the frozen list read with PostgreSQL reading/embedding observations
  and names control-plane sources `pg.*`. Legacy namespace enumeration remains
  independent evidence until Vectorize retirement.
- `scripts/ops-lib/commands/staging-prepare-context.ts` and
  `scripts/staging-lib/context-copy.ts`: slice 4.3 checks destination IDs and URL
  ownership in PostgreSQL. Its v2 artifact retains `readingIds` and carries row
  payloads, embeddings and referenced content, with no R2 metadata or Vectorize
  dependency.

The original inventory incorrectly assigned a manifest-layout read to `extract
agent` and a D1 connection to `system lease-clear`. Both already used their API
surfaces. Correcting those verdicts moves two rows from port to unchanged; it
does not retire either command.

The D1 migrations that created the ledger (`0010`, `0012`) and their tests are
left in place: they are that database's schema history, and gh351 removes the
D1 implementation. `test/unit/pg/control-plane-schema.test.ts` still names the
ledger tables, because what it asserts is that the PostgreSQL schema does
**not** contain them.

## Commands

### account

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `account audit-bare-vectors` | `account-audit-bare-vectors.ts` | `index/list.json`, R2 attempt keys, and the D1 `vector_ledger` through `scripts/account-lib/vector-ledger.ts`, hunting a vector with no reading behind it | **retire now** | A bare vector is unrepresentable. `reading_embeddings` has a foreign key to `readings`, so the condition it hunts cannot occur, and the ledger it queries is a table migration 0003 deliberately never creates. |
| `account residue-scan` | `account-residue-scan.ts` | PostgreSQL corpus/control-plane rows, tenant R2 prefixes, retained legacy Vectorize evidence | **ported** | Slice 4.3 preserves independent findings and visibility limits. Missing ready embeddings are diagnostics; row presence is residue. It observes deletion state and never authorizes teardown. |
| `account sweep-wipe-prefix` | `account-sweep-wipe-prefix.ts` | The `wipe/{tenantId}/progress.json` R2 prefix, plus a control-plane `wipe_progress` query offered as evidence in its pre-delete briefing | **retire in #351** | It is the tool that proves the prefix is empty before gh351 deletes it; a deletion gate that lost its in-flight-wipe evidence would be more dangerous than one that was ported. See [below](#account-sweep-wipe-prefix-1). |
| `account wipe` | `account-wipe.ts` | `users.status` and `wipe_progress` in PostgreSQL through `accountRemote` | **ported** | Slice 4.7 moved its handle and closes the session; 4.3 verifies the existing path. Deletion rules are unchanged. |

### corpus

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `corpus audit` | `corpus-audit.ts` | Walks `index/list.json` and every per-reading manifest over `wrangler r2` | **port** | The read is real work — the non-ready inventory — but its source is frozen. reading-lite-gh347.4.7 inventories non-ready readings from `readings` and runs orphan-duplicate detection over the returned rows as it did over the list index. |
| `corpus backfill-similarity` | `corpus-backfill-similarity.ts` | `index/list.json` plus manifests, writing a neighbour snapshot back | **retire now** | A one-time backfill of a field the reading-lite-gh348 importer carries over. There is nothing left to fill in. |
| `corpus backfill-source-date` | `corpus-backfill-source-date.ts` | `index/list.json` plus manifests, writing `source_date` back | **retire now** | The same: a one-time backfill of a field the gh348 importer carries over. |
| `corpus backfill-vectors` | `corpus-backfill-vectors.ts` | `index/list.json` and manifests to find ready readings with no vector, then re-embeds and records a ledger row | **retire now** | The drift it repaired was between two systems — a manifest in R2 and a vector in a separate Vectorize index, which could diverge silently. The embedding now commits and cascades inside the reading's own transaction, so there is no second system to drift from. See [below](#why-backfill-vectors-is-safe-to-retire) for the states that remain and why none of them is damage. Its ledger write also targets the table migration 0003 never creates. |
| `corpus delete-orphans` | `corpus-delete-orphans.ts` | `index/list.json` and the `readings/` prefix, looking for by-url pointers with no reading behind them | **retire now** | `reading_urls` is unique per tenant and the claim commits with the reading, so an orphaned claim cannot be left behind. |
| `corpus drop` | `corpus-drop.ts` | Resolves selectors against `index/list.json`, deletes the id-scoped R2 prefix and the by-url pointer, rewrites the list index, deletes the Vectorize vector | **port** | Dropping a reading is still real work. reading-lite-gh347.4.7 deletes the row and lets `reading_urls`, revisions, relationships and the embedding cascade; `--vectorize` goes with the index. Its R2 delete has to cover all three `contentKeys` tiers. |
| `corpus ingest` | `corpus-ingest.ts` | Tenant PostgreSQL readings, URL ownership and embeddings; captured bytes in R2 | **ported** | reading-lite-gh347.4.2 uses the shared transactional writer and resumes the same provider batch after interrupted publication. |
| `corpus normalize-tags` | `corpus-normalize-tags.ts` | `index/list.json` plus manifests, rewriting tags | **retire now** | A one-time backfill of a field the gh348 importer carries over. |
| `corpus purge-connections` | `corpus-purge-connections.ts` | Parses every manifest to find inbound connections naming a deleted reading, and rewrites them | **port** | The dangling-inbound problem survives: `reading_relationships` has a foreign key on the source only, so a deleted reading leaves every inbound row naming it as `target_id`. reading-lite-gh347.4.7 replaces the manifest rewrite with one `DELETE ... WHERE target_id = $1`. The CAS loop and its conflict budget went with the manifests; `--sole-writer` did not, because a publisher in flight can still commit an inbound row after the DELETE's snapshot and no statement can exclude it. A post-delete recount checks that assertion and exits 1 on leftovers. |
| `corpus rebuild-list` | `corpus-rebuild-list.ts` | Scans every manifest under `readings/` and rewrites `index/list.json` from them | **retire now** | There is no denormalized list to rebuild. The list is a query over `readings`, which cannot drift from itself. |
| `corpus recover` | `corpus-recover.ts` | Audit input and tenant PostgreSQL readings; batch content in R2 | **ported** | reading-lite-gh347.4.7 ports monitor reads; reading-lite-gh347.4.2 ports offline activation and publication. |
| `corpus refresh-connections` | `corpus-refresh-connections.ts` | `index/list.json` and manifests, judging connections and writing them back through a manifest compare-and-set | **port** | reading-lite-gh347.4.1. A judged set becomes rows in `reading_relationships` plus the load-bearing summary flags on the current `reading_revisions` row, which are what distinguish an empty set from an uncomputed one. |
| `corpus refresh-neighbours` | `corpus-refresh-neighbours.ts` | A Vectorize top-K query plus manifests, writing the neighbour snapshot through the list-index CAS | **port** | reading-lite-gh347.4.1. The snapshot becomes the `readings.similarity` column, written through a seam on the operator's corpus view — not on `PgSimilarityStore`, which covers `reading_embeddings` and stays read-only. |
| `corpus refresh-tensions` | `corpus-refresh-tensions.ts` | `index/list.json` and manifests, judging tensions and writing them back through a manifest compare-and-set | **port** | reading-lite-gh347.4.1, alongside connections; `tensions_present` and `tensions_judged` carry the same absent-versus-empty distinction. |
| `corpus seed-vector-ledger` | `corpus-seed-vector-ledger.ts` | `index/list.json` and R2 attempt keys, inserting missing rows into the D1 `vector_ledger` | **retire now** | Migration 0003 deliberately never creates `vector_ledger` — embeddings are rows of `reading_embeddings` and delete with their reading in one transaction — so this seeds a table that cannot exist. |
| `corpus sweep` | `corpus-sweep.ts` | `index/list.json` to group URL spellings, then deletes the losing copies' R2 objects, pointers, list rows and vectors | **port** | Two spellings of one resource is a URL-level problem the unique constraint does not solve. reading-lite-gh347.4.7 groups canonicalized URLs over `readings.url`; the keep-ranking has to read the same fields it ranks on today. |

### db

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `db migrate` | `db-migrate.ts` | Pending migrations over a direct PostgreSQL connection named by `--database-url-env` | **unchanged** | Built on the epic branch, already on the new storage. It is the shape every ported command copies. |

### deploy

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `deploy release` | `deploy-release.ts` | Release evidence and git provenance; composes `deploy wipe-check` and `deploy worker` | **unchanged** | It reads no storage of its own and inherits whatever the commands it composes do. |
| `deploy web` | `deploy-web.ts` | Wrangler Pages deployment state | **unchanged** | Pages deployment; it never touched R2, D1 or Vectorize. |
| `deploy wipe-check` | `deploy-wipe-check.ts` | Unfinished wipes, already over a direct connection through `scripts/lib/wipe-deploy-gate.ts` and `sqlFromConnectionString` | **unchanged** | Verified rather than assumed: it is already on PostgreSQL and does not reach wrangler D1. |
| `deploy worker` | `deploy-worker.ts` | Preflight checks; no schema step at all, which it stated outright | **port** | A release whose code expected a new column could reach production against a database that lacked it. Ported in reading-lite-gh347.4.4: pending PostgreSQL migrations are applied before upload, fail-closed, with `--env` checked against a now-required `--database-url-env`. |

### eval

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `eval summarizer` | `eval-summarizer.ts` | Checked-in fixtures on disk; resolves its billing tenant through `scripts/ops-lib/operator-spend.ts` | **unchanged** | The fixture matrix reads no corpus storage. Its spend handle resolves through the pairing reading-lite-gh347.4.7 rewrites, so it recompiles against the new pairing without a behaviour change. |

### extract

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `extract agent` | `extract-agent.ts` | Reading API list responses and local browser extraction; submits Markdown through the API | **unchanged** | Its storage seam is the reading API. There is no direct R2 content-key derivation to port. |
| `extract probe` | `extract-probe.ts` | Fetches a URL and reports what egress sees | **unchanged** | A pure network probe, with no corpus read at all. |

### founder

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `founder bootstrap` | `founder-bootstrap.ts` | Control-plane founder rows, already through `--database-url-env` and `sqlFromConnectionString` | **unchanged** | Verified rather than assumed: it is already on a direct connection. The dead `makeWranglerD1` left behind in `scripts/lib/founder-bootstrap.ts` was removed by reading-lite-gh347.4.3, not by a change to this command. |

### import

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `import bookmarks` | `import-bookmarks.ts` | A local bookmarks export plus a local index-store file; submits over the reading API | **unchanged** | Every corpus effect goes through HTTP, so the storage move is invisible to it. |
| `import markdown` | `import-markdown.ts` | Local Markdown files; submits over `POST /api/readings/import-markdown` | **unchanged** | The same: local files in, HTTP out. |
| `import reddit` | `import-reddit.ts` | A Reddit thread `.json` fetched locally; submits over the reading API | **unchanged** | The same. |
| `import youtube` | `import-youtube.ts` | oEmbed, the watch page and a `yt-dlp` transcript; submits over the reading API | **unchanged** | The same. |

### reading and reading-list

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `reading submit` | `reading-submit.ts` | Submits one URL over the reading API | **unchanged** | HTTP only. |
| `reading-list check` | `reading-list-check.ts` | `index/list.json` straight from R2, to mark each exported URL processed or not | **port** | Left unported it marks every saved URL unprocessed, and `reading-list process` then resubmits the corpus. reading-lite-gh347.4.7 resolves each URL against `reading_urls`. |
| `reading-list process` | `reading-list-process.ts` | The marked export file; submits the unprocessed entries over the reading API | **unchanged** | It trusts `reading-list check`'s marks and submits over HTTP; the storage read it depends on lives in `check`. |

### staging

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `staging prepare-context` | `staging-prepare-context.ts` | PostgreSQL readings, ownership, current revision and embeddings; referenced R2 bytes and destination preconditions | **ported** | Slice 4.3 emits a private v2 packet of row payloads and content. Execution only writes local files; application is separately authorized. |
| `staging setup` | `staging-setup.ts` | Provisions the staging bucket, queues and config | **port** | reading-lite-gh347.4.8 adds the staging database alongside them and runs `ops db migrate` against it. |
| `staging smoke` | `staging-smoke.ts` | Drives the staging origin over HTTP and checks provider outcomes | **unchanged** | HTTP against the deployed staging Worker; reading-lite-gh347.4.8 verifies it passes rather than porting it. |
| `staging teardown` | `staging-teardown.ts` | Removes what `staging setup` created | **port** | It is setup's mirror image, so it has to remove the staging database too or the two drift. reading-lite-gh347.4.8 owns both halves. |
| `staging token-revocation` | `staging-token-revocation.ts` | The staging origin over HTTP, plus release evidence on disk | **unchanged** | Confirmed against reading-lite-gh347.4.3's open question: it holds no control-plane SQL, so it does not move into that slice. |

### system

| Command | File | Reads today | Verdict | Why |
| --- | --- | --- | --- | --- |
| `system lease-clear` | `system-lease-clear.ts` | Private Worker service binding for lease observation and fenced clearing | **unchanged** | It holds no control-plane SQL. Importing environment validation from policy.ts does not make it a D1 consumer. |
| `system policy` | `system-policy.ts` | Live PostgreSQL policy through `policyDb` and the operator database pairing | **ported** | Slice 4.7 moved the shared handle and session lifetime. Slice 4.3 verifies it rather than repeating the port. |
| `system status` | `system-status.ts` | Live PostgreSQL policy plus private Worker spend status | **ported** | Uses the same connection pairing and close discipline as system policy. |

## Skills

Skills that reached R2, D1 or Vectorize directly, plus the repository's
remaining skills for completeness. A skill's narration is an instruction to the
agent running it, so a skill left describing a storage read it no longer
performs is a wrong instruction, not stale prose.

| Skill | Reads today | Verdict | Why |
| --- | --- | --- | --- |
| `corpus-audit` | `index/list.json` and manifests from R2 through `wrangler r2 object get` | **port** | Follows `corpus audit`. reading-lite-gh347.4.7 rewrites the skill to describe the PostgreSQL reads and drops its "a Cloudflare session that can read R2" prerequisite. |
| `corpus-drop` | Resolves selectors against `index/list.json`; narrates deleting the manifest, attempts, by-url pointer and list entry | **port** | Follows `corpus drop`. Its narrated delete set becomes the row cascade plus the three `contentKeys` tiers of R2 content. |
| `corpus-sweep` | `index/list.json` plus Vectorize; documents needing R2 **and** Vectorize write credentials | **port** | Follows `corpus sweep`. The Vectorize credential requirement and the `--vectorize` flag go away with the index. |
| `corpus-recover` | PostgreSQL readings and exact pgvector similarity; immutable content in R2 | **ported** | The recovery skill documents tenant-scoped offline batches, direct database credentials and resume rules. |
| `check-reading-list` | `wrangler r2 object get <bucket>/index/list.json --remote --pipe` | **port** | Follows `reading-list check`. Its whole premise — an entry is processed only when its URL appears in `index/list.json` — becomes a `reading_urls` lookup. |
| `process-reading-list` | The marked export file; submits over the reading API | **unchanged** | It reads no storage directly. It pairs with `check-reading-list`, whose read is the one that moves. |
| `compare-summary-effort` | Stored Markdown and raw captures over authenticated `GET`s against the reading API | **unchanged** | Verified rather than assumed: it reaches production over HTTP, not R2 or Vectorize. Its prose naming a "manifest" as the source of the frozen context is reconciled in reading-lite-gh347.4.5. |
| `reddit-import` | A Reddit thread `.json` through a logged-in browser; imports over `POST /api/readings/import-markdown` | **unchanged** | Local fetch in, HTTP out. |
| `youtube-import` | oEmbed, the watch page and `yt-dlp`; imports over the reading API | **unchanged** | Local fetch in, HTTP out. |
| `chrome-reading-list` | Chrome's local Sync Data LevelDB | **unchanged** | It never touched the corpus. |
| `reading-lite-local` | Local `wrangler dev` and the seeded fixture pack | **unchanged** | Local development only; the fixture pack moves with the seed script, not with this inventory. |
| `beads` | The beads database | **unchanged** | Work tracking, not storage. |

## The operator PostgreSQL seam

reading-lite-gh347.4.7 built the seam every surviving operator command needs
and moved the first commands onto it: `corpus audit`, `drop`, `sweep`,
`purge-connections`, `recover --monitor` and `reading-list check`.

**`scripts/pg-lib/operator-db.ts`** holds the bucket-to-database pairing and the
session lifetime. It pairs a bucket with a deploy environment and with the
**variable names** that may hold that environment's DIRECT connection string —
never a D1 database and a wrangler `--env`. An unrecognised bucket gets no
database, and a variable that names the other environment is refused, because
the variable name is the only evidence available before connecting. This is one
table, so the corpus commands and the `deploy worker` / `deploy wipe-check`
allowlist cannot disagree. `withOperatorSql` closes the session on success, on
usage error and on failure alike.

**`scripts/pg-lib/operator-corpus.ts`** is the operator's view of the corpus.
Every read delegates to `PgReadingStore` — the store the Worker reads through —
so the operator and the Worker cannot disagree about what a reading is, which
matters because the operator's answer is what an irreversible delete is planned
from. The only queries written there are ones that are not about a reading: the
attempt event log behind `corpus audit --deep`, and the DELETEs.

**`--tenant global` is refused** by all of them. It names the pre-tenant R2
layout — an empty key root — and no `readings` row can carry it. Left
resolvable it would report an empty corpus rather than a wrong question. The
R2-only commands that still address retained pre-tenant objects keep accepting
it.

**Deletion order is row first, objects second**, the ordering `purgeReading`
holds and the one the [deletion rules](operations.md#account-deletion) state. A
reading's captured content is resolved through `contentKeys`, which answers in
three tiers (the current revision, the latest capturing attempt, and the legacy
spelling under the stored `key_prefix`), and all three are read *before* the row
is deleted, because the third tier is derived from the `key_prefix` the row
takes with it.

The row delete is one transaction, so the reading stops being listed, readable,
searchable and the owner of its URL at a single instant. Deleting the bytes
first would mean a failed row delete — a dropped connection is enough — left a
live reading whose content 404s, and `corpus sweep` does this to ready
production readings. With the row gone first, a failed object delete leaves
only unreferenced residue: the command names the surviving keys and exits 1,
re-running will not retry them because the id no longer resolves, and an
account wipe removes them with the tenant's prefix. That is the same price
`src/reading-purge.ts` pays for making the visible half atomic.

**What the pairing rewrite took with it.** `scripts/account-lib/control-plane.ts`
and `scripts/ops-lib/database-url-env.ts` are gone, folded into the new module.
`system policy`, `system status`, `staging prepare-context` and
`account-lib/remote.ts` now resolve their control-plane handle over a direct
connection through it, and `account sweep-wipe-prefix` prints a `psql` evidence
query naming the paired variable instead of a `wrangler d1 execute` one.
`scripts/corpus-lib/delete-plan.ts` and `check-corpus-lib/fetch-index.ts` went
with the by-url pointer and the list index they read.

## Why `backfill-vectors` is safe to retire

This verdict was challenged in review, and the challenge was half right, so the
reasoning is recorded here rather than left in a table cell.

**The foreign key is not the reason.** `reading_embeddings` has
`FOREIGN KEY (tenant_id, reading_id) REFERENCES readings`, which prevents an
embedding without a reading — not a reading without an embedding. Anyone
reaching for the FK to argue that a ready reading must have an embedding has
the arrow backwards. (It *is* the right reason for `account audit-bare-vectors`,
whose quarry is a vector with no reading behind it.)

A ready reading genuinely can have no embedding row.
`PgReadingWriter.publish` computes
`searchable = tenantActive && ownsUrl && embedding !== null`, and when that is
false it commits the reading and deletes the embedding. So the question is not
whether the state exists; it is whether the state is *damage a repair command
should fix*. It is not:

- **A duplicate that does not own its URL** keeps no vector, exactly as it kept
  none in Vectorize. Backfilling it would be wrong, not a repair.
- **An inactive tenant's rows** are deliberately not searchable.
- **`embedding === null`** is unreachable from the realtime path:
  `publishReady` takes `number[]`, not a nullable.
- **The failure terminal** only deletes the embedding when the reading was
  never published. A published reading keeps its revision and its embedding.
- **Import-time misses** belong to reading-lite-gh348, whose importer re-embeds
  IDs that Vectorize `getByIds` does not return, from the stored
  `extracted.md`, and lists each one in its reconciliation report.

What the command actually repaired was divergence between two systems that
could not see each other: a manifest in R2 and a vector in a separate Vectorize
index. One transaction now holds both, so the divergence has no way to occur.

If a genuine embedding-less-but-searchable reading is ever observed, the repair
belongs on the ported corpus surface (reading-lite-gh347.4.7), not on a command
that scans `index/list.json` and writes a retired ledger. No such repair is
carried forward speculatively.

## `account sweep-wipe-prefix`

It is **retire in #351**, and it is worth stating plainly why it is not simply
"R2-only".

It is not R2-only. It imports `controlPlaneForBucket` from
`scripts/account-lib/control-plane.ts`, re-exports `CONTROL_PLANE_BY_BUCKET`,
and offers a control-plane `wipe_progress` query as evidence in its pre-delete
briefing — the evidence that distinguishes a wipe still running from records
that predate #195 S2. reading-lite-gh347.4.7 rewrites that pairing, so this
command cannot be left alone and still compile.

**The decision: its evidence read follows the new pairing.** Its R2 job is
unchanged — it still sweeps the `wipe/{tenantId}/progress.json` prefix — and
only the handle under its control-plane query moves. It is the tool that proves
that prefix is empty before gh351 deletes it, and a deletion gate that lost its
in-flight-wipe evidence would be more dangerous than one that was ported.

gh351 inherits this decision rather than rediscovering the coupling.
