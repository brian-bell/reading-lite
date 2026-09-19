// The vector ledger's row-clearing helpers and the re-mark-live rule, tested
// against the migrated schema rather than through a whole account wipe.
//
// All three guard the same asymmetry: clearing a row for a vector that is still
// live strands that vector forever, because the ledger is the only id source
// once R2 is empty. Failing to clear one merely costs another pass.

import { describe, expect, it } from "vitest";
import { parseTenantId } from "../../../src/control-plane/ids";
import {
  VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS,
  clearLedgerRows,
  clearTenantLedger,
  d1VectorLedger,
} from "../../../src/control-plane/vector-ledger";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TENANT = parseTenantId(USER)!;
const ID_A = "rd_0123456780";
const ID_B = "rd_0123456781";

/** A `delete_submitted` stamp old enough that the +120s first-confirmation delay has elapsed. */
const CONFIRMABLE_AT = NOW_MS - VECTOR_LEDGER_FIRST_CONFIRM_DELAY_MS - 1;

async function seeded() {
  // The D1 ledger the operator scripts still read (until 1d); the user row is
  // written directly because the founder bootstrap now speaks PostgreSQL.
  const { sqlite, db } = openMigratedControlPlane();
  sqlite
    .prepare(
      `INSERT INTO users (id, email_canonical, email_display, status, created_at_ms, updated_at_ms)
       VALUES (?, 'founder@example.com', 'founder@example.com', 'active', ?, ?)`,
    )
    .run(USER, NOW_MS, NOW_MS);
  const ledger = d1VectorLedger(db, TENANT);
  const rows = () =>
    sqlite
      .prepare(
        `SELECT reading_id, state, deleted_at_ms, absent_streak FROM vector_ledger
          WHERE tenant_id = ? ORDER BY reading_id`,
      )
      .all(USER) as Array<{
      reading_id: string;
      state: string;
      deleted_at_ms: number | null;
      absent_streak: number;
    }>;
  return { db, ledger, rows };
}

describe("clearTenantLedger — the fast path", () => {
  it("clears confirmed rows but never a vector nobody has deleted", async () => {
    // The probe happens between the row read and the DELETE, so a publisher
    // can insert a `live` row inside that window. An empty namespace says
    // nothing about a vector that was upserted after it answered, and
    // clearing that row would delete the only record of it.
    const { db, ledger, rows } = await seeded();
    await ledger.markDeleteSubmitted([ID_A], CONFIRMABLE_AT);
    await ledger.markLive([ID_B], NOW_MS);

    // The probe instant authorizes the clear; a delete submitted after it is
    // deliberately left behind.
    expect(await clearTenantLedger(db, TENANT, NOW_MS)).toBe(1);
    expect(rows().map((r) => [r.reading_id, r.state])).toEqual([[ID_B, "live"]]);
  });
});

describe("clearLedgerRows — the per-id path", () => {
  it("does not clear a row that was re-marked live after the absence was observed", async () => {
    // A reading re-published between the getByIds that observed its absence
    // and the DELETE has a brand-new vector. Clearing its row because the
    // PREVIOUS vector was confirmed gone is the exact stranding the ledger
    // exists to prevent, reintroduced by the code meant to close it.
    const { db, ledger, rows } = await seeded();
    await ledger.markDeleteSubmitted([ID_A], CONFIRMABLE_AT);
    await ledger.markLive([ID_A], NOW_MS); // republished: state live, stamp cleared

    await clearLedgerRows(db, TENANT, [{ readingId: ID_A, deletedAtMs: CONFIRMABLE_AT }]);
    expect(rows().map((r) => [r.reading_id, r.state])).toEqual([[ID_A, "live"]]);
  });
});

describe("markLive after a submitted delete", () => {
  it("clears the delete bookkeeping of the previous vector", async () => {
    // A reading republished after a delete was submitted has a NEW vector.
    // Carrying the old deleted_at_ms or streak forward would let a
    // confirmation about the previous vector clear a row describing this one.
    const { ledger, rows } = await seeded();
    await ledger.markDeleteSubmitted([ID_A], CONFIRMABLE_AT);
    await ledger.markLive([ID_A], NOW_MS);

    expect(rows()).toEqual([
      { reading_id: ID_A, state: "live", deleted_at_ms: null, absent_streak: 0 },
    ]);
  });
});
