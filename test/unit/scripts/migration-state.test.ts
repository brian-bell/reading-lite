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
          created_at: "2026-01-01T00:00:00Z",
          title: "A title",
          tldr: "A summary",
          tags: ["t"],
        },
        pointer: { etag: "etag-b", id: "rd_a", key_prefix: "readings/2026/01/01T000000Z-rd_a" },
      },
    };
    state.by_url = {
      ["a".repeat(64)]: { etag: "etag-c", id: "rd_a", key_prefix: "readings/2026/01/01T000000Z-rd_a" },
    };
    state.copies["u/usr/readings/2026/01/01T000000Z-rd_a/manifest.json"] = {
      from: "readings/2026/01/01T000000Z-rd_a/manifest.json",
      sha256: "b".repeat(64),
      size: 12,
      etag: "etag-d",
      copied_at: "2026-08-24T00:00:00.000Z",
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

  it("drops an undecodable evidence cache on load instead of failing the resume", async () => {
    // The caches are an optimization, never a premise: a ledger whose
    // evidence predates a schema change (here the pre-projection three-field
    // manifest shape) must still resume — losing the cache only costs reads.
    const { writeFile } = await import("node:fs/promises");
    const path = join(dir, "stale-evidence.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        tenant: TENANT,
        bucket: "reading-lite",
        vectorize: "reading-lite",
        started_at: "2026-08-24T00:00:00.000Z",
        copies: {
          "u/usr/x": { from: "x", sha256: "c".repeat(64), size: 1, copied_at: "t" },
        },
        vectors: {},
        evidence: {
          rd_a: { manifest: { etag: "e", id: "rd_a", url: "https://a.example/x", status: "ready" } },
        },
      }),
    );
    const loaded = await loadMigrationState(path);
    expect(loaded?.copies["u/usr/x"]?.sha256).toBe("c".repeat(64));
    expect(loaded?.evidence).toBeUndefined();
    expect(loaded?.by_url).toBeUndefined();
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
