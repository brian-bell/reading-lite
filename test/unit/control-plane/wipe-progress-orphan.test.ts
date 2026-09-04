// The wipe record cannot be created for a tenant that no longer exists
// (issue 195 S4).
//
// Queues are at-least-once. A redelivered wipe job can read `users` as
// `deleting` just before teardown commits, and then write its progress for an
// account that is already gone. That row would carry a NULL `completed_at_ms`,
// so `listUnfinishedWipes` would return it on every cron tick forever while
// `listDeletingUsers` no longer does — an orphan nothing enumerates and nothing
// cleans up.
//
// Deliberately run with foreign keys OFF, which is how D1 actually behaves: no
// migration in this schema turns them on, so the `REFERENCES users(id)` on
// `wipe_progress` is a statement of meaning, not a runtime guard. The INSERT's
// own `EXISTS` clause is the only thing standing here.

import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { parseTenantId } from "../../../src/control-plane/ids";
import {
  AccountWipeProgressConflictError,
  emptyWipeProgress,
  listUnfinishedWipes,
  WipeProgressWriter,
} from "../../../src/control-plane/wipe-progress";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-09-04T10:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TENANT = parseTenantId(USER)!;

async function seeded() {
  const { sqlite, db } = openMigratedControlPlane();
  // Match D1: references are declared, never enforced.
  sqlite.pragma("foreign_keys = OFF");
  await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER,
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { sqlite, db };
}

describe("WipeProgressWriter insert", () => {
  it("creates a record for a tenant that still exists", async () => {
    const { db } = await seeded();
    await new WipeProgressWriter(db, TENANT, null).write(emptyWipeProgress(NOW_MS));
    expect([...(await listUnfinishedWipes(db)).keys()]).toEqual([USER]);
  });

  it("refuses to create one for a tenant torn down under it", async () => {
    const { sqlite, db } = await seeded();
    const writer = new WipeProgressWriter(db, TENANT, null);
    // Teardown commits between the job's `users` read and its first write.
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(USER);

    await expect(writer.write(emptyWipeProgress(NOW_MS))).rejects.toBeInstanceOf(
      AccountWipeProgressConflictError,
    );

    // The point: no orphan for cron to pick up forever.
    expect(await listUnfinishedWipes(db)).toEqual(new Map());
  });
});
