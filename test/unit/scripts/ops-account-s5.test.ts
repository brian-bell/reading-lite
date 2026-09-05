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
  it("reports a listed reading missing its vector even without a ledger row", async () => {
    const r = remoteFixture();
    r.vectors.get.mockResolvedValue([]);
    r.storage.get.mockResolvedValue(
      JSON.stringify({
        version: 1,
        items: [
          {
            id,
            key_prefix: `readings/2026/04/26T200000Z-${id}`,
            url: "https://example.com",
            status: "ready",
            created_at: "2026-04-26T20:00:00.000Z",
          },
        ],
      }),
    );
    const result = await scanResidue(r, tenant);
    expect(
      result.findings.find((f) => f.source === "listed_vectors")?.detail,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, composed: "candidate_absent" }),
      ]),
    );
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

import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";
import { insertMissingLedgerRows } from "../../../src/control-plane/vector-ledger";
import { parseTenantId } from "../../../src/control-plane/ids";
import { corpusSeedVectorLedgerCommand } from "../../../scripts/ops-lib/commands/corpus-seed-vector-ledger";
import * as controlPlane from "../../../scripts/account-lib/control-plane";
import { accountResidueScanCommand } from "../../../scripts/ops-lib/commands/account-residue-scan";
import { accountAuditBareVectorsCommand } from "../../../scripts/ops-lib/commands/account-audit-bare-vectors";

describe("S5 migrated database behavior", () => {
  it("queries every teardown table and retains submitted purge rows without changing history", async () => {
    const { db, sqlite } = openMigratedControlPlane();
    try {
      await insertMissingLedgerRows(db, parseTenantId(tenant)!, [id], 1);
      await db.run(
        "UPDATE vector_ledger SET state='delete_submitted', deleted_at_ms=2, absent_streak=1, last_absent_at_ms=3",
      );
      await db.run(
        "INSERT INTO account_deletions (tenant_id, completed_at_ms, residue, first_completed_at_ms, first_residue, torn_down_at_ms) VALUES (?, 4, 0, 2, 1, 5)",
        tenant,
      );
      const r = remoteFixture();
      r.vectors.list.mockResolvedValue({ vectors: [], isTruncated: false });
      r.vectors.get.mockResolvedValue([]);
      const result = await scanResidue({ ...r, db }, tenant);
      expect(
        result.findings
          .filter((f) => f.source.startsWith("d1."))
          .every((f) => f.state === "clear"),
      ).toBe(true);
      expect(
        result.findings.find((f) => f.source === "vector_ledger"),
      ).toMatchObject({
        state: "residue",
        detail: [
          expect.objectContaining({
            state: "delete_submitted",
            absent_streak: 1,
          }),
        ],
      });
      expect(
        await db.first("SELECT first_residue FROM account_deletions"),
      ).toEqual({ first_residue: 1 });
      const io = { stdout: vi.fn(), stderr: vi.fn() };
      expect(
        await accountResidueScanCommand.run(["--all-deleted"], {
          io,
          connect: () => ({ ...r, db }),
        }),
      ).toBe(1);
      expect(io.stdout.mock.calls[0]?.[0]).toContain(tenant);
    } finally {
      sqlite.close();
    }
  });
  it("the actual operator seeder preserves every field of an in-flight confirmation row", async () => {
    const { db, sqlite } = openMigratedControlPlane();
    const spy = vi
      .spyOn(controlPlane, "controlPlaneDbForBucket")
      .mockReturnValue(db);
    try {
      await insertMissingLedgerRows(db, parseTenantId(tenant)!, [id], 1);
      await db.run(
        "UPDATE vector_ledger SET state='delete_submitted', deleted_at_ms=2, absent_streak=1, last_absent_at_ms=3",
      );
      const before = await db.first("SELECT * FROM vector_ledger");
      const deps = corpusSeedVectorLedgerCommand.defaultDeps({
        stdout: vi.fn(),
        stderr: vi.fn(),
      });
      deps.createStorage = async () => ({
        listObjectKeys: async (prefix) =>
          prefix.endsWith("by-id/") ? [`u/${tenant}/index/by-id/${id}`] : [],
        get: async () => null,
      });
      expect(
        await corpusSeedVectorLedgerCommand.run(
          ["--tenant", tenant, "--execute"],
          deps,
        ),
      ).toBe(0);
      expect(await db.first("SELECT * FROM vector_ledger")).toEqual(before);
    } finally {
      spy.mockRestore();
      sqlite.close();
    }
  });
});
describe("audit command safety and reports", () => {
  it("reports duplicate pairs and executes nothing in plan mode", async () => {
    const r = remoteFixture();
    r.db.first.mockResolvedValue({ status: "active" });
    r.storage.get.mockImplementation(async (key: string) =>
      key.startsWith("u/")
        ? JSON.stringify({
            version: 1,
            items: [
              {
                id,
                key_prefix: `readings/2026/04/26T200000Z-${id}`,
                url: "https://example.com",
                status: "ready",
                created_at: "2026-04-26T20:00:00.000Z",
              },
            ],
          })
        : null,
    );
    r.vectors.list.mockResolvedValue({
      vectors: [{ id }, { id: `${tenant}:${id}` }],
      isTruncated: false,
    });
    r.vectors.get.mockImplementation(async (ids: string[]) =>
      [bare, { ...bare, id: `${tenant}:${id}` }].filter((v) =>
        ids.includes(v.id),
      ),
    );
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(
      await accountAuditBareVectorsCommand.run(["--namespace", tenant], {
        io,
        connect: () => r,
        now: () => 1,
      }),
    ).toBe(1);
    expect(JSON.parse(io.stdout.mock.calls[0]![0]).pairs).toEqual([
      { reading: id, bareNamespace: tenant, protected: false },
    ]);
    expect(JSON.parse(io.stdout.mock.calls[0]![0]).plan[0].action).toBe(
      "delete_verified_duplicate",
    );
    expect(r.vectors.delete).not.toHaveBeenCalled();
    expect(r.db.run).not.toHaveBeenCalled();
  });
  it("blocks all execution on legacy membership or incomplete hydration", async () => {
    for (const mode of ["legacy", "unknown"]) {
      const r = remoteFixture();
      if (mode === "legacy")
        r.storage.listObjects.mockImplementation(async (prefix: string) =>
          prefix === "index/by-id/" ? [{ key: `index/by-id/${id}` }] : [],
        );
      else r.vectors.get.mockResolvedValue([]);
      await expect(
        accountAuditBareVectorsCommand.run(
          [
            "--namespace",
            tenant,
            "--execute",
            "--confirm",
            tenant,
            "--sole-writer",
          ],
          {
            io: { stdout: vi.fn(), stderr: vi.fn() },
            connect: () => r,
            now: () => 1,
          },
        ),
      ).rejects.toThrow("execution refused");
      expect(r.vectors.delete).not.toHaveBeenCalled();
      expect(r.vectors.upsert).not.toHaveBeenCalled();
    }
  });
});

import { accountRemote } from "../../../scripts/account-lib/remote";
describe("REST wire contract", () => {
  const vars = {
    CORPUS_R2_ACCOUNT_ID: "test-account",
    CORPUS_CF_API_TOKEN: "test-token",
  };
  it("rejects non-200, unsuccessful envelopes and malformed success instead of claiming absence", async () => {
    for (const response of [
      new Response("{}", { status: 400 }),
      Response.json({ success: false, result: [] }),
      Response.json({ success: true, result: {} }),
    ]) {
      const send = vi.fn().mockResolvedValue(response);
      await expect(
        accountRemote("reading-lite-staging", send, vars).vectors.get([id]),
      ).rejects.toThrow();
    }
  });
  it("preserves namespace and metadata, and verifies queue name before sending JSON envelopes", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: [bare] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { queue_name: "reading-lite-staging-wipe" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));
    const r = accountRemote("reading-lite-staging", send, vars);
    expect(await r.vectors.get([id])).toEqual([bare]);
    await r.enqueue(tenant, true, "queue-test");
    expect(JSON.parse(send.mock.calls[2]![1].body)).toEqual({
      content_type: "json",
      body: { version: 1, tenantId: tenant, force: true },
    });
    expect(send.mock.calls[0]![0]).toContain(
      "/indexes/reading-lite-staging/get_by_ids",
    );
  });
  it("refuses another environment's queue without sending a message", async () => {
    const send = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: { queue_name: "reading-lite-wipe" },
      }),
    );
    await expect(
      accountRemote("reading-lite-staging", send, vars).enqueue(
        tenant,
        true,
        "wrong",
      ),
    ).rejects.toThrow("queue must");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it("refuses active unlisted readings and pending purge ledger entries before repair", async () => {
  for (const purging of [false, true]) {
    const r = remoteFixture();
    r.db.first.mockResolvedValue({ status: "active" });
    if (purging) {
      r.db.all.mockResolvedValue([{ reading_id: id }]);
      r.storage.get.mockImplementation(async (key: string) =>
        key.startsWith("u/")
          ? JSON.stringify({
              version: 1,
              items: [
                {
                  id,
                  key_prefix: `readings/2026/04/26T200000Z-${id}`,
                  url: "https://example.com",
                  status: "ready",
                  created_at: "2026-04-26T20:00:00.000Z",
                },
              ],
            })
          : null,
      );
    }
    await expect(
      accountAuditBareVectorsCommand.run(
        [
          "--namespace",
          tenant,
          "--execute",
          "--confirm",
          tenant,
          "--sole-writer",
        ],
        {
          io: { stdout: vi.fn(), stderr: vi.fn() },
          connect: () => r,
          now: () => 1,
        },
      ),
    ).rejects.toThrow("unsafe plan");
    expect(r.vectors.upsert).not.toHaveBeenCalled();
    expect(r.vectors.delete).not.toHaveBeenCalled();
    expect(r.db.run).not.toHaveBeenCalled();
  }
});
