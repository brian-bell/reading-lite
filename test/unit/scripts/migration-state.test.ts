import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadMigrationState,
  newMigrationState,
  saveMigrationState,
} from "../../../scripts/corpus-lib/migration-state";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";

describe("migration state ledger", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "migration-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips through disk, leaving no tmp files behind", async () => {
    const path = join(dir, "founder-migration.state.json");
    const state = newMigrationState({
      tenant: TENANT,
      bucket: "reading-lite",
      vectorize: "reading-lite",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    state.copies[`u/${TENANT}/index/list.json`] = {
      from: "index/list.json",
      sha256: "a".repeat(64),
      size: 12,
      copied_at: "2026-08-24T00:00:01.000Z",
    };
    state.vectors.rd_a = {
      tenant_vector_id: `${TENANT}:rd_a`,
      upserted_at: "2026-08-24T00:00:02.000Z",
    };
    await saveMigrationState(path, state);
    expect(await loadMigrationState(path)).toEqual(state);
    expect(await readdir(dir)).toEqual(["founder-migration.state.json"]);
  });

  it("round-trips the etag evidence cache, and loads a state file written before it", async () => {
    const path = join(dir, "founder-migration.state.json");
    const state = newMigrationState({
      tenant: TENANT,
      bucket: "reading-lite",
      vectorize: "reading-lite",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    state.evidence = {
      rd_a: {
        manifest: {
          etag: "etag-a",
          id: "rd_a",
          url: "https://a.example/x",
          status: "ready",
        },
        pointer: { etag: "etag-b", id: "rd_a", key_prefix: "readings/2026/01/01T000000Z-rd_a" },
      },
    };
    await saveMigrationState(path, state);
    expect(await loadMigrationState(path)).toEqual(state);
    // The cache holds every reading's URL, so the ledger is corpus content and
    // is written owner-only (matching the batch sidecars).
    const { stat } = await import("node:fs/promises");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // A pre-cache ledger stays loadable: evidence is an optimization, so its
    // absence costs reads, never a resume.
    const { writeFile } = await import("node:fs/promises");
    const legacy = join(dir, "legacy.json");
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        tenant: TENANT,
        bucket: "reading-lite",
        vectorize: "reading-lite",
        started_at: "2026-08-24T00:00:00.000Z",
        copies: {},
        vectors: {},
      }),
    );
    expect((await loadMigrationState(legacy))?.evidence).toBeUndefined();
  });

  it("returns null for a missing file but throws loudly on a corrupt one", async () => {
    expect(await loadMigrationState(join(dir, "absent.json"))).toBeNull();
    const path = join(dir, "corrupt.json");
    await saveMigrationState(
      path,
      newMigrationState({ tenant: TENANT, bucket: "b", vectorize: "v", startedAt: "t" }),
    ).then(async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, '{"version":1,"tenant":"nope"}');
    });
    await expect(loadMigrationState(path)).rejects.toThrow(/resolve it manually/);
  });
});
