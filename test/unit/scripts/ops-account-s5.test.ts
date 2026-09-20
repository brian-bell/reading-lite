import { describe, it, expect, vi } from "vitest";
import {
  enumerateNamespace,
  repairBareVector,
} from "../../../scripts/account-lib/vectors";
const tenant = "usr_11111111-1111-4111-8111-111111111111";
const id = "rd_0123456789";
const bare = {
  id,
  namespace: tenant,
  values: [1, 0],
  metadata: { title: "a" },
};
function client() {
  return {
    list: vi.fn().mockResolvedValue({ vectors: [{ id }], isTruncated: false }),
    get: vi.fn().mockResolvedValue([bare]),
    upsert: vi.fn(),
    delete: vi.fn(),
  };
}
describe("namespace enumeration", () => {
  it("pages the index then retrieves in chunks of at most 20, without ledger discovery", async () => {
    const c = client();
    const ids = Array.from({ length: 41 }, (_, i) => `v${i}`);
    c.list
      .mockResolvedValueOnce({
        vectors: ids.slice(0, 30).map((id) => ({ id })),
        isTruncated: true,
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        vectors: ids.slice(30).map((id) => ({ id })),
        isTruncated: false,
      });
    c.get.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ ...bare, id })),
    );
    expect((await enumerateNamespace(c, tenant)).vectors).toHaveLength(41);
    expect(c.get.mock.calls.every(([ids]) => ids.length <= 20)).toBe(true);
    expect(c.list).toHaveBeenLastCalledWith("next");
  });
  it("reports missing hydration as unknown and excludes global vectors", async () => {
    const c = client();
    c.get.mockResolvedValue([]);
    expect((await enumerateNamespace(c, tenant)).unknown).toEqual([id]);
    c.get.mockResolvedValue([{ ...bare, namespace: undefined }]);
    expect((await enumerateNamespace(c, tenant)).vectors).toEqual([]);
  });
  it("refuses a truncated listing with no advancing cursor", async () => {
    const c = client();
    c.list.mockResolvedValue({ vectors: [], isTruncated: true });
    await expect(enumerateNamespace(c, tenant)).rejects.toThrow("cursor");
  });
});
describe("safe bare repair", () => {
  it("ledgers before upsert and preserves the bare vector until a later verified run", async () => {
    const c = client();
    const ledger = vi.fn();
    expect(
      await repairBareVector(c, tenant, bare, {
        status: "active",
        legacy: false,
        ledger,
      }),
    ).toBe("upsert_submitted");
    expect(ledger).toHaveBeenCalledWith(id);
    expect(ledger.mock.invocationCallOrder[0]).toBeLessThan(
      c.upsert.mock.invocationCallOrder[0]!,
    );
    expect(c.delete).not.toHaveBeenCalled();
  });
  it("only deletes a duplicate when the composed vector preserves the full payload", async () => {
    const c = client();
    c.get.mockResolvedValue([bare, { ...bare, id: `${tenant}:${id}` }]);
    expect(
      await repairBareVector(c, tenant, bare, {
        status: "active",
        legacy: false,
        ledger: vi.fn(),
      }),
    ).toBe("delete_submitted");
    expect(c.delete).toHaveBeenCalledWith([id]);
  });
  it("refuses global, legacy, changed, or conflicting vectors without mutations", async () => {
    for (const mode of ["global", "legacy", "changed", "conflict"]) {
      const c = client();
      c.get.mockResolvedValue(
        mode === "global"
          ? [{ ...bare, namespace: undefined }]
          : mode === "changed"
            ? [{ ...bare, values: [0, 1] }]
            : mode === "conflict"
              ? [bare, { ...bare, id: `${tenant}:${id}`, values: [0, 1] }]
              : [bare],
      );
      await expect(
        repairBareVector(c, tenant, bare, {
          status: "active",
          legacy: mode === "legacy",
          ledger: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(c.delete).not.toHaveBeenCalled();
      expect(c.upsert).not.toHaveBeenCalled();
    }
  });
  it("deleting tenants remove only the namespaced bare vector and never resurrect a composed vector", async () => {
    const c = client();
    expect(
      await repairBareVector(c, tenant, bare, {
        status: "deleting",
        legacy: false,
        ledger: vi.fn(),
      }),
    ).toBe("delete_submitted");
    expect(c.upsert).not.toHaveBeenCalled();
  });
});

import { scanResidue } from "../../../scripts/account-lib/residue";
import { accountWipeCommand } from "../../../scripts/ops-lib/commands/account-wipe";
function remoteFixture() {
  return {
    db: {
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn(),
      batch: vi.fn(),
      transaction: vi.fn(),
    },
    storage: {
      listObjects: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    vectors: client(),
    probe: vi.fn().mockResolvedValue([]),
    enqueue: vi.fn(),
  };
}
describe("residue sources and wipe gates", () => {
  it("reports source failures separately while continuing the other checks", async () => {
    const r = remoteFixture();
    r.storage.listObjects.mockRejectedValue(new Error("offline"));
    r.vectors.list.mockResolvedValue({ vectors: [], isTruncated: false });
    const result = await scanResidue(r, tenant);
    expect(result.findings.find((f) => f.source === "r2")?.state).toBe(
      "unknown",
    );
    expect(
      result.findings.find((f) => f.source === "namespace_probe")?.state,
    ).toBe("clear");
    expect(
      result.findings.find((f) => f.source === "durable_objects")?.state,
    ).toBe("unknown");
  });
  it("preserves first-completion audit history as expected evidence, not current residue", async () => {
    const r = remoteFixture();
    r.vectors.list.mockResolvedValue({ vectors: [], isTruncated: false });
    r.db.first.mockImplementation(async (sql: string) =>
      sql.includes("account_deletions")
        ? { first_completed_at_ms: 42, first_residue: 1, residue: 1 }
        : null,
    );
    const result = await scanResidue(r, tenant);
    expect(
      result.findings.find((f) => f.source === "account_deletions"),
    ).toMatchObject({
      state: "expected",
      detail: expect.objectContaining({ first_completed_at_ms: 42 }),
    });
  });
  // The ready readings come from rows now, not index/list.json. Reading the
  // retired object would have found nothing and reported a false "clear" —
  // and this scan gates account teardown.
  it("reports a ready reading missing its vector", async () => {
    const r = remoteFixture();
    r.vectors.get.mockResolvedValue([]);
    r.db.all.mockImplementation(async (sql: string) =>
      sql.includes("FROM readings") ? [{ id }] : [],
    );
    const result = await scanResidue(r, tenant);
    expect(
      result.findings.find((f) => f.source === "ready_reading_vectors")?.detail,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, composed: "candidate_absent" }),
      ]),
    );
  });

  // The ledger is retired (migration 0003 deliberately does not recreate it),
  // so a scan must not observe a source that would throw and report every
  // tenant as incomplete — which is the gate on teardown.
  it("observes no vector_ledger source at all", async () => {
    const r = remoteFixture();
    r.vectors.list.mockResolvedValue({ vectors: [], isTruncated: false });
    const result = await scanResidue(r, tenant);
    const sources = result.findings.map((f) => f.source);
    expect(sources).not.toContain("vector_ledger");
    expect(sources).not.toContain("ledger_vectors");
    for (const call of r.db.all.mock.calls) {
      expect(String(call[0])).not.toContain("vector_ledger");
    }
  });
  it("plans without enqueue, requires matching confirmation, and rechecks deleting before execute", async () => {
    const r = remoteFixture();
    r.db.first.mockResolvedValue({ status: "deleting" });
    const deps = { io: { stdout: vi.fn(), stderr: vi.fn() }, connect: () => r };
    expect(await accountWipeCommand.run(["--tenant", tenant], deps)).toBe(0);
    expect(r.enqueue).not.toHaveBeenCalled();
    await expect(
      accountWipeCommand.run(["--tenant", tenant, "--execute"], deps),
    ).rejects.toThrow();
    r.db.first
      .mockResolvedValueOnce({ status: "deleting" })
      .mockResolvedValueOnce({ status: "active" });
    await expect(
      accountWipeCommand.run(
        [
          "--tenant",
          tenant,
          "--execute",
          "--confirm",
          tenant,
          "--queue-id",
          "q",
        ],
        deps,
      ),
    ).rejects.toThrow("deleting");
    expect(r.enqueue).not.toHaveBeenCalled();
  });
});
