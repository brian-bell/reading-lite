-- The operator refresh pass's run marker (reading-lite-gh347.4.1).
--
-- `ops corpus refresh-neighbours` scopes each pass against a marker recording
-- what the previous pass saw: when it ran, when the last full sweep ran, every
-- reading id present then (a purge can only be detected by name), and the ids
-- it could not measure. It lived at `index/refresh-state.json` in R2, beside
-- the `index/list.json` it was defined against.
--
-- That list is gone — the library is the `readings` table now — and with it the
-- last thing the pass read from R2. Keeping one small JSON document there would
-- have made the command hold an R2 bucket AND a database at once for that
-- document alone, and that pairing is actively unsafe here: `--local` would
-- mean the local miniflare bucket while the connection string still pointed at
-- production, the exact hazard scripts/pg-lib/operator-db.ts warns about. The
-- marker describes rows, so it belongs with them.
--
-- Operator state, not corpus data: it is per tenant, written only by the
-- refresh pass, and losing it costs one sweep. It is NOT the hosted nightly
-- refresh's scan cursor, which is a different document with a different owner
-- and still lives in R2 (`index/refresh-cursor.json`).
--
-- The whole marker is one jsonb value rather than a column per field because
-- scripts/corpus-lib/refresh-scope.ts owns its shape and versions it: the
-- parser rejects a marker whose version it does not know and the pass sweeps,
-- which is how a format change is meant to land. Splitting the fields into
-- columns would put that ownership in two places.
--
-- No foreign key to `users`: the marker is written by an operator command that
-- addresses a tenant by id, and a row left behind by a torn-down tenant is
-- removed by account teardown (src/control-plane/account-teardown.ts) rather
-- than by a cascade, alongside the other control-plane rows keyed the same way.
CREATE TABLE corpus_refresh_state (
  tenant_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
