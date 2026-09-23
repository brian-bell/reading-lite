import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { migrateExportCommand, type MigrateExportDeps } from "../../../scripts/ops-lib/commands/migrate-export";
import { applyReembeds, collectExport } from "../../../scripts/migrate-lib/export-library";
import { readSnapshot, writeSnapshot } from "../../../scripts/migrate-lib/snapshot";
import { blockingIssues } from "../../../scripts/migrate-lib/library-checks";
import {
  D1_PAGE_SIZE,
  D1_SOURCE_CONFIG,
  GET_BY_IDS_LIMIT,
  vectorizeGetByIds,
  wranglerD1Reader,
} from "../../../scripts/migrate-lib/sources";
import { buildLegacyCorpus, LegacyLibrary, LEGACY_TENANT, OTHER_TENANT, unitVector } from "../../helpers/legacy-library";

async function exported(setup: (lib: LegacyLibrary) => void = buildLegacyCorpus) {
  const lib = new LegacyLibrary();
  setup(lib);
  return { lib, collection: await collectExport(LEGACY_TENANT, lib.source()) };
}

const collection_urlHash = (url: string) => createHash("sha256").update(url).digest("hex");

const findings = (collection: Awaited<ReturnType<typeof exported>>["collection"]) =>
  [...collection.report.blocking, ...collection.report.discrepancies];

describe("migrate export: collection", () => {
  it("reads only the tenant's root and its composed vector ids, never global or another tenant's data", async () => {
    const { lib, collection } = await exported();
    const root = `u/${LEGACY_TENANT}/`;
    expect(lib.listed).toEqual([root]);
    expect(lib.gets.filter((key) => !key.startsWith(root))).toEqual([]);
    expect(lib.vectorRequests.flat().every((id) => id.startsWith(`${LEGACY_TENANT}:`))).toBe(true);
    const ids = collection.library.readings.map((r) => r.id);
    expect(ids).not.toContain("rd_GLOBAL001");
    expect(ids).not.toContain("rd_OTHER0001");
    expect(ids).toEqual([
      "rd_BAD000001", "rd_FAIL00001", "rd_HASH00001", "rd_PEND00001",
      "rd_RAWEXT001", "rd_READY0001", "rd_READY0002", "rd_READY0003", "rd_TOMB00001",
    ]);
  });

  it("takes the inventory from manifests, not index/list.json", async () => {
    const { collection } = await exported();
    // rd_PEND00001 has no list row and is still exported; the list's orphan row is not.
    expect(collection.library.readings.map((r) => r.id)).toContain("rd_PEND00001");
    expect(collection.library.readings.map((r) => r.id)).not.toContain("rd_LISTONLY1");
  });

  it.each([
    ["list_row_missing", "rd_PEND00001"],
    ["list_row_orphan", "rd_LISTONLY1"],
    ["duplicate_url", "rd_READY0001"],
    ["dangling_relationship", "rd_READY0001"],
    ["content_hash_mismatch", "rd_HASH00001"],
    ["content_size_mismatch", "rd_HASH00001"],
    ["content_missing", "rd_HASH00001"],
    ["content_key_mismatch", "rd_RAWEXT001"],
    ["stripped_fields", "rd_READY0002"],
    ["timestamp_respelled", "rd_READY0002"],
    ["mapping_note", "rd_READY0002"],
    ["vector_reembedded", "rd_READY0003"],
    ["vector_for_non_ready", "rd_FAIL00001"],
    ["ledger_live_without_ready_reading", "rd_FAIL00001"],
    ["other_accounts", undefined],
    // Blocking.
    ["malformed_manifest", "rd_BAD000001"],
    ["tombstoned_manifest", "rd_TOMB00001"],
    ["unresolved_pending", "rd_PEND00001"],
  ])("reports %s (%s)", async (code, id) => {
    const { collection } = await exported();
    expect(findings(collection)).toContainEqual(expect.objectContaining({ code, ...(id ? { id } : {}) }));
  });

  it("gives the URL to its pointer's reading and reports the other holder", async () => {
    const { collection } = await exported();
    const owns = Object.fromEntries(collection.library.readings.map((r) => [r.id, r.owns_url]));
    expect(owns.rd_READY0001).toBe(true);
    expect(owns.rd_FAIL00001).toBe(false);
    expect(collection.report.duplicate_url_owners).toEqual([
      expect.objectContaining({ owner: "rd_READY0001", others: ["rd_FAIL00001"] }),
    ]);
  });

  it("asks get_by_ids again for a batch miss, and re-embeds only what is still missing", async () => {
    const { lib, collection } = await exported();
    expect(lib.vectorRequests).toContainEqual([`${LEGACY_TENANT}:rd_READY0002`]);
    const ready2 = collection.library.readings.find((r) => r.id === "rd_READY0002")!;
    expect(ready2.embedding?.source).toBe("vectorize");
    expect(collection.reembed).toEqual([{ id: "rd_READY0003", tldr: "Summary of rd_READY0003." }]);
    // Not blocking in the plan: --execute embeds it before the snapshot exists.
    expect(collection.report.blocking.map((d) => d.id)).not.toContain("rd_READY0003");

    const done = applyReembeds(collection, [unitVector(3)]);
    expect(blockingIssues(collection.library, collection.controlPlane, LEGACY_TENANT)).toContainEqual(
      expect.objectContaining({ code: "unusable_vector", id: "rd_READY0003" }),
    );
    expect(done.library.readings.find((r) => r.id === "rd_READY0003")!.embedding?.source).toBe("reembedded");
    expect(done.report.blocking.map((d) => d.code)).not.toContain("unusable_vector");
  });

  it("keeps vectors for URL owners only, as the runtime does, and never re-embeds a duplicate", async () => {
    const { collection } = await exported((lib) => {
      lib.addReading({ id: "rd_OWNER0001", url: "https://example.com/dup" });
      lib.addReading({ id: "rd_DUPVEC001", url: "https://example.com/dup", pointer: false });
      lib.addReading({ id: "rd_DUPNOV001", url: "https://example.com/dup", pointer: false, vector: "missing" });
      lib.putJson(`u/${LEGACY_TENANT}/index/by-url/${collection_urlHash("https://example.com/dup")}`, {
        id: "rd_OWNER0001",
        key_prefix: lib.prefixFor("rd_OWNER0001"),
      });
    });
    const embeddings = Object.fromEntries(collection.library.readings.map((r) => [r.id, r.embedding?.source ?? null]));
    expect(embeddings).toEqual({ rd_OWNER0001: "vectorize", rd_DUPVEC001: null, rd_DUPNOV001: null });
    expect(collection.reembed).toEqual([]);
    expect(collection.report.vectors.non_owner).toEqual(["rd_DUPVEC001"]);
    expect(collection.report.blocking).toEqual([]);
  });

  it("counts a vector recovered by the individual retry as found", async () => {
    const { collection } = await exported((lib) => {
      lib.addReading({ id: "rd_FLAKY0001", vector: "flaky" });
      lib.addReading({ id: "rd_STEADY001" });
    });
    expect(collection.report.vectors).toMatchObject({ found: 2, retried_individually: ["rd_FLAKY0001"] });
  });

  it("gives a purged owner's URL to the surviving copy, which keeps its vector", async () => {
    const { collection } = await exported((lib) => {
      lib.addReading({ id: "rd_GONEOWN01", url: "https://example.com/p" });
      lib.addReading({ id: "rd_SURVIVE01", url: "https://example.com/p", pointer: false, createdAt: "2026-02-01T00:00:00.000Z" });
      lib.putJson(`u/${LEGACY_TENANT}/index/by-url/${collection_urlHash("https://example.com/p")}`, {
        id: "rd_GONEOWN01",
        key_prefix: lib.prefixFor("rd_GONEOWN01"),
      });
      lib.put(`u/${LEGACY_TENANT}/index/deleted/rd_GONEOWN01`, "");
    });
    const byId = Object.fromEntries(collection.library.readings.map((r) => [r.id, r]));
    expect(byId.rd_SURVIVE01).toMatchObject({ owns_url: true, embedding: { source: "vectorize" } });
    expect(byId.rd_GONEOWN01!.owns_url).toBe(false);
    expect(findings(collection)).toContainEqual(expect.objectContaining({ code: "url_owner_tombstoned", id: "rd_GONEOWN01" }));
  });

  it("does not pay to re-embed a tombstoned reading that import will skip", async () => {
    const { collection } = await exported((lib) => {
      lib.addReading({ id: "rd_PURGED001", vector: "missing" });
      lib.put(`u/${LEGACY_TENANT}/index/deleted/rd_PURGED001`, "");
    });
    expect(collection.reembed).toEqual([]);
    expect(collection.report.blocking.filter((d) => d.id === "rd_PURGED001").map((d) => d.code)).toEqual(["tombstoned_manifest"]);
  });

  it("refuses a returned vector that is not 1536 finite dimensions", async () => {
    const { collection } = await exported((lib) => lib.addReading({ id: "rd_WIDE00001", vector: "invalid" }));
    expect(findings(collection)).toContainEqual(expect.objectContaining({ code: "vector_invalid", id: "rd_WIDE00001" }));
    expect(collection.report.blocking).toContainEqual(expect.objectContaining({ code: "unusable_vector", id: "rd_WIDE00001" }));
    expect(collection.reembed).toEqual([]);
  });

  it.each([
    [
      "a tenant with no account row",
      (lib: LegacyLibrary) => lib.tables.users!.splice(0, 1),
      "tenant_account_missing",
    ],
    [
      "a D1 table with no mapping",
      (lib: LegacyLibrary) => (lib.tables.feature_flags = [{ name: "x", on: 1 }]),
      "invalid_control_plane_row",
    ],
    ["an unmapped D1 column", (lib: LegacyLibrary) => (lib.tables.users![0]!.nickname = "x"), "invalid_control_plane_row"],
    [
      "an unfinished wipe",
      (lib: LegacyLibrary) => Object.assign(lib.tables.wipe_progress![0]!, { phase: "objects", completed_at_ms: null }),
      "unfinished_wipe",
    ],
  ])("blocks the import on %s", async (_name, mutate, code) => {
    const { collection } = await exported((lib) => {
      lib.addReading({ id: "rd_READY0001" });
      mutate(lib);
    });
    expect(collection.report.blocking.map((d) => d.code)).toContain(code);
  });
});

function deps(lib: LegacyLibrary) {
  const writes: string[] = [];
  const embedder = vi.fn(async (inputs: string[]) => inputs.map((_, i) => unitVector(100 + i)));
  const out: string[] = [];
  const d: MigrateExportDeps = {
    io: { stdout: (t) => out.push(t), stderr: () => {} },
    openSource: async () => lib.source(),
    makeEmbedder: vi.fn(async () => embedder),
    openSpend: vi.fn(async () => ({ rpc: async () => ({ ok: true, decision: "admitted" }) as never, dispose: async () => {} })),
    fetch: vi.fn(async () => {
      throw new Error("no network in tests");
    }),
    now: () => Date.parse("2026-09-23T12:00:00.000Z"),
    writeSnapshot: (dir, parts) => {
      writes.push(dir);
      return writeSnapshot(dir, parts);
    },
  };
  return { d, writes, embedder, out };
}

describe("migrate export: command", () => {
  const argv = ["--source", "staging", "--tenant", LEGACY_TENANT];

  it("plans without embedding, opening spend, or writing", async () => {
    const lib = new LegacyLibrary();
    buildLegacyCorpus(lib);
    const { d, writes } = deps(lib);
    expect(await migrateExportCommand.run(argv, d)).toBe(0);
    expect(d.makeEmbedder).not.toHaveBeenCalled();
    expect(d.openSpend).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("embeds only the misses' tldrs under spend admission and writes a verifiable snapshot", async () => {
    const lib = new LegacyLibrary();
    buildLegacyCorpus(lib);
    const { d, embedder } = deps(lib);
    const out = path.join(mkdtempSync(path.join(tmpdir(), "rl-export-")), "snap");
    expect(await migrateExportCommand.run([...argv, "--out", out, "--execute"], d)).toBe(0);
    expect(d.openSpend).toHaveBeenCalledWith("staging");
    expect(embedder).toHaveBeenCalledTimes(1);
    expect(embedder).toHaveBeenCalledWith(["Summary of rd_READY0003."]);
    const snapshot = readSnapshot(out);
    expect(snapshot.meta.tenant_id).toBe(LEGACY_TENANT);
    expect(snapshot.library.tombstones).toEqual(["rd_TOMB00001"]);
    expect(readdirSync(out).sort()).toEqual(["control-plane.json", "library.json", "report.json", "snapshot.json"]);
    // Owner-only: the control plane carries every account's emails and credential HMACs.
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(out, "control-plane.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing snapshot before reading the source", async () => {
    const lib = new LegacyLibrary();
    const { d } = deps(lib);
    const out = mkdtempSync(path.join(tmpdir(), "rl-export-"));
    writeFileSync(path.join(out, "snapshot.json"), "{}");
    await expect(migrateExportCommand.run([...argv, "--out", out, "--execute"], d)).rejects.toThrow(UsageError);
    expect(lib.listed).toEqual([]);
  });

  it.each([
    [["--tenant", LEGACY_TENANT], "--source is required"],
    [["--source", "dev", "--tenant", LEGACY_TENANT], "--source must be staging or production"],
    [["--source", "staging", "--tenant", "global"], "pre-tenant"],
    [["--source", "staging", "--tenant", OTHER_TENANT, "--execute"], "--out"],
  ])("refuses %j", async (args, message) => {
    const { d } = deps(new LegacyLibrary());
    await expect(migrateExportCommand.run(args, d)).rejects.toThrow(message);
  });
});

describe("migrate export: source adapters", () => {
  it("reads a D1 table in pages of SELECTs against the pinned source config", async () => {
    const pages = [Array.from({ length: D1_PAGE_SIZE }, (_, i) => ({ id: i })), [{ id: D1_PAGE_SIZE }]];
    const calls: string[][] = [];
    const read = wranglerD1Reader("production", async (args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify([{ success: true, results: pages[calls.length - 1] }]), stderr: "" };
    });
    expect(await read({ table: "users", orderBy: "id" })).toHaveLength(D1_PAGE_SIZE + 1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(expect.arrayContaining(["--remote", "--env", "production", "--config", D1_SOURCE_CONFIG]));
    expect(calls.map((args) => args[args.indexOf("--command") + 1])).toEqual([
      `SELECT * FROM users ORDER BY id LIMIT ${D1_PAGE_SIZE} OFFSET 0`,
      `SELECT * FROM users ORDER BY id LIMIT ${D1_PAGE_SIZE} OFFSET ${D1_PAGE_SIZE}`,
    ]);
  });

  it.each([
    ["a failed wrangler run", { code: 1, stdout: "", stderr: "auth" }, "wrangler d1 execute failed"],
    ["non-JSON output", { code: 0, stdout: "oops", stderr: "" }, "non-JSON"],
    ["no result set", { code: 0, stdout: JSON.stringify([{ success: false }]), stderr: "" }, "no result set"],
  ])("fails closed on %s", async (_name, result, message) => {
    await expect(wranglerD1Reader("staging", async () => result)({ table: "users", orderBy: "id" })).rejects.toThrow(message);
  });

  it("asks get_by_ids at most 20 ids at a time and fails on a non-200", async () => {
    const bodies: string[][] = [];
    const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { ids } = JSON.parse(String(init!.body)) as { ids: string[] };
      bodies.push(ids);
      return Response.json({ result: ids.map((id) => ({ id, values: [0], namespace: "n" })) });
    });
    const vectors = vectorizeGetByIds({ accountId: "a", apiToken: "t", index: "reading-lite" }, send as typeof fetch);
    const ids = Array.from({ length: 45 }, (_, i) => `x:${i}`);
    expect(await vectors.getByIds(ids)).toHaveLength(45);
    expect(bodies.map((b) => b.length)).toEqual([GET_BY_IDS_LIMIT, GET_BY_IDS_LIMIT, 5]);

    const failing = vectorizeGetByIds({ accountId: "a", apiToken: "t", index: "i" }, (async () => new Response("", { status: 400 })) as typeof fetch);
    await expect(failing.getByIds(["x:1"])).rejects.toThrow("get_by_ids failed: 400");
  });
});
