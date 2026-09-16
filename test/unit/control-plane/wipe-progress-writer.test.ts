// The wipe record's lease and write-once rules, tested as the D1 helper they
// are rather than through a whole account wipe.
//
// F8, restated for D1: at-least-once delivery plus cron overlap means two
// deliveries can be live on one tenant. The lease is a version, so the loser's
// conditional UPDATE changes zero rows — it stands down and says so instead of
// last-write-wins clobbering the winner's cursor. (The orphan guard on the
// first insert is covered in wipe-progress-orphan.test.ts.)

import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { parseTenantId } from "../../../src/control-plane/ids";
import {
  AccountWipeProgressConflictError,
  emptyWipeProgress,
  readWipeProgress,
  WipeProgressWriter,
  type WipeProgress,
} from "../../../src/control-plane/wipe-progress";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TENANT = parseTenantId(USER)!;

async function seeded() {
  const { db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER,
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { db };
}

/** Seed a record the way a previous delivery would have left it. */
async function seedProgress(db: Awaited<ReturnType<typeof seeded>>["db"], partial: Partial<WipeProgress>) {
  await new WipeProgressWriter(db, TENANT, null).write({
    ...emptyWipeProgress(NOW_MS),
    seedCompletedAtMs: NOW_MS,
    ...partial,
  });
  const stored = await readWipeProgress(db, TENANT);
  expect(stored).not.toBeNull();
  return stored!;
}

describe("WipeProgressWriter lease", () => {
  it("lets one of two concurrent writers win the lease and tells the other", async () => {
    const { db } = await seeded();
    const stored = await seedProgress(db, { phase: "vectors" });

    // Both deliveries read the same row, so both hold the same lease version.
    const winner = new WipeProgressWriter(db, TENANT, stored);
    const loser = new WipeProgressWriter(db, TENANT, stored);

    await winner.write({ ...stored, phase: "objects", objectsDeleted: 7 });
    await expect(
      loser.write({ ...stored, phase: "vectors", objectsDeleted: 0 }),
    ).rejects.toBeInstanceOf(AccountWipeProgressConflictError);

    // The winner's state stands, untouched by the loser's attempt.
    const after = await readWipeProgress(db, TENANT);
    expect(after!.phase).toBe("objects");
    expect(after!.objectsDeleted).toBe(7);
    expect(after!.leaseSeq).toBe(stored.leaseSeq + 1);

    // And the winner can keep writing: losing did not disturb its chain.
    await winner.write({ ...stored, phase: "objects", objectsDeleted: 9 });
    expect((await readWipeProgress(db, TENANT))!.objectsDeleted).toBe(9);
  });

  // The first write for a tenant is an INSERT, not an UPDATE, so it has its own
  // way to lose: `INSERT … WHERE NOT EXISTS` only yields `changes = 0` when the
  // two writers are serialized. If both evaluate NOT EXISTS before either
  // commits, the loser hits the primary key. That must surface as the same
  // conflict, or it escapes the lease path and burns queue retry budget.
  it("turns a losing first insert into a conflict rather than a raw constraint error", async () => {
    const { db } = await seeded();
    expect(await readWipeProgress(db, TENANT)).toBeNull();
    // Both deliveries believe the row is absent, which is what makes them both
    // take the insert path.
    const winner = new WipeProgressWriter(db, TENANT, null);
    const loser = new WipeProgressWriter(db, TENANT, null);

    await winner.write(emptyWipeProgress(NOW_MS));
    await expect(loser.write(emptyWipeProgress(NOW_MS))).rejects.toBeInstanceOf(
      AccountWipeProgressConflictError,
    );
    expect((await readWipeProgress(db, TENANT))!.leaseSeq).toBe(1);
  });
});

describe("WipeProgressWriter.complete", () => {
  // Write-once is enforced in SQL, not only by the caller, so a second
  // completion cannot move the history even if a caller passes a fresh pair.
  it("pins the first-completion pair against a later completion", async () => {
    const { db } = await seeded();
    const stored = await seedProgress(db, { phase: "objects" });
    const writer = new WipeProgressWriter(db, TENANT, stored);

    await writer.complete(stored, NOW_MS, false);
    const afterFirst = await readWipeProgress(db, TENANT);
    expect(afterFirst!.firstCompletedAtMs).toBe(NOW_MS);
    expect(afterFirst!.firstResidue).toBe(false);

    // A later pass completes again, this time leaving residue.
    const later = NOW_MS + 60_000;
    await writer.complete(
      { ...afterFirst!, firstCompletedAtMs: later, firstResidue: true },
      later,
      true,
    );
    const afterSecond = await readWipeProgress(db, TENANT);
    // Current pair moves; the history does not.
    expect(afterSecond!.completedAtMs).toBe(later);
    expect(afterSecond!.residue).toBe(true);
    expect(afterSecond!.firstCompletedAtMs).toBe(NOW_MS);
    expect(afterSecond!.firstResidue).toBe(false);
  });
});
