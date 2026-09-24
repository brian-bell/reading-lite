# Full production corpus refresh

Run the neighbour, connection, and tension refreshes in one maintenance window.
This procedure produced the [September 4, 2026 results](2026-09-04-results.md)
for [#174](https://github.com/brian-bell/reading-lite/issues/174).
The [operations guide](../operations.md#corpus-tools) documents the commands,
credential selection, retry policy, and incremental scope in detail.

A full scan measures every ready reading; the paid passes judge only eligible
readings and pairs. It does not re-extract content, replace embeddings, or
re-summarize readings. Connection refresh writes `connections`, `novelty_verdict`,
`connections_computed_at` and `connections_neighbourhood_ids` — the
relationship rows and the revision's summary flags, in one transaction, so the
verdict lands with the relationships it was judged beside. Tensions write
directional entries and remembered pair judgements to both readings, also in
one transaction.

## Prepare and estimate

Start in the repository root with installed dependencies and a reviewed checkout.
Record the revision. Set `TENANT` from an authenticated production
`GET /api/whoami`, confirming `tenant_data_plane: true`; never use `global` for
the live founder corpus. Obtain production credentials from the operator's
existing secure file, outside the repository. Staging-scoped `.corpus.vars` R2
keys take precedence over an otherwise usable API token and can cause a 403.

Set these three variables before running the zsh examples:

- `TENANT`: the verified production `usr_…` tenant ID.
- `PRODUCTION_CREDENTIALS_FILE`: absolute path to the trusted production env file.
- `RUN_DIR`: absolute path to a **new directory outside the repository** for
  private logs and snapshots. Use a different directory for each execution.

```zsh
: "${TENANT:?Set TENANT from production whoami}"
: "${PRODUCTION_CREDENTIALS_FILE:?Set the trusted production env-file path}"
: "${RUN_DIR:?Set a new private directory outside the repository}"
export TENANT PRODUCTION_CREDENTIALS_FILE RUN_DIR
umask 077
mkdir -m 700 "$RUN_DIR"
git status --short --branch
git rev-parse HEAD > "$RUN_DIR/code-revision.txt"
set -o pipefail
prd() (
  set -a
  source "$PRODUCTION_CREDENTIALS_FILE"
  set +a
  "$@"
)
wr() { node node_modules/wrangler/wrangler-dist/cli.js "$@"; }
```

`prd` supplies the database connection string, R2, and provider credentials to
corpus commands. Each refresh pass resolves its database from `--bucket`
(`scripts/pg-lib/operator-db.ts`), so a credentials file that exports
`PRODUCTION_DATABASE_URL` or `NEON_MAIN_DATABASE_URL` is what points them at
production.
`wr` uses the operator's existing Wrangler authentication for queue control;
a corpus token may lack Queue permissions. The direct Wrangler entrypoint also
uses the same wrangler-dist entrypoint as `scripts/lib/wrangler-cli.ts`.

Generate a read-only full report and plan both paid passes:

```zsh
prd npm run ops -- corpus refresh-neighbours \
  --tenant "$TENANT" --bucket reading-lite \
  --full --out "$RUN_DIR/refresh-report-preparation.json" \
  2>&1 | tee "$RUN_DIR/neighbours-plan.log"

prd npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --bucket reading-lite \
  --report "$RUN_DIR/refresh-report-preparation.json" \
  2>&1 | tee "$RUN_DIR/connections-preparation.log"

prd npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --bucket reading-lite \
  --report "$RUN_DIR/refresh-report-preparation.json" \
  2>&1 | tee "$RUN_DIR/tensions-preparation.log"
```

Run each command separately and inspect its exit code before continuing. These
plans make no provider calls or production writes. Confirm full scope, target,
provider/model/effort, eligible counts, and cost estimates. No `--limit` is used.
The CLI output assumptions (256 tokens for connections, 128 for tensions) are
not spending caps and may undercount reasoning output. `--max-backoff` bounds
rate-limit waiting, not dollars or total run time.

Obtain approval for the maintenance window, paid full eligible runs, and
production writes before proceeding. Re-plan if the checkout, configuration,
or corpus changes. Tension eligibility must be checked again after connection
execution because citations are an admission arm.

## Establish the maintenance hold

Hold submit, import, reprocess, deletion, recovery, ingest, batch writers, other
refreshes, and any account wipe affecting this tenant. Check background jobs and
operator schedules. The account must be active with no wipe in progress.
Queue pause alone does not stop HTTP intake or administrative writers;
`--sole-writer` is an operator assertion, not a lock.

Record each queue's `delivery_paused` flag **before** pausing. `wr queues info`
identifies the queue but does not expose this field; read it from the dashboard
or `GET /accounts/{account_id}/queues/{queue_id}` (`settings.delivery_paused`).
Write both booleans to `$RUN_DIR/queue-delivery-before.json` using this shape:

```json
{
  "reading-lite": { "delivery_paused": false },
  "reading-lite-dlq": { "delivery_paused": false }
}
```

`false` means delivery was enabled; `true` means the queue was already paused.
Do not pause until that file validates. Then pause both queues. Pausing an
already-paused queue leaves the pause intact:

```zsh
wr queues info reading-lite | tee "$RUN_DIR/queue-before.log"
wr queues info reading-lite-dlq | tee "$RUN_DIR/dlq-before.log"
node --input-type=module <<'JS' || exit 1
import { readFileSync } from 'node:fs';
const path = `${process.env.RUN_DIR}/queue-delivery-before.json`;
const names = ['reading-lite', 'reading-lite-dlq'];
let state;
try {
  state = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  throw new Error(
    `Write ${path} before pausing. wr queues info does not expose delivery_paused. ` +
      'Record each queue from the dashboard or GET /accounts/{account_id}/queues/{queue_id} ' +
      '(settings.delivery_paused). Required shape: ' +
      '{"reading-lite":{"delivery_paused":false},"reading-lite-dlq":{"delivery_paused":false}}.',
  );
}
for (const name of names) {
  if (typeof state[name]?.delivery_paused !== 'boolean') {
    throw new Error(`${path} must set ${name}.delivery_paused to true or false`);
  }
}
for (const name of names) {
  console.log(`${name} delivery_paused=${state[name].delivery_paused}`);
}
JS
wr queues pause-delivery reading-lite | tee "$RUN_DIR/queue-pause.log"
wr queues pause-delivery reading-lite-dlq | tee "$RUN_DIR/dlq-pause.log"
```

Verify delivery is paused and wait for already-running consumers to finish.
Pausing does not kill active invocations. Check pending readings and recent
attempt activity; zero pending rows alone is not proof of drain. Do not purge
queued messages. If a hold cannot be established, stop and run the restoration
block below: resume only queues recorded as enabled in
`$RUN_DIR/queue-delivery-before.json`. Do not resume a queue that was already
paused, and do not resume if that capture is missing or incomplete.

Capture the live corpus listing and every ready reading before writes,
including verdicts, computation timestamps, neighbourhood IDs, and tension
history. Retain failed rows as well to verify they remain unchanged.
The following function reads through the same store the passes read, saves
private snapshots, and refuses pending readings or a listing that changes
during capture. It does not replace the drain checks above.

```zsh
capture() {
  prd node --import tsx --input-type=module - "$1" <<'JS'
import { requireOperatorTenant } from './scripts/ops-lib/tenant-flag.ts';
import { resolveOperatorDatabaseUrl, withOperatorSql } from './scripts/pg-lib/operator-db.ts';
import { listItems, operatorReadings, requireTenantRows } from './scripts/pg-lib/operator-corpus.ts';
import { writeFileSync } from 'node:fs';
const label = process.argv[2];
if (!/^[a-z0-9-]+$/.test(label ?? '')) throw new Error('capture label required');
if (!/^usr_[a-zA-Z0-9-]+$/.test(process.env.TENANT ?? '')) throw new Error('invalid tenant');
const tenant = requireTenantRows(requireOperatorTenant(process.env.TENANT));
const { url } = resolveOperatorDatabaseUrl({ bucket: 'reading-lite' });
await withOperatorSql(url, async (sql) => {
  const store = operatorReadings(sql, tenant);
  const items = await listItems(store);
  if (items.some(x => x.status === 'pending')) throw new Error('pending readings');
  const rows = items.filter(x => x.status === 'ready');
  const manifests = [];
  for (const row of rows) {
    const found = await store.loadReadingById(row.id);
    if (!found) throw new Error(`missing ${row.id}`);
    if (found.manifest.status !== 'ready') throw new Error(`changed ${row.id}`);
    manifests.push(found.manifest);
  }
  const after = await listItems(store);
  if (JSON.stringify(after) !== JSON.stringify(items)) {
    throw new Error('listing changed during capture');
  }
  manifests.sort((a, b) => a.id.localeCompare(b.id));
  const dir = process.env.RUN_DIR;
  writeFileSync(`${dir}/list-${label}.json`, JSON.stringify({ items }, null, 2),
    { mode: 0o600, flag: 'wx' });
  writeFileSync(`${dir}/manifests-${label}.json`, JSON.stringify(manifests, null, 2),
    { mode: 0o600, flag: 'wx' });
  console.log(`Captured ${items.length} rows and ${manifests.length} ready readings.`);
});
JS
}
capture before
```

Keep the hold through all subsequent writes and checks. Check each command's
exit status; do not run this document as an unattended batch.

## Execute the full passes

Refresh neighbours inside the verified sole-writer window, generating a new
report rather than reusing the preparation report:

```zsh
prd npm run ops -- corpus refresh-neighbours \
  --tenant "$TENANT" --bucket reading-lite \
  --full --execute --sole-writer \
  --out "$RUN_DIR/refresh-report.json" \
  2>&1 | tee "$RUN_DIR/neighbours-execute.log"
```

Require exit 0 and full coverage. Exit 3 means some readings are unmeasurable;
review them before continuing. Stop on exit 1 or 2. Keep this exact report for
resume and downstream acceptance; a complete execute pass advances the marker.

Re-plan connections, confirm the estimate and provider, then execute:

```zsh
prd npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --bucket reading-lite --report "$RUN_DIR/refresh-report.json" \
  2>&1 | tee "$RUN_DIR/connections-plan.log"

prd npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --bucket reading-lite --report "$RUN_DIR/refresh-report.json" \
  --concurrency 4 --max-backoff 10m --execute --sole-writer \
  2>&1 | tee "$RUN_DIR/connections-execute.log"

capture after-connections
```

Re-plan tensions **after** successful connection execution. Compare any change
in candidate count and estimate with the approved scope and budget; resolve a
material increase before spending. Connection refresh preserves ingest
`updated_at`, so the same full report remains valid within this hold.

```zsh
prd npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --bucket reading-lite --report "$RUN_DIR/refresh-report.json" \
  2>&1 | tee "$RUN_DIR/tensions-plan.log"

prd npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --bucket reading-lite --report "$RUN_DIR/refresh-report.json" \
  --concurrency 4 --max-backoff 10m --execute --sole-writer \
  2>&1 | tee "$RUN_DIR/tensions-execute.log"

capture after
```

## Recover, verify, and restore delivery

On provider failure, CAS loss, list-flush failure, or backoff exhaustion, retain
the logs and report. Re-plan against the **same report** under the same hold:
completed connection judgements are skipped and stale list rows can be healed;
one-sided tension writes can be repaired without another paid call. Review the
remaining plan before executing it. A fresh report can select paid work again;
do not silently replace the resume report. If ingest or reprocessing has made
it stale, stop and regenerate/re-plan explicitly.

After successful execution, run both commands in plan mode with the same report:

```zsh
prd npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --bucket reading-lite --report "$RUN_DIR/refresh-report.json" \
  2>&1 | tee "$RUN_DIR/connections-acceptance.log"
prd npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --bucket reading-lite --report "$RUN_DIR/refresh-report.json" \
  2>&1 | tee "$RUN_DIR/tensions-acceptance.log"
prd npm run ops -- corpus refresh-neighbours \
  --tenant "$TENANT" --bucket reading-lite \
  --full --out "$RUN_DIR/refresh-report-after.json" \
  2>&1 | tee "$RUN_DIR/neighbours-after.log"
```

Acceptance requires zero remaining paid actions or free repairs in the same-report
plans, successful exits, and an explanation for any remaining flags in the fresh
report. The fresh report need not have zero flags; never feed it automatically
into another paid run.

Compare the captured data by reading ID:

- Corpus/list membership and unrelated fields remain unchanged, including
  summaries, source metadata, status, and ingest/attempt timestamps.
- Refreshed connections and neighbourhood IDs stay within the original report's
  allowed neighbours. The verdict is a column of the judged reading, so it
  cannot disagree with the relationships written beside it.
- Both readings remember each tension judgement at the same timestamp.
  Positive entries have inverse kinds and matching reasons/computation times;
  `none` has no tension entry on either side.
- Record verdict transitions, separating first judgements from previously judged
  readings. Report computation-timestamp coverage rather than assuming it is 100%.
- Record candidate admissions and outcomes by pre-filter arm. Use exact overlap
  evidence from the post-connections capture; printed Jaccard values are rounded.
- Save stage times, counts, and provider usage. OpenAI reasoning is a subset of
  output tokens. Distinguish usage-based estimates from reconciled provider bills.

After all refresh processes have stopped, restore delivery from the captured
state: resume **only** queues recorded as enabled (`delivery_paused: false`)
before this window. Apply the same rule on an aborted run once writers have
stopped. Retain any pre-existing pause. Do not resume an unrelated queue. If
`$RUN_DIR/queue-delivery-before.json` is missing or a `delivery_paused` value
is not a boolean, stop; do not run `resume-delivery`.

```zsh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const path = `${process.env.RUN_DIR}/queue-delivery-before.json`;
const names = ['reading-lite', 'reading-lite-dlq'];
let state;
try {
  state = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  throw new Error(
    `Missing ${path}; do not run resume-delivery. Restore only from captured ` +
      'pre-hold delivery_paused booleans.',
  );
}
for (const name of names) {
  if (typeof state[name]?.delivery_paused !== 'boolean') {
    throw new Error(`${path} must set ${name}.delivery_paused to true or false`);
  }
}
JS
resume_if_enabled() {
  local name="$1" log="$2" paused
  paused=$(node --input-type=module - "$name" <<'JS'
import { readFileSync } from 'node:fs';
const name = process.argv[2];
const path = `${process.env.RUN_DIR}/queue-delivery-before.json`;
const paused = JSON.parse(readFileSync(path, 'utf8'))[name]?.delivery_paused;
if (typeof paused !== 'boolean') {
  throw new Error(`${path} must set ${name}.delivery_paused to true or false`);
}
process.stdout.write(paused ? 'true' : 'false');
JS
  ) || return 1
  if [[ "$paused" == true ]]; then
    printf '%s\n' "Retaining pre-existing pause on $name" | tee "$log"
    return 0
  fi
  wr queues resume-delivery "$name" | tee "$log"
}
resume_if_enabled reading-lite-dlq "$RUN_DIR/dlq-resume.log" || exit 1
resume_if_enabled reading-lite "$RUN_DIR/queue-resume.log" || exit 1
```

For each queue this window resumed, verify `delivery_paused: false`. For each
queue recorded as already paused, verify it is still paused. Check production
health and authenticated whoami, then release the HTTP/operator maintenance
hold.
Keep raw reports and captures outside git; publish aggregate results and the
calibration rationale. For longitudinal churn, compare against a later full run
(at least a week later or after meaningful ingestion), not just an immediate rerun.
