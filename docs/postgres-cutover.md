# PostgreSQL production cutover runbook (#350)

> **Status: rehearsed, not executed.** Staging has run on PostgreSQL since
> 2026-09-24 (reading-lite-gh349). Production is still on D1, R2 manifests and
> Vectorize. The dated evidence for every number below is in the comments on
> bead `reading-lite-gh349`.

This is the procedure for moving production's library and control plane from
the legacy stores into PostgreSQL (ADR [0005](decisions/0005-postgresql-storage.md))
with one release. It is a **copy**: export only reads D1, R2 and Vectorize,
and nothing legacy is deleted until #351. The importer's behavior and its
findings are documented in
[operations: library export and import](operations.md#library-export-and-import-reading-lite-gh348);
this page covers the order of operations, the checks, and the rollback boundary.

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
pins.

## Database configuration

| Setting | Value |
|---|---|
| Provider, project | Neon `reading-lite` (`little-cake-62522212`), aws-us-east-1, PostgreSQL 18.6, pgvector 0.8.6 |
| Production branch | `main`, direct endpoint `ep-rapid-sound-awt688y7` (`NEON_MAIN_DATABASE_URL` on a laptop, `PRODUCTION_DATABASE_URL` in Actions) |
| Compute | 0.25 CU, the rehearsal size |
| Plan | **Free** (decided 2026-09-24). |
| Suspend | Scale to zero after about 5 idle minutes, the free plan's behavior. The `*/15` cron queries PostgreSQL on every tick, so the compute is awake about a third of the time and a request more than 5 minutes after a tick pays about 1 s. That is accepted for one reader. |
| History retention | 6 hours on the free plan. The post-import `pg_dump` (step 3) is the restore point for the cutover; keep it until #351. After that window, restores rely on dumps you take yourself. |
| Hyperdrive | `reading-lite-production` (`4aebdf8836c746f29703a04cf575b34a`, created 2026-09-24), caching disabled, against the **direct** endpoint (never `-pooler`), default origin connection limit (60). Bound in `[env.production]`. |
| Connection strings | Use `sslmode=verify-full`; node-postgres warns that `require` will change meaning. |

## Go/no-go before the freeze

Every item must be true. Stop if any is not.

1. **reading-lite-gh346.3 is merged into the candidate.** Without it, a
   successful reprocess of an imported reading deletes that reading's legacy
   R2 content, and a rollback serves it with content 404 (seen live on
   staging).
2. **The four stuck production readings have a decision.** `rd_6DCN32K7KJ`,
   `rd_SE726QGY16`, `rd_SEC6BW372D` and `rd_V7W948M6QH` are ready with an
   active attempt from May or June that never finished. Either import them
   with `--accept unresolved_pending` (they look exactly as they do today) or
   clear their active attempts before the freeze.
3. **The production release is prepared but not merged.** A commit on the
   candidate sets the Hyperdrive id and `POSTGRES_CUTOVER_ENABLED.production =
   true`. `ops deploy worker --env production` (plan mode) reports the guard
   as admitted.
4. **`PRODUCTION_DATABASE_URL` is set as an Actions secret** (set
   2026-09-24). The release workflow's wipe gate and its migrations read it.
5. **`main` is empty and protected.** No tables in `public`, pgvector
   installed; the importer refuses anything else. Mark the branch protected
   in the Neon console.
6. **Actions has reached `main`.** A workflow run has read the database
   through `PRODUCTION_DATABASE_URL`, not only the Neon connection settings
   (no IP allowlist, public connections allowed).
7. **Account deletion is proved on PostgreSQL staging.** reading-lite-gh346.4
   records the `usr_9c2abd78` wipe and teardown completing with no residue.
8. **The freeze will not straddle 03:07 UTC.** A refresh judgement between the
   final export and the cutover advances the R2 cursor while PostgreSQL never
   receives its job row or connections patch.
9. **Nothing is mid-deletion.** `ops deploy wipe-check` passes: no unfinished
   wipe, and the wipe queues are empty.
10. **Someone can watch for 30 minutes after reopening.**

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
  Nothing new may appear beyond the decision in go/no-go item 2.

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
  [--accept unresolved_pending] --execute --json > ~/rl-snapshots/production-<date>-import-report.json
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

Production reconciliation, 2026-09-24 (snapshot taken 02:52Z, before that
night's refresh):

| Finding | Count | Disposition |
|---|---|---|
| `unresolved_pending` (blocking) | 4 | Go/no-go item 2 |
| `content_hash_mismatch` / `content_size_mismatch` | 4 readings (`rd_45XAY3N8MM`, `rd_86H2EZ7WJ2`, `rd_D54QAN355D`, `rd_V7W948M6QH`) | A failed reprocess restored the manifest, not the overwritten content ([reprocessing](architecture.md#reprocessing-and-recovery)). Imported as found. |
| `orphan_objects` | 17 prefixes (2026-05-02, 05-12, 06-18, 08-21) | Objects with no manifest, not imported. Cleanup in #351. |
| `ledger_row_missing` | 556 of 632 ready | Informational. The D1 vector ledger is not imported, and every ready reading has its vector. |
| `processing_checkpoint_not_imported` | 107 | Not imported by design |
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
