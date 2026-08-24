import { describe, expect, it } from "vitest";
import {
  founderKeyRoot,
  isFullyMigrated,
  planFounderMigration,
  type FounderMigrationInput,
} from "../../../scripts/corpus-lib/founder-migration";
import type { ListItem } from "../../../scripts/corpus-lib/types";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const ROOT = `u/${TENANT}/`;

const READY_PREFIX = "readings/2026/01/01T000000Z-rd_ready";
const FAILED_PREFIX = "readings/2026/02/02T000000Z-rd_failed";

const ROWS: ListItem[] = [
  { id: "rd_ready", url: "https://a.example/x", status: "ready", created_at: "2026-01-01T00:00:00Z", key_prefix: READY_PREFIX },
  { id: "rd_failed", url: "https://b.example/y", status: "failed", created_at: "2026-02-02T00:00:00Z", key_prefix: FAILED_PREFIX },
];

function obj(key: string, size = 10, etag = `e-${key}`) {
  return { key, size, etag };
}

const LEGACY_VECTOR = {
  id: "rd_ready",
  values: [0.1, 0.2],
  metadata: { url: "https://a.example/x" },
};

function goodTenantVector() {
  return {
    id: `${TENANT}:rd_ready`,
    values: [0.1, 0.2],
    metadata: { url: "https://a.example/x", tenant_id: TENANT },
    namespace: TENANT,
  };
}

const SOURCE_OBJECTS = [
  obj("index/list.json"),
  obj("index/by-id/rd_ready"),
  obj("index/by-id/rd_failed"),
  obj(`index/by-url/${urlHash("https://a.example/x")}`),
  obj(`index/by-url/${urlHash("https://b.example/y")}`),
  obj(`${READY_PREFIX}/manifest.json`),
  obj(`${READY_PREFIX}/extracted.md`),
  obj(`${READY_PREFIX}/raw.html`),
  obj(`${READY_PREFIX}/attempts/at_1.json`),
  obj(`${FAILED_PREFIX}/manifest.json`),
];

function input(overrides: Partial<FounderMigrationInput> = {}): FounderMigrationInput {
  return {
    tenantId: TENANT,
    objects: SOURCE_OBJECTS,
    listRows: ROWS,
    tenantVectors: new Map(),
    legacyVectors: new Map([["rd_ready", LEGACY_VECTOR]]),
    ...overrides,
  };
}

describe("planFounderMigration", () => {
  it("plans a re-rooting copy of every global object and a prefixed vector per ready row", () => {
    const plan = planFounderMigration(input());
    expect(plan.problems).toEqual([]);
    expect(plan.key_root).toBe(founderKeyRoot(TENANT));
    expect(plan.copies).toHaveLength(SOURCE_OBJECTS.length);
    for (const copy of plan.copies) {
      expect(copy.to).toBe(`${ROOT}${copy.from}`);
      expect(copy.status).toBe("pending");
    }
    expect(plan.counts.by_category).toEqual({
      manifest: 2, extracted: 1, raw: 1, attempt: 1,
      by_id: 2, by_url: 2, list_index: 1, unrecognized: 0,
    });
    expect(plan.counts.retained_legacy).toBe(SOURCE_OBJECTS.length);
    expect(plan.vectors).toEqual([
      { reading_id: "rd_ready", legacy_id: "rd_ready", tenant_vector_id: `${TENANT}:rd_ready`, status: "pending" },
    ]);
    expect(isFullyMigrated(plan)).toBe(false);
  });

  it("marks copies done only when the destination matches size and etag", () => {
    const done = obj(`${ROOT}index/list.json`);
    done.size = 10;
    done.etag = "e-index/list.json";
    const mismatched = { key: `${ROOT}index/by-id/rd_ready`, size: 99, etag: "different" };
    const plan = planFounderMigration(input({ objects: [...SOURCE_OBJECTS, done, mismatched] }));
    const byFrom = new Map(plan.copies.map((c) => [c.from, c]));
    expect(byFrom.get("index/list.json")?.status).toBe("copied");
    expect(byFrom.get("index/by-id/rd_ready")?.status).toBe("pending");
    expect(plan.problems).toEqual([
      expect.objectContaining({ kind: "destination_mismatch" }),
    ]);
    expect(plan.counts.copied).toBe(1);
    expect(plan.counts.pending_copies).toBe(SOURCE_OBJECTS.length - 1);
  });

  it("reconciles as fully migrated when every copy and vector is in place", () => {
    const destCopies = SOURCE_OBJECTS.map((o) => ({ ...o, key: `${ROOT}${o.key}` }));
    const plan = planFounderMigration(
      input({
        objects: [...SOURCE_OBJECTS, ...destCopies],
        tenantVectors: new Map([[`${TENANT}:rd_ready`, goodTenantVector()]]),
      }),
    );
    expect(plan.problems).toEqual([]);
    expect(plan.counts.pending_copies).toBe(0);
    expect(plan.counts.pending_vectors).toBe(0);
    expect(isFullyMigrated(plan)).toBe(true);
  });

  it("keeps counting an upserted vector even after the legacy vector disappears", () => {
    // Post-observation legacy deletion must not regress reconciliation.
    const plan = planFounderMigration(
      input({
        tenantVectors: new Map([[`${TENANT}:rd_ready`, goodTenantVector()]]),
        legacyVectors: new Map(),
      }),
    );
    expect(plan.vectors[0]?.status).toBe("upserted");
    expect(plan.problems).toEqual([]);
  });

  it("re-plans a stale or unstamped tenant vector as pending, not migrated", () => {
    // Content verdict: matching id alone must not count as migrated while the
    // legacy vector is still there to compare against and re-migrate from.
    const staleValues = { ...goodTenantVector(), values: [0.9, 0.9] };
    const missingStamp = { ...goodTenantVector(), metadata: { url: "https://a.example/x" } };
    for (const tenantVec of [staleValues, missingStamp]) {
      const plan = planFounderMigration(
        input({ tenantVectors: new Map([[`${TENANT}:rd_ready`, tenantVec]]) }),
      );
      expect(plan.vectors[0]?.status).toBe("pending");
      expect(plan.problems).toEqual([]);
    }
  });

  it("blocks a stampless tenant vector whose legacy source is gone — unverifiable", () => {
    const stampless = { ...goodTenantVector(), metadata: { url: "https://a.example/x" } };
    const plan = planFounderMigration(
      input({
        tenantVectors: new Map([[`${TENANT}:rd_ready`, stampless]]),
        legacyVectors: new Map(),
      }),
    );
    expect(plan.vectors).toEqual([]);
    expect(plan.problems).toEqual([
      expect.objectContaining({ kind: "unverified_tenant_vector" }),
    ]);
  });

  it("flags a ready row with no vector anywhere as unmigratable", () => {
    const plan = planFounderMigration(input({ legacyVectors: new Map() }));
    expect(plan.vectors).toEqual([]);
    expect(plan.problems).toEqual([
      expect.objectContaining({ kind: "missing_legacy_vector", detail: expect.stringContaining("rd_ready") }),
    ]);
  });

  it("blocks on an untrusted list index instead of planning an empty corpus", () => {
    const plan = planFounderMigration(
      input({ listRows: [], listIndexError: "index/list.json did not parse" }),
    );
    expect(plan.vectors).toEqual([]);
    expect(plan.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "invalid_list_index" })]),
    );
    expect(isFullyMigrated(plan)).toBe(false);
  });

  it("flags a manifest the list index does not cover — its vector would never be planned", () => {
    const orphanManifest = obj("readings/2026/03/03T000000Z-rd_orphan/manifest.json");
    const plan = planFounderMigration(input({ objects: [...SOURCE_OBJECTS, orphanManifest] }));
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "manifest_not_in_list_index",
        detail: expect.stringContaining("rd_orphan"),
      }),
    ]);
    // The object still copies — the block is on reconciliation, not the copy.
    expect(plan.copies.some((c) => c.from === orphanManifest.key)).toBe(true);
  });

  it("copies unrecognized keys anyway but reports them, and flags foreign tenant roots", () => {
    const stray = obj("tmp/debug.txt");
    const foreign = obj("u/usr_22222222-2222-4222-8222-222222222222/index/list.json");
    const plan = planFounderMigration(input({ objects: [...SOURCE_OBJECTS, stray, foreign] }));
    expect(plan.copies.some((c) => c.from === "tmp/debug.txt" && c.category === "unrecognized")).toBe(true);
    expect(plan.copies.some((c) => c.from.startsWith("u/"))).toBe(false);
    expect(plan.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unrecognized_key" }),
        expect.objectContaining({ kind: "foreign_tenant_object" }),
      ]),
    );
  });

  it("flags a row whose URL has no by-url ownership pointer anywhere", () => {
    const objects = SOURCE_OBJECTS.filter(
      (o) => o.key !== `index/by-url/${urlHash("https://b.example/y")}`,
    );
    const plan = planFounderMigration(input({ objects }));
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "row_missing_by_url_pointer",
        detail: expect.stringContaining("rd_failed"),
      }),
    ]);
  });

  it("flags rows whose manifest or by-id pointer is missing, and a missing list index", () => {
    const objects = SOURCE_OBJECTS.filter(
      (o) =>
        o.key !== "index/list.json" &&
        o.key !== `${FAILED_PREFIX}/manifest.json` &&
        o.key !== "index/by-id/rd_ready",
    );
    const plan = planFounderMigration(input({ objects }));
    const kinds = plan.problems.map((p) => p.kind).sort();
    expect(kinds).toEqual(["missing_list_index", "row_missing_by_id_pointer", "row_missing_manifest"]);
  });

  it("an empty source layout never reconciles as migrated", () => {
    const plan = planFounderMigration(input({ objects: [], listRows: [] }));
    expect(plan.problems).toEqual([expect.objectContaining({ kind: "missing_list_index" })]);
    expect(isFullyMigrated(plan)).toBe(false);
  });
});
