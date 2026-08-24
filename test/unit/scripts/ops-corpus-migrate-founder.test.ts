import { describe, expect, it } from "vitest";
import {
  corpusMigrateFounderCommand,
  type CorpusMigrateFounderDeps,
  type MigrateFounderClients,
} from "../../../scripts/ops-lib/commands/corpus-migrate-founder";
import {
  newMigrationState,
  type MigrationState,
} from "../../../scripts/corpus-lib/migration-state";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";
import type { StoredVector } from "../../../scripts/lib/cf-clients";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const READY_PREFIX = "readings/2026/01/01T000000Z-rd_ready";

// A tiny but complete global layout: one ready reading (manifest, extracted,
// raw, attempt, pointers) plus the list index — 7 objects, 1 vector.
const LIST_DOC = {
  version: 1,
  items: [
    {
      id: "rd_ready",
      url: "https://a.example/x",
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      key_prefix: READY_PREFIX,
    },
  ],
};

// The manifest the ready row projects: the plan reads it back and requires the
// row's id/url/status to match, so the fixture must be a real manifest.
const READY_MANIFEST = {
  id: "rd_ready",
  url: "https://a.example/x",
  url_hash: urlHash("https://a.example/x"),
  status: "ready",
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 4,
  content_sha256: "a".repeat(64),
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const READY_POINTER = { id: "rd_ready", key_prefix: READY_PREFIX };

function sourceObjects(): Map<string, { body: string; contentType: string }> {
  return new Map([
    ["index/list.json", { body: JSON.stringify(LIST_DOC), contentType: "application/json" }],
    ["index/by-id/rd_ready", { body: JSON.stringify(READY_POINTER), contentType: "application/json" }],
    [
      `index/by-url/${urlHash("https://a.example/x")}`,
      { body: JSON.stringify(READY_POINTER), contentType: "application/json" },
    ],
    [`${READY_PREFIX}/manifest.json`, { body: JSON.stringify(READY_MANIFEST), contentType: "application/json" }],
    [`${READY_PREFIX}/extracted.md`, { body: "# hi", contentType: "text/markdown" }],
    [`${READY_PREFIX}/raw.html`, { body: "<html/>", contentType: "text/html" }],
    [`${READY_PREFIX}/attempts/at_1.json`, { body: "{}", contentType: "application/json" }],
  ]);
}

interface Harness {
  deps: CorpusMigrateFounderDeps;
  out: string[];
  err: string[];
  objects: Map<string, { body: string; contentType: string }>;
  vectors: Map<string, StoredVector>;
  puts: string[];
  upserts: { id: string; namespace: string; metadata: Record<string, unknown> }[];
  savedStates: MigrationState[];
  stateOnDisk: { value: MigrationState | null };
  sleeps: number[];
}

// In-memory bucket + vector index. Etags are derived from bodies, so a copied
// destination naturally lists as identical — the same property real R2 gives
// single-part copies.
function makeHarness(opts: { legacyVector?: boolean } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const objects = sourceObjects();
  const vectors = new Map<string, StoredVector>();
  if (opts.legacyVector !== false) {
    vectors.set("rd_ready", {
      id: "rd_ready",
      values: [0.1, 0.2],
      metadata: { url: "https://a.example/x", title: "X" },
    });
  }
  const puts: string[] = [];
  const upserts: Harness["upserts"] = [];
  const savedStates: MigrationState[] = [];
  const stateOnDisk: { value: MigrationState | null } = { value: null };
  const sleeps: number[] = [];

  const clients = (namespace: string): MigrateFounderClients => ({
    r2: {
      listObjects: async () =>
        [...objects.entries()].map(([key, o]) => ({
          key,
          size: o.body.length,
          etag: `etag-${o.body.length}-${o.body.slice(0, 8)}`,
        })),
      get: async (key) => objects.get(key)?.body ?? null,
      getBytes: async (key) => {
        const o = objects.get(key);
        if (!o) return null;
        return { body: new TextEncoder().encode(o.body), contentType: o.contentType };
      },
      put: async (key, body, o) => {
        puts.push(key);
        objects.set(key, {
          body: new TextDecoder().decode(body as Uint8Array),
          contentType: o?.contentType ?? "application/octet-stream",
        });
      },
    },
    vectorize: {
      getByIds: async (ids) =>
        ids.map((id) => vectors.get(id)).filter((v): v is StoredVector => v !== undefined),
      upsert: async (vs) => {
        for (const v of vs) {
          upserts.push({ id: v.id, namespace, metadata: v.metadata });
          vectors.set(v.id, { ...v, namespace });
        }
      },
    },
  });

  const deps: CorpusMigrateFounderDeps = {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    makeClients: async ({ namespace }) => clients(namespace),
    loadState: async () => stateOnDisk.value,
    saveState: async (_path, state) => {
      stateOnDisk.value = JSON.parse(JSON.stringify(state));
      savedStates.push(stateOnDisk.value!);
    },
    now: () => "2026-08-24T00:00:00.000Z",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, out, err, objects, vectors, puts, upserts, savedStates, stateOnDisk, sleeps };
}

const run = (argv: string[], h: Harness) => corpusMigrateFounderCommand.run(argv, h.deps);

describe("ops corpus migrate-founder — plan mode", () => {
  it("requires a usr_ destination tenant; 'global' and absence are usage errors", async () => {
    const h = makeHarness();
    await expect(run([], h)).rejects.toThrow(UsageError);
    await expect(run(["--tenant", "global"], h)).rejects.toThrow(/destination usr_/);
    await expect(run(["--tenant", "not-a-tenant"], h)).rejects.toThrow(UsageError);
  });

  it("prints the exact plan without writing anything, remote or local", async () => {
    const h = makeHarness();
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(0);
    expect(h.puts).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.savedStates).toEqual([]);
    const doc = JSON.parse(h.out.join("\n"));
    expect(doc.mode).toBe("plan");
    expect(doc.copies).toHaveLength(7);
    expect(doc.copies.every((c: { to: string }) => c.to.startsWith(`u/${TENANT}/`))).toBe(true);
    expect(doc.vectors).toEqual([
      expect.objectContaining({ tenant_vector_id: `${TENANT}:rd_ready`, status: "pending" }),
    ]);
    expect(doc.counts.retained_legacy).toBe(7);
    const text = h.err.join("\n");
    expect(text).toContain("Cutover prerequisites");
    expect(text).toContain("Rollback");
  });

  it("returns 1 from plan mode when the plan has problems", async () => {
    const h = makeHarness({ legacyVector: false });
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("missing_legacy_vector");
  });

  it("invites execute when destination mismatches are the only problems — execute is their repair", async () => {
    const h = makeHarness();
    h.objects.set(`u/${TENANT}/index/by-id/rd_ready`, { body: "WRONG", contentType: "application/json" });
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(0);
    const text = h.err.join("\n");
    expect(text).toContain("destination_mismatch");
    expect(text).toContain("--execute");
    expect(text).not.toContain("Resolve the problems above before executing");
  });

  it("reports an unrecognized key as copyable but certification-blocking", async () => {
    const h = makeHarness();
    h.objects.set("tmp/stray.txt", { body: "junk", contentType: "text/plain" });
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain("unrecognized_key");
    expect(text).toContain("still copied");
  });

  it("blocks on a malformed or drifted list index instead of planning an empty corpus", async () => {
    const statusDrift = JSON.stringify({
      version: 1,
      items: [{ ...LIST_DOC.items[0], status: "complete" }],
    });
    for (const body of ["{\"items\":", JSON.stringify({ version: 2, items: [] }), statusDrift]) {
      const h = makeHarness();
      h.objects.set("index/list.json", { body, contentType: "application/json" });
      const code = await run(["--tenant", TENANT], h);
      expect(code).toBe(1);
      expect(h.err.join("\n")).toContain("invalid_list_index");
      const doc = JSON.parse(h.out.join("\n"));
      expect(doc.vectors).toEqual([]);
    }
  });

  it("refuses to certify a corpus whose list row contradicts its manifest", async () => {
    // A schema-valid but stale row: it says failed, so no vector is planned,
    // while the manifest says ready and the legacy vector exists. Presence
    // checks alone would report this corpus fully migrated and lose the vector.
    const h = makeHarness();
    h.objects.set("index/list.json", {
      body: JSON.stringify({
        version: 1,
        items: [{ ...LIST_DOC.items[0], status: "failed" }],
      }),
      contentType: "application/json",
    });
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain("row_manifest_mismatch");
    expect(text).toContain("status ready");
    expect(JSON.parse(h.out.join("\n")).vectors).toEqual([]);
  });

  it("refuses to certify a by-id pointer that is unparseable or aimed elsewhere", async () => {
    for (const body of [
      '{"id":"rd_ready"}',
      JSON.stringify({ id: "rd_other", key_prefix: READY_PREFIX }),
      JSON.stringify({ id: "rd_ready", key_prefix: "readings/2020/01/01T000000Z-rd_ready" }),
    ]) {
      const h = makeHarness();
      h.objects.set("index/by-id/rd_ready", { body, contentType: "application/json" });
      const code = await run(["--tenant", TENANT], h);
      expect(code).toBe(1);
      expect(h.err.join("\n")).toContain("row_by_id_pointer_invalid");
    }
  });

  it("refuses to certify a manifest that is present but does not parse", async () => {
    const h = makeHarness();
    h.objects.set(`${READY_PREFIX}/manifest.json`, { body: "{}", contentType: "application/json" });
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("row_manifest_unreadable");
  });
});

describe("ops corpus migrate-founder — execute", () => {
  it("refuses --execute without --sole-writer, writing nothing", async () => {
    const h = makeHarness();
    const code = await run(["--tenant", TENANT, "--execute"], h);
    expect(code).toBe(2);
    expect(h.puts).toEqual([]);
    expect(h.err.join("\n")).toContain("--sole-writer");
  });

  it("copies every object, migrates the vector namespaced+prefixed+stamped, and reconciles", async () => {
    const h = makeHarness();
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    expect(h.puts).toHaveLength(7);
    // Source objects retained (copy, not move): 7 source + 7 dest.
    expect(h.objects.size).toBe(14);
    expect(h.objects.get(`u/${TENANT}/${READY_PREFIX}/raw.html`)?.contentType).toBe("text/html");
    expect(h.upserts).toEqual([
      {
        id: `${TENANT}:rd_ready`,
        namespace: TENANT,
        metadata: { url: "https://a.example/x", title: "X", tenant_id: TENANT },
      },
    ]);
    // Legacy vector retained alongside the migrated one.
    expect(h.vectors.has("rd_ready")).toBe(true);
    const final = h.stateOnDisk.value!;
    expect(Object.keys(final.copies)).toHaveLength(7);
    for (const entry of Object.values(final.copies)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(final.vectors.rd_ready?.tenant_vector_id).toBe(`${TENANT}:rd_ready`);
    expect(final.reconciled_at).toBeDefined();
    const doc = JSON.parse(h.out.join("\n"));
    expect(doc.fully_migrated).toBe(true);
  });

  it("is idempotent: a second execute copies and upserts nothing new", async () => {
    const h = makeHarness();
    await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    const putsBefore = h.puts.length;
    const upsertsBefore = h.upserts.length;
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    expect(h.puts).toHaveLength(putsBefore);
    expect(h.upserts).toHaveLength(upsertsBefore);
  });

  it("repairs a tenant vector that carries the right values but lost its legacy metadata", async () => {
    // An earlier partial upsert: correct embedding and stamp, but none of the
    // url/title metadata SimilarityStore.query reads back. Certifying that
    // would leave namespaced queries returning nameless neighbours.
    const h = makeHarness();
    h.vectors.set(`${TENANT}:rd_ready`, {
      id: `${TENANT}:rd_ready`,
      values: [0.1, 0.2],
      metadata: { tenant_id: TENANT },
      namespace: TENANT,
    });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    expect(h.upserts).toEqual([
      {
        id: `${TENANT}:rd_ready`,
        namespace: TENANT,
        metadata: { url: "https://a.example/x", title: "X", tenant_id: TENANT },
      },
    ]);
  });

  it("--limit interrupts the pass and a rerun resumes to completion", async () => {
    const h = makeHarness();
    const first = await run(["--tenant", TENANT, "--execute", "--sole-writer", "--limit", "3"], h);
    expect(first).toBe(1);
    expect(h.puts).toHaveLength(3);
    expect(h.err.join("\n")).toContain("rerun to continue");
    const second = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(second).toBe(0);
    expect(h.puts).toHaveLength(7);
    expect(h.stateOnDisk.value?.reconciled_at).toBeDefined();
  });

  it("plan mode after a completed execute reports fully migrated with zero pending work", async () => {
    const h = makeHarness();
    await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    h.out.length = 0;
    const code = await run(["--tenant", TENANT], h);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join("\n"));
    expect(doc.counts.pending_copies).toBe(0);
    expect(doc.counts.pending_vectors).toBe(0);
    expect(h.err.join("\n")).toContain("Fully migrated");
  });

  it("re-upserts a stale tenant vector from an earlier attempt instead of trusting its id", async () => {
    const h = makeHarness();
    h.vectors.set(`${TENANT}:rd_ready`, {
      id: `${TENANT}:rd_ready`,
      values: [9, 9],
      metadata: { url: "https://a.example/x" },
      namespace: TENANT,
    });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    expect(h.upserts).toEqual([
      expect.objectContaining({ id: `${TENANT}:rd_ready`, metadata: expect.objectContaining({ tenant_id: TENANT }) }),
    ]);
    expect(h.vectors.get(`${TENANT}:rd_ready`)?.values).toEqual([0.1, 0.2]);
  });

  it("aborts execute before any write when preflight reports a fatal problem", async () => {
    const h = makeHarness();
    h.objects.set("index/list.json", { body: '{"items":', contentType: "application/json" });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(1);
    expect(h.puts).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.savedStates).toEqual([]);
    expect(h.err.join("\n")).toContain("Preflight failed");
  });

  it("proceeds through a destination mismatch — the copy loop is its repair", async () => {
    const h = makeHarness();
    const damaged = `u/${TENANT}/index/by-id/rd_ready`;
    h.objects.set(damaged, { body: "WRONG", contentType: "application/json" });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    expect(h.objects.get(damaged)?.body).toBe(JSON.stringify(READY_POINTER));
  });

  it("copies an unrecognized stray key (zero loss) but withholds certification", async () => {
    const h = makeHarness();
    h.objects.set("tmp/stray.txt", { body: "junk", contentType: "text/plain" });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(1);
    // The stray key IS copied — zero lost objects — alongside the 7 known ones.
    expect(h.objects.get(`u/${TENANT}/tmp/stray.txt`)?.body).toBe("junk");
    expect(h.puts).toHaveLength(8);
    expect(h.stateOnDisk.value?.reconciled_at).toBeUndefined();
    expect(h.err.join("\n")).toContain("Certification blocked");
  });

  it("revokes a stale reconciled_at when a resumed pass finds new unmigrated work", async () => {
    const h = makeHarness();
    await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(h.stateOnDisk.value?.reconciled_at).toBeDefined();
    // The global writer ran since certification: two new objects appear, and
    // a limited resume copies only one of them.
    h.objects.set("index/by-id/rd_new", { body: "{}", contentType: "application/json" });
    h.objects.set("index/by-url/ffff", { body: "{}", contentType: "application/json" });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer", "--limit", "1"], h);
    expect(code).toBe(1);
    expect(h.stateOnDisk.value?.reconciled_at).toBeUndefined();
  });

  it("backfills ledger entries for writes that landed before their checkpoint", async () => {
    // Crash window: the remote PUT/upsert succeeded but the process died
    // before the checkpoint recorded it — modeled by erasing ledger entries
    // after a completed run.
    const h = makeHarness();
    await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    const lostCopy = `u/${TENANT}/${READY_PREFIX}/extracted.md`;
    delete h.stateOnDisk.value!.copies[lostCopy];
    delete h.stateOnDisk.value!.vectors.rd_ready;
    delete h.stateOnDisk.value!.reconciled_at;
    const putsBefore = h.puts.length;
    const upsertsBefore = h.upserts.length;

    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    // Rebuilt from the destination objects, not re-written remotely.
    expect(h.puts).toHaveLength(putsBefore);
    expect(h.upserts).toHaveLength(upsertsBefore);
    expect(h.err.join("\n")).toContain("Backfilled 2 ledger entries");
    const final = h.stateOnDisk.value!;
    expect(final.copies[lostCopy]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(final.vectors.rd_ready?.tenant_vector_id).toBe(`${TENANT}:rd_ready`);
    expect(final.reconciled_at).toBeDefined();
  });

  it("waits out asynchronous Vectorize visibility before concluding reconciliation", async () => {
    const h = makeHarness();
    const inner = h.deps.makeClients;
    // Freshly upserted (namespaced) vectors stay invisible to getByIds until
    // one reconcile probe has come back empty — modeling mutation lag.
    let revealAfter = 0;
    h.deps.makeClients = async (opts) => {
      const c = await inner(opts);
      const getByIds = c.vectorize.getByIds;
      c.vectorize = {
        ...c.vectorize,
        getByIds: async (ids) => {
          const res = await getByIds(ids);
          if (h.upserts.length === 0) return res;
          if (revealAfter++ < 1) return res.filter((v) => v.namespace === undefined);
          return res;
        },
      };
      return c;
    };
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(0);
    expect(h.sleeps).toEqual([5000]);
    expect(h.err.join("\n")).toContain("not yet visible");
    expect(h.stateOnDisk.value?.reconciled_at).toBeDefined();
  });

  it("refuses to resume a state file stamped for a different tenant or bucket", async () => {
    const h = makeHarness();
    h.stateOnDisk.value = newMigrationState({
      tenant: "usr_22222222-2222-4222-8222-222222222222",
      bucket: "reading-lite",
      vectorize: "reading-lite",
      startedAt: "2026-08-23T00:00:00.000Z",
    });
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(1);
    expect(h.puts).toEqual([]);
    expect(h.err.join("\n")).toContain("refusing to resume");
  });

  it("returns 1 and reports when a legacy vector vanishes mid-migration", async () => {
    const h = makeHarness();
    const inner = h.deps.makeClients;
    h.deps.makeClients = async (opts) => {
      const c = await inner(opts);
      const getByIds = c.vectorize.getByIds;
      c.vectorize = {
        ...c.vectorize,
        // Plan-phase probes see the vector; the execute-phase re-fetch loses it.
        getByIds: async (ids) => {
          const res = await getByIds(ids);
          return h.puts.length > 0 ? res.filter((v) => v.id !== "rd_ready") : res;
        },
      };
      return c;
    };
    const code = await run(["--tenant", TENANT, "--execute", "--sole-writer"], h);
    expect(code).toBe(1);
    expect(h.upserts).toEqual([]);
    expect(h.err.join("\n")).toContain("legacy vector vanished");
  });
});
