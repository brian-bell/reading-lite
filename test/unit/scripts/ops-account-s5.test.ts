import { describe, it, expect, vi } from "vitest";
import {
  enumerateNamespace,
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


import { accountRemote } from "../../../scripts/account-lib/remote";
describe("REST wire contract", () => {
  const vars = {
    CORPUS_R2_ACCOUNT_ID: "test-account",
    CORPUS_CF_API_TOKEN: "test-token",
  };
  it.each([
    { override: "", r2: "r2-account", expected: "r2-account" },
    { override: "", r2: "", expected: "cloudflare-account" },
    {
      override: "vector-account",
      r2: "r2-account",
      expected: "vector-account",
    },
  ])(
    "uses the first non-empty account credential: $expected",
    async ({ override, r2, expected }) => {
      const send = vi
        .fn()
        .mockResolvedValue(Response.json({ success: true, result: [] }));
      const remote = accountRemote("reading-lite-staging", send, {
        CORPUS_VECTORIZE_ACCOUNT_ID: override,
        CORPUS_R2_ACCOUNT_ID: r2,
        CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
        CORPUS_CF_API_TOKEN: "",
        CLOUDFLARE_API_TOKEN: "fallback-token",
      });
      await remote.vectors.get([id]);
      expect(send.mock.calls[0]![0]).toContain(`/accounts/${expected}/`);
      expect(send.mock.calls[0]![1].headers.authorization).toBe(
        "Bearer fallback-token",
      );
    },
  );
  it("keeps a non-empty corpus token ahead of the Cloudflare fallback", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, result: [] }));
    await accountRemote("reading-lite-staging", send, {
      ...vars,
      CLOUDFLARE_API_TOKEN: "fallback-token",
    }).vectors.get([id]);
    expect(send.mock.calls[0]![1].headers.authorization).toBe(
      "Bearer test-token",
    );
  });
  it("still refuses credentials when all account or token choices are empty", () => {
    for (const missing of [
      { CORPUS_R2_ACCOUNT_ID: "", CLOUDFLARE_ACCOUNT_ID: "" },
      { CORPUS_CF_API_TOKEN: "", CLOUDFLARE_API_TOKEN: "" },
    ]) {
      const send = vi.fn();
      expect(() =>
        accountRemote("reading-lite-staging", send, { ...vars, ...missing }),
      ).toThrow("require");
      expect(send).not.toHaveBeenCalled();
    }
  });
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

import { accountResidueScanCommand } from "../../../scripts/ops-lib/commands/account-residue-scan";
import { makeR2Client, makeR2RestClient } from "../../../scripts/lib/cf-clients";


describe("S5 real listing adapter failure propagation", () => {
  it.each(["S3", "REST"])("%s malformed second page reports unknown/incomplete and blocks repair", async (provider) => {
    const cfg = { accountId: "test", bucket: "test", accessKeyId: "test", secretAccessKey: "test", apiToken: "test" };
    const send = vi.fn().mockImplementation(async () => {
      const first = send.mock.calls.length % 2 === 1;
      return provider === "S3"
        ? new Response(`<ListBucketResult><IsTruncated>true</IsTruncated>${first ? '<NextContinuationToken>next</NextContinuationToken>' : ''}</ListBucketResult>`)
        : Response.json({ success: true, result: [], result_info: { is_truncated: true, ...(first ? { cursor: "next" } : {}) } });
    });
    const r = { ...remoteFixture(), storage: provider === "S3" ? makeR2Client(cfg, send) : makeR2RestClient(cfg, send) };
    r.storage.get = vi.fn().mockResolvedValue(null);
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await accountResidueScanCommand.run(["--tenant", tenant], { io, connect: () => r })).toBe(1);
    const report = JSON.parse(io.stdout.mock.calls[0]![0]);
    expect(report.incomplete).toBe(true);
    expect(report.findings.find((f: { source: string }) => f.source === "r2").state).toBe("unknown");
  });
});

describe("Vectorize listing counts", () => {
  const vars = { CORPUS_R2_ACCOUNT_ID: "test", CORPUS_CF_API_TOKEN: "test" };
  it.each([undefined, null, -1, 0.5, "1", 2])("rejects invalid or mismatched page count %j before hydration", async (count) => {
    const send = vi.fn().mockResolvedValue(Response.json({ success: true, result: {
      vectors: [{ id }], isTruncated: false, count, totalCount: 1,
    } }));
    const remote = accountRemote("reading-lite-staging", send, vars);
    await expect(enumerateNamespace(remote.vectors, tenant)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("retains per-page totals without equating hydration or changing totals to the snapshot", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: { vectors: [{ id }], count: 1, totalCount: 2, isTruncated: true, nextCursor: "next" } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { vectors: [{ id: "later" }], count: 1, totalCount: 3, isTruncated: false, nextCursor: null } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [bare] }));
    const inventory = await enumerateNamespace(accountRemote("reading-lite-staging", send, vars).vectors, tenant);
    expect(inventory.pageCounts).toEqual([{ count: 1, totalCount: 2 }, { count: 1, totalCount: 3 }]);
    expect(inventory.unknown).toEqual(["later"]);
    expect(inventory.enumerated).toBe(2);
  });
  it("preserves legitimate empty vector snapshots", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ success: true, result: { vectors: [], count: 0, totalCount: 0, isTruncated: false } }));
    await expect(enumerateNamespace(accountRemote("reading-lite-staging", send, vars).vectors, tenant)).resolves.toMatchObject({ enumerated: 0, unknown: [], pageCounts: [{ count: 0, totalCount: 0 }] });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects cyclic vector cursors and unexpected hydration IDs", async () => {
    const c = client();
    c.list.mockResolvedValueOnce({ vectors: [], isTruncated: true, nextCursor: "a" })
      .mockResolvedValueOnce({ vectors: [], isTruncated: true, nextCursor: "b" })
      .mockResolvedValueOnce({ vectors: [], isTruncated: true, nextCursor: "a" });
    await expect(enumerateNamespace(c, tenant)).rejects.toThrow("cursor");
    expect(c.get).not.toHaveBeenCalled();
    c.get.mockResolvedValue([{ ...bare, id: "unexpected" }]);
    await expect(enumerateNamespace(c, tenant)).rejects.toThrow("unexpected vector id");
  });
});
