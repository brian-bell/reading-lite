import { describe, expect, it } from "vitest";
import {
  executeBlockingProblems,
  founderKeyRoot,
  isFullyMigrated,
  planFounderMigration,
  type ByUrlSlotEvidence,
  type FounderMigrationInput,
  type RowEvidence,
} from "../../../scripts/corpus-lib/founder-migration";
import type { ListIndexItem } from "../../../src/schemas/api";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const ROOT = `u/${TENANT}/`;

const READY_PREFIX = "readings/2026/01/01T000000Z-rd_ready";
const FAILED_PREFIX = "readings/2026/02/02T000000Z-rd_failed";

const ROWS: ListIndexItem[] = [
  { id: "rd_ready", url: "https://a.example/x", status: "ready", created_at: "2026-01-01T00:00:00Z", key_prefix: READY_PREFIX },
  { id: "rd_failed", url: "https://b.example/y", status: "failed", created_at: "2026-02-02T00:00:00Z", key_prefix: FAILED_PREFIX },
];

function obj(key: string, size = 10, etag = `e-${key}`) {
  return { key, size, etag };
}

// Evidence that agrees with ROWS: each manifest projects the row's own full
// list projection, each by-id pointer targets the row's own key prefix.
function agreeingEvidence(rows: ListIndexItem[] = ROWS): Map<string, RowEvidence> {
  return new Map(
    rows.map((row) => {
      const { key_prefix, ...projection } = row;
      return [row.id, { manifest: projection, pointer: { id: row.id, key_prefix } }];
    }),
  );
}

// By-url slot evidence that agrees with ROWS: each URL's slot targets the row
// that owns it.
function agreeingByUrlEvidence(rows: ListIndexItem[] = ROWS): Map<string, ByUrlSlotEvidence> {
  return new Map(
    rows.map((row) => [
      urlHash(row.url),
      { pointer: { id: row.id, key_prefix: row.key_prefix } },
    ]),
  );
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
    rowEvidence: agreeingEvidence(),
    byUrlEvidence: agreeingByUrlEvidence(),
    ...overrides,
  };
}

function withEvidence(id: string, evidence: RowEvidence): Map<string, RowEvidence> {
  const map = agreeingEvidence();
  map.set(id, evidence);
  return map;
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

  it("certifies a complete founder copy even when another tenant's objects share the bucket", () => {
    const destCopies = SOURCE_OBJECTS.map((o) => ({ ...o, key: `${ROOT}${o.key}` }));
    const foreign = obj("u/usr_22222222-2222-4222-8222-222222222222/index/list.json");
    const plan = planFounderMigration(
      input({
        objects: [...SOURCE_OBJECTS, ...destCopies, foreign],
        tenantVectors: new Map([[`${TENANT}:rd_ready`, goodTenantVector()]]),
      }),
    );
    expect(plan.problems).toEqual([expect.objectContaining({ kind: "foreign_tenant_object" })]);
    expect(executeBlockingProblems(plan)).toEqual([]);
    expect(plan.counts.pending_copies).toBe(0);
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

  it("blocks a row whose manifest contradicts its list projection — the vector plan would skip it", () => {
    // The stale-row case the whole vector plan hangs on: the row says failed,
    // so no vector is planned, while the manifest says ready and the legacy
    // vector is real. Key presence alone would certify this corpus.
    const plan = planFounderMigration(
      input({
        rowEvidence: withEvidence("rd_failed", {
          manifest: { id: "rd_failed", url: "https://b.example/y", status: "ready", created_at: "2026-02-02T00:00:00Z" },
          pointer: { id: "rd_failed", key_prefix: FAILED_PREFIX },
        }),
      }),
    );
    expect(plan.vectors.map((v) => v.reading_id)).toEqual(["rd_ready"]);
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "row_manifest_mismatch",
        detail: expect.stringContaining("status ready"),
      }),
    ]);
    expect(isFullyMigrated(plan)).toBe(false);
    expect(executeBlockingProblems(plan)).toHaveLength(1);
  });

  it("blocks on a manifest whose id or url drifted from its row", () => {
    const plan = planFounderMigration(
      input({
        rowEvidence: withEvidence("rd_ready", {
          manifest: { id: "rd_other", url: "https://elsewhere.example/z", status: "ready", created_at: "2026-01-01T00:00:00Z" },
          pointer: { id: "rd_ready", key_prefix: READY_PREFIX },
        }),
      }),
    );
    const mismatch = plan.problems.find((p) => p.kind === "row_manifest_mismatch");
    expect(mismatch?.detail).toContain("rd_other");
    expect(mismatch?.detail).toContain("https://elsewhere.example/z");
  });

  it("blocks a row whose manifest projection drifted beyond id/url/status — stale title or tldr", () => {
    // The list rows are what readers are served; a byte-identical copy of a
    // row whose title/tldr went stale would otherwise certify out of sync
    // with its manifest. Both directions are drift: a field the manifest
    // dropped is as stale as one it changed.
    const staleTitle = withEvidence("rd_ready", {
      manifest: {
        id: "rd_ready", url: "https://a.example/x", status: "ready",
        created_at: "2026-01-01T00:00:00Z", title: "Fresh title", tldr: "Fresh summary",
      },
      pointer: { id: "rd_ready", key_prefix: READY_PREFIX },
    });
    const plan = planFounderMigration(input({ rowEvidence: staleTitle }));
    const mismatch = plan.problems.find((p) => p.kind === "row_manifest_mismatch");
    expect(mismatch?.detail).toContain("title Fresh title");
    expect(mismatch?.detail).toContain("tldr Fresh summary");
    expect(isFullyMigrated(plan)).toBe(false);

    const rowsWithTitle = ROWS.map((row) =>
      row.id === "rd_ready" ? { ...row, title: "Stale row title" } : row,
    );
    const dropped = planFounderMigration(
      input({ listRows: rowsWithTitle, rowEvidence: agreeingEvidence() }),
    );
    const droppedMismatch = dropped.problems.find((p) => p.kind === "row_manifest_mismatch");
    expect(droppedMismatch?.detail).toContain("title absent from the manifest");
  });

  it("blocks a by-url pointer that is unparseable — resolveOwner throws on it with no self-heal", () => {
    const byUrl = agreeingByUrlEvidence();
    byUrl.set(urlHash("https://a.example/x"), { pointer_error: "Unexpected token in JSON" });
    const plan = planFounderMigration(input({ byUrlEvidence: byUrl }));
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "by_url_pointer_invalid",
        detail: expect.stringContaining("Unexpected token in JSON"),
      }),
    ]);
    expect(executeBlockingProblems(plan)).toHaveLength(1);
    expect(isFullyMigrated(plan)).toBe(false);
  });

  it("blocks a by-url pointer that targets a reading which does not own the slot's URL", () => {
    const byUrl = agreeingByUrlEvidence();
    byUrl.set(urlHash("https://a.example/x"), {
      pointer: { id: "rd_failed", key_prefix: FAILED_PREFIX },
    });
    const plan = planFounderMigration(input({ byUrlEvidence: byUrl }));
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "by_url_pointer_invalid",
        detail: expect.stringContaining("rd_failed"),
      }),
    ]);
  });

  it("lets duplicate-URL rows share one by-url slot owned by either copy", () => {
    const shared = "https://c.example/z";
    const prefixA = "readings/2026/03/03T000000Z-rd_dupa";
    const prefixB = "readings/2026/04/04T000000Z-rd_dupb";
    const rows: ListIndexItem[] = [
      { id: "rd_dupa", url: shared, status: "failed", created_at: "2026-03-03T00:00:00Z", key_prefix: prefixA },
      { id: "rd_dupb", url: shared, status: "failed", created_at: "2026-04-04T00:00:00Z", key_prefix: prefixB },
    ];
    const objects = [
      obj("index/list.json"),
      obj("index/by-id/rd_dupa"),
      obj("index/by-id/rd_dupb"),
      obj(`index/by-url/${urlHash(shared)}`),
      obj(`${prefixA}/manifest.json`),
      obj(`${prefixB}/manifest.json`),
    ];
    // The slot is owned by whichever copy claimed it — either row certifies.
    for (const owner of rows) {
      const plan = planFounderMigration(
        input({
          objects,
          listRows: rows,
          rowEvidence: agreeingEvidence(rows),
          byUrlEvidence: new Map([
            [urlHash(shared), { pointer: { id: owner.id, key_prefix: owner.key_prefix } }],
          ]),
          legacyVectors: new Map(),
        }),
      );
      expect(plan.problems).toEqual([]);
    }
  });

  it("flags a dangling by-url slot no list row's URL hashes to", () => {
    const dangling = obj(`index/by-url/${urlHash("https://gone.example/dropped")}`);
    const byUrl = agreeingByUrlEvidence();
    byUrl.set(urlHash("https://gone.example/dropped"), {
      pointer: { id: "rd_gone", key_prefix: "readings/2020/01/01T000000Z-rd_gone" },
    });
    const plan = planFounderMigration(
      input({ objects: [...SOURCE_OBJECTS, dangling], byUrlEvidence: byUrl }),
    );
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "by_url_pointer_invalid",
        detail: expect.stringContaining("dangling"),
      }),
    ]);
  });

  it("blocks on a manifest that is present but unreadable", () => {
    const plan = planFounderMigration(
      input({
        rowEvidence: withEvidence("rd_ready", {
          manifest_error: "did not parse as a manifest: invalid status",
          pointer: { id: "rd_ready", key_prefix: READY_PREFIX },
        }),
      }),
    );
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "row_manifest_unreadable",
        detail: expect.stringContaining("invalid status"),
      }),
    ]);
  });

  it("blocks a by-id pointer that resolves to a different reading or key prefix", () => {
    for (const pointer of [
      { id: "rd_other", key_prefix: READY_PREFIX },
      { id: "rd_ready", key_prefix: "readings/2020/01/01T000000Z-rd_ready" },
    ]) {
      const plan = planFounderMigration(input({ rowEvidence: withEvidence("rd_ready", { manifest: { id: "rd_ready", url: "https://a.example/x", status: "ready", created_at: "2026-01-01T00:00:00Z" }, pointer }) }));
      expect(plan.problems).toEqual([
        expect.objectContaining({
          kind: "row_by_id_pointer_invalid",
          detail: expect.stringContaining("rd_ready"),
        }),
      ]);
      expect(isFullyMigrated(plan)).toBe(false);
    }
  });

  it("blocks a by-id pointer that is present but unparseable", () => {
    const plan = planFounderMigration(
      input({
        rowEvidence: withEvidence("rd_ready", {
          manifest: { id: "rd_ready", url: "https://a.example/x", status: "ready", created_at: "2026-01-01T00:00:00Z" },
          pointer_error: "did not parse as a by-id pointer: key_prefix required",
        }),
      }),
    );
    expect(plan.problems).toEqual([
      expect.objectContaining({
        kind: "row_by_id_pointer_invalid",
        detail: expect.stringContaining("key_prefix required"),
      }),
    ]);
  });

  it("does not double-report content problems for an object that is simply missing", () => {
    // row_missing_manifest / row_missing_by_id_pointer already cover absence;
    // the content checks only run on objects the listing actually has.
    const objects = SOURCE_OBJECTS.filter(
      (o) => o.key !== `${FAILED_PREFIX}/manifest.json` && o.key !== "index/by-id/rd_failed",
    );
    const evidence = agreeingEvidence();
    evidence.delete("rd_failed");
    const plan = planFounderMigration(input({ objects, rowEvidence: evidence }));
    expect(plan.problems.map((p) => p.kind).sort()).toEqual([
      "row_missing_by_id_pointer",
      "row_missing_manifest",
    ]);
  });

  it("re-plans a tenant vector that dropped the legacy metadata query depends on", () => {
    // Same values and stamp, but the url/title/tldr/tags a namespaced query
    // reads back are gone — reconciliation must repair it, not certify it.
    const legacy = {
      id: "rd_ready",
      values: [0.1, 0.2],
      metadata: { url: "https://a.example/x", title: "X", tags: ["a", "b"] },
    };
    const cases = [
      // Dropped, staled, and shortened relative to the legacy metadata …
      { url: "https://a.example/x", tenant_id: TENANT },
      { url: "https://a.example/x", title: "STALE", tags: ["a", "b"], tenant_id: TENANT },
      { url: "https://a.example/x", title: "X", tags: ["a"], tenant_id: TENANT },
      // … and a field the legacy vector no longer has: query still returns it,
      // and the re-upsert (legacy metadata + stamp) is what removes it.
      { ...legacy.metadata, tldr: "stale summary", tenant_id: TENANT },
    ];
    for (const metadata of cases) {
      const plan = planFounderMigration(
        input({
          legacyVectors: new Map([["rd_ready", legacy]]),
          tenantVectors: new Map([[`${TENANT}:rd_ready`, { ...goodTenantVector(), metadata }]]),
        }),
      );
      expect(plan.vectors[0]?.status).toBe("pending");
    }
  });

  it("counts a tenant vector carrying the full legacy metadata plus the stamp as migrated", () => {
    const legacy = {
      id: "rd_ready",
      values: [0.1, 0.2],
      metadata: { url: "https://a.example/x", title: "X", tags: ["a", "b"] },
    };
    const plan = planFounderMigration(
      input({
        legacyVectors: new Map([["rd_ready", legacy]]),
        tenantVectors: new Map([
          [
            `${TENANT}:rd_ready`,
            { ...goodTenantVector(), metadata: { ...legacy.metadata, tenant_id: TENANT } },
          ],
        ]),
      }),
    );
    expect(plan.vectors[0]?.status).toBe("upserted");
    expect(plan.problems).toEqual([]);
  });

  it("an empty source layout never reconciles as migrated", () => {
    const plan = planFounderMigration(input({ objects: [], listRows: [] }));
    expect(plan.problems).toEqual([expect.objectContaining({ kind: "missing_list_index" })]);
    expect(isFullyMigrated(plan)).toBe(false);
  });
});
