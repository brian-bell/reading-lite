# Operator tooling under PostgreSQL

One decision for every `npm run ops` command and every skill that reached R2,
D1 or Vectorize directly. This is the source list for the retirement work in
[#351](https://github.com/brian-bell/reading-lite/issues/351): a row marked
**retire** here is a row #351 deletes, and #351 adds nothing to this list of
its own.

Storage moved to PostgreSQL with pgvector in [ADR 0005](decisions/0005-postgresql-storage.md).
R2 keeps captured content only. A command that used to read `index/list.json`
and per-reading manifests is not merely slower now — since slice 1b nothing
writes those objects, so it reads an empty or frozen corpus and reports
confidently wrong answers. That is why the ported commands below had to move in
this slice rather than at cutover.

## The three verdicts

**Port** — the command still has a job. It opens a direct PostgreSQL connection
with `pg` (never Hyperdrive, which is the Worker's path) and takes
`--database-url-env NAME`, defaulting to `DATABASE_URL`, matching `ops db
migrate` and `ops founder bootstrap`. Plan-first safety and the mandatory
`--tenant` on every `corpus` command are unchanged.

**Worker endpoint** — the job needs runtime authority the operator does not
have. Nothing landed here: every surviving operator job is expressible as a
tenant-scoped query, and moving them behind HTTP would make them unusable in
exactly the situation they exist for, when the Worker is refusing to deploy.
`corpus drop` and `account wipe` were the two candidates; both keep a direct
connection for that reason.

**Retire** — the state the command repaired cannot occur, or the object it
repaired no longer exists. These are not ported, per the slice's acceptance
criteria.

## Commands

44 files in `scripts/ops-lib/commands/`.

### Port (14)

| Command | What changes |
|---|---|
| `corpus audit` | Inventories non-ready readings from `readings` instead of walking `index/list.json` and every manifest. Orphan-duplicate detection becomes a join against `reading_urls`. |
| `corpus drop` | Deletes the row; `reading_urls`, revisions, relationships and the embedding cascade. No separate Vectorize delete, no list-index rewrite. Still refuses a ready reading without `--force`. |
| `corpus sweep` | Groups canonicalized URLs over `readings.url`, keeps the best copy, deletes the rest. The embedding delete it used to issue against Vectorize is now the cascade. |
| `corpus recover` | Reads the audit's `index.json` as before; the state it re-checks before acting comes from rows. Reprocess still goes through the reading API. |
| `corpus purge-connections` | **Still required.** `reading_relationships` has a foreign key on the *source* only, so deleting a reading leaves every inbound row that named it as `target_id`. One `DELETE … WHERE target_id = $1` replaces the manifest rewrite. |
| `corpus refresh-neighbours` | Similarity snapshots come from the exact pgvector cosine scan over the tenant's rows. |
| `corpus refresh-connections` | Judged connections are written with the writer's locked compare-and-replace instead of a manifest compare-and-set. |
| `corpus refresh-tensions` | Same, for tensions. |
| `corpus ingest` | The batch pipeline's two ownership predicates (`scripts/corpus-lib/batch/r2-ownership.ts`) become reads of `reading_urls`. Sidecars, resume rules and `--sole-writer` are unchanged. |
| `account wipe` | Plans and enqueues from `wipe_progress` rows (slice 1c) rather than the R2 progress object. |
| `account residue-scan` | Rewritten source set. `vector_ledger`, `ledger_vectors`, `listed_vectors` and the `d1.*` sources are gone; what remains is per-table row counts for the tenant plus the R2 prefix. |
| `extract agent` | Takes the content key from the reading's row rather than deriving it from the manifest layout. |
| `staging prepare-context` | Copies rows plus the R2 content they reference, not manifests, pointers and `index/list.json`. |
| `staging setup` / `staging teardown` | Provision and tear down the staging database alongside the bucket and queues, and run `ops db migrate` against it. Paired because they must stay mirror images. |

### Retire (9)

| Command | Why the job cannot exist |
|---|---|
| `corpus rebuild-list` | There is no denormalized list to rebuild; the library is a query with an index behind it. |
| `corpus seed-vector-ledger` | There is no ledger. An embedding is a row that commits and deletes inside its reading's transaction. |
| `corpus backfill-vectors` | A ready reading cannot lack an embedding: publication writes both in one transaction, and the embedding cascades with the reading. |
| `account audit-bare-vectors` | A bare vector is unrepresentable — `reading_embeddings` has a foreign key to `readings`. |
| `corpus delete-orphans` | Orphan-duplicate pending readings cannot be created. `reading_urls` is unique per tenant and the claim commits with the reading. |
| `corpus backfill-similarity` | A one-time backfill of a manifest field that predates `similarity`. The values travel into rows through the #348 importer. |
| `corpus backfill-source-date` | Same: a one-time backfill, from stored raw HTML, of a field the importer carries over. |
| `corpus normalize-tags` | Same. Write-time normalization in `src/modules/tags.ts` keeps new readings canonical; a future corpus-wide rewrite is a single `UPDATE`, not a command. |
| `account sweep-wipe-prefix` | Wipe progress is a `wipe_progress` row (slice 1c); nothing writes `wipe/{tenantId}/progress.json` any more. **Kept working, unported, until #351**, which deletes it after confirming the prefix is empty — it is the tool that proves that. |

### Unchanged (21)

These reach the reading API over HTTP, read fixtures, or already moved to
PostgreSQL in slices 1a–1c:

`db migrate`, `deploy release`, `deploy web`, `deploy wipe-check`,
`deploy worker`, `eval summarizer`, `extract probe`, `founder bootstrap`,
`import bookmarks`, `import markdown`, `import reddit`, `import youtube`,
`reading-list process`, `reading submit`, `staging smoke`,
`staging token-revocation`, `system lease-clear`, `system policy`,
`system status`.

`deploy worker` gains the migration step in this slice, and `import youtube`
and `staging smoke` get comment corrections only; neither changes behaviour.

## Skills

`.claude/skills/`. Each of these narrates its own storage reads to the agent
running it, so a stale one is a wrong instruction, not just stale prose.

| Skill | Decision |
|---|---|
| `corpus-audit` | Port — drops the `wrangler r2 object get index/list.json` walk for the ported command. |
| `corpus-drop` | Port — the "ready readings own a Vectorize embedding" refusal becomes "a ready reading is live in the library". |
| `corpus-sweep` | Port — same, plus its claim to delete vectors directly. |
| `corpus-recover` | Port — the reason/policy table is unchanged; the inputs come from the ported audit. |
| `check-reading-list` | Port — reads ownership from rows rather than `index/list.json` via wrangler. |
| `process-reading-list` | Port — API-only already; its cross-references to the check skill's R2 read need correcting. |
| `reddit-import` | Unchanged — imports through the API. |
| `youtube-import` | Unchanged — imports through the API. |
| `chrome-reading-list` | Unchanged — never touched the corpus. |
| `beads`, `reading-lite-local` | Unchanged. |

## What this slice does not decide

Destructive retirement of the Cloudflare resources themselves — the Vectorize
index, the D1 database, and the R2 manifest/pointer/list objects — is #351,
after the agreed retention window and Brian's explicit authorization. The
`READINGS_INDEX` binding still exists in `wrangler.toml` and `src/index.ts`
for that reason, unused by any runtime path.
