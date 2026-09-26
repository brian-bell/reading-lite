# PostgreSQL production cutover runbook (#350)

> **Status: executed 2026-09-24.** Production has served from PostgreSQL since
> 11:01Z and reopened writes at 11:04:43Z ([record](#production-cutover-record-2026-09-24)).
> The legacy D1, R2 manifests and Vectorize stayed frozen until #351, which
> deleted them on 2026-09-26 after verifying these restore points
> ([storage resources](operations.md#storage-resources)).
> Rehearsal evidence is in the comments on bead `reading-lite-gh349`; the
> cutover's is on `reading-lite-gh350`.

This is the procedure for moving production's library and control plane from
the legacy stores into PostgreSQL (ADR [0005](decisions/0005-postgresql-storage.md))
with one release. It is a **copy**: export only reads D1, R2 and Vectorize,
and nothing legacy was deleted until #351. The importer's behavior and its
findings are documented in
[operations: library export and import](operations.md#library-export-and-import-reading-lite-gh348);
this page covers the order of operations, the checks, and the rollback boundary.

## Production cutover record (2026-09-24)

| Step | UTC | Result |
|---|---|---|
| Freeze | 10:43:16–10:43:34 | Crons cleared, 8 queues paused. No backlog on any queue since the freeze, no processing leases, 63 spend records all settled |
| Final export | 10:45:13–10:46:02 | 646 readings (632 ready, 14 failed), 632 vectors, 0 re-embeds, no blocking findings |
| Migrate and import into `main` | 10:46:08–10:48:40 | Migrations 0001–0006; 646 readings and 632 embeddings verified with 0 mismatches, control plane matches |
| Post-import `pg_dump` | 10:48:48 | 632 ready / 14 failed, every ready reading embedded at 1536 dimensions |
| Release | 10:51:03 merge, 11:01:07 upload | #518 into the candidate, #488 into `main` as merge commit `9ce4d985`. Wipe gate read `PRODUCTION_DATABASE_URL` from Actions (go/no-go 6), 0 pending migrations, Worker version `8479a72b-9808-4c02-ab08-b3c218e982c1`, SPA and `app/` deployed |
| Crons re-cleared | 11:01:36 | The deploy reinstalled them at 11:01:10; no tick in between |
| Verification | 11:01:49 | Matches a D1 baseline taken during the freeze: health, whoami, list of 646, detail/content/raw, lookup, search, similarity (same neighbours and order, self-match 1). Signed-in browser check of library, reading and account pages |
| Pre-reopen `pg_dump` | 11:04:25 | Unchanged from the post-import dump |
| Writes reopened | 11:04:43 | Crons restored, queues resumed |
| Controlled writes | 11:04:54–11:06:23 | Submit of `rd_Y4E3YT3HE6` ready in 22 s; reprocess succeeded in 49 s |
| Background jobs | 11:15:03–11:15:30 | The `*/15` tick ran without error, and a real MCP save reached ready in 27 s. All DLQs empty, no exceptions in the tail |

Freeze to reopen: 21.5 minutes. The last pre-cutover commit on `main` is
`c62212ac`, the rollback target in [Rollback](#rollback).

Backups, on the operator laptop under `~/rl-snapshots/`:

- `production-2026-09-24-cutover/` — the source snapshot (library.json
  `5622c7d4…`), with `-cutover-export.log`
- `production-2026-09-24-cutover-import-report.json` and `-import.log`
- `production-2026-09-24-cutover-post-import.dump` and
  `production-2026-09-24-cutover-pre-reopen.dump` — the PostgreSQL restore
  points. Neon's free plan keeps 6 hours of history, so keep these: #351
  verified them restorable and lists them as archives.

## What the rehearsal proved

| Step | Staging (rehearsal target) | Production (reconciliation only) |
|---|---|---|
| Export | 144 readings, 27 s | 646 readings (632 ready, 14 failed), 62 s, 0 re-embeds |
| Import into an empty branch | 29 s, 0 mismatches | 148 s, 0 mismatches, 632 embeddings |
| Similarity | pgvector matches Vectorize (same neighbours and order, scores within 1e-4) | same |
| Freeze window, freeze to reopen | 39 min, including investigation | (not executed) |
| Rollback to D1 Worker, then forward | 3 min back, 1.5 min forward | (not executed) |
| Cold start through Hyperdrive | first query after idle 1.0–1.2 s, warm 0.24 s | (not measured) |

Staging then passed `ops staging smoke`, `ops founder bootstrap`, the scripted
smoke list (search, similarity, duplicate submit, failed-owner reprocess,
successful and failed reprocess, purge), the nightly refresh cron, and a
signed-in browser check of library, reading, and account pages. `app/`'s
`test:browser` passes every signed-out case against a deployed host; its
signed-in cases cannot pass there until reading-lite-gh392 removes the fixture
pins. Account deletion on PostgreSQL staging is verified separately, by the
`usr_9c2abd78` wipe after 2026-09-26 (reading-lite-gh346.4); it does not
gate the cutover.

## Database configuration

| Setting | Value |
|---|---|
| Provider, project | Neon `reading-lite` (`little-cake-62522212`), aws-us-east-1, PostgreSQL 18.6, pgvector 0.8.6 |
| Production branch | `main`, direct endpoint `ep-rapid-sound-awt688y7` (`NEON_MAIN_DATABASE_URL` on a laptop, `PRODUCTION_DATABASE_URL` in Actions) |
| Compute | 0.25 CU, the rehearsal size |
| Plan | **Free** (decided 2026-09-24). |
| Suspend | Scale to zero after about 5 idle minutes, the free plan's behavior. The `*/15` cron queries PostgreSQL on every tick, so the compute is awake about a third of the time and a request more than 5 minutes after a tick pays about 1 s. That is accepted for one reader. |
| History retention | 6 hours on the free plan. The post-import `pg_dump` (step 3) is the restore point for the cutover; keep it as an archive. Otherwise restores rely on dumps you take yourself. |
| Hyperdrive | `reading-lite-production` (`4aebdf8836c746f29703a04cf575b34a`, created 2026-09-24), caching disabled, against the **direct** endpoint (never `-pooler`), default origin connection limit (60). Bound in `[env.production]`. |
| Connection strings | Use `sslmode=verify-full`; node-postgres warns that `require` will change meaning. |

## Go/no-go before the freeze

Every item must be true. Stop if any is not.

1. **reading-lite-gh346.3 is merged into the candidate.** Without it, a
   successful reprocess of an imported reading deletes that reading's legacy
   R2 content, and a rollback serves it with content 404 (seen live on
   staging).
2. **The export plan reports no `unresolved_pending`.** The four ready
   readings with an active attempt left over from May or June
   (`rd_6DCN32K7KJ`, `rd_SE726QGY16`, `rd_SEC6BW372D`, `rd_V7W948M6QH`) were
   reprocessed cleanly on 2026-09-24. A new one is a stop: reprocess it, or
   import it as found with `--accept unresolved_pending`.
3. **The production release is prepared but not merged.** A commit on the
   candidate sets the Hyperdrive id and `POSTGRES_CUTOVER_ENABLED.production =
   true`. `ops deploy worker --env production` (plan mode) reports the guard
   as admitted.
4. **`PRODUCTION_DATABASE_URL` is set as an Actions secret** (set
   2026-09-24). The release workflow's wipe gate and its migrations read it.
5. **`main` is empty.** No tables in `public`, pgvector installed. The
   importer refuses anything else. The free plan cannot mark a branch
   protected, and that is accepted.
6. **Actions can reach `main`, proved by the cutover run itself.** No
   workflow can reach the database before the release: the Neon settings
   allow public connections with no IP allowlist, and the release's wipe gate
   and migration step are the first Actions reads of `PRODUCTION_DATABASE_URL`.
   Both fail closed before the upload, so a connection failure costs a retry
   inside the freeze, not a broken deploy (decided 2026-09-24).
7. **The freeze will not straddle 03:07 UTC.** A refresh judgement between the
   final export and the cutover advances the R2 cursor while PostgreSQL never
   receives its job row or connections patch.
8. **Nothing is mid-deletion.** `ops deploy wipe-check` passes: no unfinished
   wipe, and the wipe queues are empty.
9. **Someone can watch for 30 minutes after reopening.**

## Procedure

The commands assume `set -a; . ~/.config/reading-lite/neon.env; set +a` in
the shell and Wrangler logged in to the account. Record the UTC time of each
step.

### 1. Freeze every writer

Clear the production Worker's crons. This is the schedules API, not
`wrangler triggers deploy`, which would also rewrite routes:

```sh
TOK=$(npx wrangler auth token | tail -1); ACCT=332a424522e92bba0b6437992168064a
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '[]' https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/reading-lite/schedules
```

Pause all eight queues:

```sh
for q in reading-lite reading-lite-dlq reading-lite-digest reading-lite-digest-dlq \
         reading-lite-wipe reading-lite-wipe-dlq reading-lite-refresh reading-lite-refresh-dlq; do
  npx wrangler queues pause-delivery $q
done
```

Stop the HTTP writers yourself: the browser, MCP clients, reading-list
scripts, and cloud agents. Nothing enforces this.

Account for what is in flight:

- **Queue backlogs.** `queueBacklogAdaptiveGroups` in the GraphQL analytics
  API, by queue id. Every queue, DLQs included, should show no samples since
  the freeze. A message left in a paused queue is delivered to the new Worker
  after reopening, and one left in a DLQ is lost with D1.
- **Leases.** `npm run ops -- system status --env production --tenant usr_… --details`
  should show no active processing lease. Clear a stale one with
  `ops system lease-clear`.
- **Pending readings.** The export plan below reports `unresolved_pending`.
  It must report none (go/no-go item 2).

### 2. Final export

```sh
npm run ops -- migrate export --source production --tenant usr_1700450b-c2df-4421-8805-c308a63b4dea
npm run ops -- migrate export --source production --tenant usr_1700450b-c2df-4421-8805-c308a63b4dea \
  --out ~/rl-snapshots/production-$(date -u +%F) --execute
```

Compare the plan with [the known discrepancies](#known-discrepancies). A new
blocking code, or a count that moved without a known write, is a stop. The
snapshot directory is the source backup. The legacy D1, R2 and Vectorize data
is also still intact.

### 3. Migrate and import into `main`

```sh
npm run ops -- db migrate --database-url-env NEON_MAIN_DATABASE_URL --execute
npm run ops -- migrate import --snapshot ~/rl-snapshots/production-<date> --target-env NEON_MAIN_DATABASE_URL
npm run ops -- migrate import --snapshot ~/rl-snapshots/production-<date> --target-env NEON_MAIN_DATABASE_URL \
  --execute --json > ~/rl-snapshots/production-<date>-import-report.json
```

Expect about 2.5 minutes. The import verifies itself before committing and
rolls back entirely on any mismatch. Then check independently:

```sql
select status, count(*) from readings group by 1;          -- 632 ready / 14 failed, plus anything new
select count(*), min(vector_dims(embedding)) from reading_embeddings;  -- one per ready reading, 1536
select count(*) from readings r where status = 'ready'
  and not exists (select 1 from reading_embeddings e where e.reading_id = r.id);  -- 0
```

Take the target backup before any Worker can write:

```sh
pg_dump "$NEON_MAIN_DATABASE_URL" -Fc --no-owner --no-privileges \
  -f ~/rl-snapshots/production-<date>-post-import.dump
```

### 4. Deploy one release

Merge the prepared release (go/no-go item 3). The workflow runs the wipe
gate, `ops deploy worker --env production` with 0 pending migrations, the SPA,
and `app/`, under the release lock.

**The Worker deploy reinstalls both crons.** Clear them again with the step 1
`curl` as soon as the Worker job finishes. They stay off until verification
passes.

### 5. Verify before reopening

- `/health` 200; `/api/whoami` with the founder's legacy token 200, tenant
  `usr_1700450b…`.
- The list pages through to the imported total.
- One imported reading's detail, `/content` and `/content/raw` return 200.
- `POST /api/readings/similar` with a stored embedding ranks its own reading
  first at score 1.
- `GET /api/readings/lookup?url=` for an imported URL returns its id.
- In a browser: sign in, then check the library, one reading page with
  connections, and the account page (sessions and tokens list).

Check a vector through the REST `query` or `get_by_ids` API, never by one
`wrangler vectorize … --vector-id` lookup. That lookup misses tenant-prefixed
ids that are present. For a stale attempt, `GET /diagnostics` shows the
attempt as failed with the current time. That is a read-time overlay, not a
write.

### 6. Reopen

Restore the crons and resume the queues:

```sh
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '[{"cron":"*/15 * * * *"},{"cron":"7 3 * * *"}]' \
  https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/reading-lite/schedules
for q in reading-lite reading-lite-dlq reading-lite-digest reading-lite-digest-dlq \
         reading-lite-wipe reading-lite-wipe-dlq reading-lite-refresh reading-lite-refresh-dlq; do
  npx wrangler queues resume-delivery $q
done
```

Then save one real reading and watch it reach `ready`. **From this moment,
PostgreSQL holds data the legacy stores do not.**

## Rollback

### The boundary

- **Before reopening:** PostgreSQL has no writes the legacy stores lack.
  Rolling back loses nothing.
- **After reopening:** rolling back **loses every write made on PostgreSQL**.
  The staging rehearsal confirmed each of these:
  - readings saved after cutover
  - reprocess results, which revert to the D1 manifest
  - refresh judgements
  - sessions created after cutover, so readers are signed out
  - token changes

  Rollback after new writes therefore requires preserving the new data first:
  `pg_dump` `main`, then decide what to carry back by hand. No reverse
  importer exists. After reopening, prefer fixing forward.
- Without reading-lite-gh346.3, rollback also breaks any imported reading
  reprocessed after cutover (content 404). Go/no-go item 1 exists for this.

### Procedure

1. Freeze exactly as in step 1.
2. From a checkout of the last pre-cutover commit, with its own `npm ci`:

   ```sh
   npm run ops -- deploy worker --env production --execute --acknowledge-tenant-migration
   ```

   The acknowledgement is required. The tenant-activation guard reads the
   active candidate, finds no `READINGS_INDEX` binding, and refuses the
   rollback as a fresh tenant-mode activation. Before acknowledging, record
   the checks the guard asks for:
   - an `ops migrate export` plan showing the tenant's R2 manifests and
     Vectorize vectors intact
   - the preflight's deletion-eligibility count

   Because of the acknowledgement, a `git revert` on `main` cannot roll back
   by itself: the workflow does not pass `--acknowledge-tenant-migration`.
3. Deploy the pre-cutover `app/` and SPA from the same commit.
4. The D1 Worker deploy reinstalls its crons. Leave them on only if you are
   reopening on D1.
5. Resume the queues.
6. Verify on D1. Readings the D1 list index never held stay invisible, as
   they were before cutover.

Rolling forward again needs no acknowledgement. It is the candidate deploy
plus the frontend, with the queues resumed. The staging round trip preserved
PostgreSQL exactly (146 of 146 readings identical).

## Known discrepancies

Production export plan, 2026-09-24 after the four stuck readings were
reprocessed (the 02:52Z reconciliation snapshot differed only in those four):

| Finding | Count | Disposition |
|---|---|---|
| `unresolved_pending` (blocking) | 0 | Go/no-go item 2 |
| `content_hash_mismatch` / `content_size_mismatch` | 3 readings (`rd_45XAY3N8MM`, `rd_86H2EZ7WJ2`, `rd_D54QAN355D`) | A failed reprocess restored the manifest, not the overwritten content ([reprocessing](architecture.md#reprocessing-and-recovery)). Imported as found. |
| `orphan_objects` | 17 prefixes (2026-05-02, 05-12, 06-18, 08-21) | Objects with no manifest, not imported. Cleanup in #351. |
| `ledger_row_missing` | 552 of 632 ready | Informational. The D1 vector ledger is not imported, and every ready reading has its vector. |
| `processing_checkpoint_not_imported` | 111 | Not imported by design |
| `refresh_state_not_imported` | 1 | The next operator refresh sweeps the whole library |
| Snapshot drift in `corpus refresh-neighbours` | most readings | Stale snapshots from library growth, not the migration. pgvector reproduces Vectorize. |

No dangling relationships, duplicate URL owners, invalid vectors, or missing
vectors in production.

## Operational notes from the rehearsal

- rfc-editor.org and iana.org return empty bodies to Workers egress (since
  2026-09-10). The staging smoke now submits a martinfowler.com page.
- Cloudflare returns 403 to Python's default `Python-urllib` user agent on the
  readinglite zones. Scripts must set their own.
- `ops staging smoke` defaults to the staging workers.dev origin.
- After a rollback deploy, clear the crons again: `main`'s deploy reinstalls
  them.
