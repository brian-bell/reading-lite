import { describe, it, expect, vi } from "vitest";
const tenant = "usr_11111111-1111-4111-8111-111111111111";

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
    enqueue: vi.fn(),
  };
}
describe("residue sources and wipe gates", () => {
  it("reports source failures separately while continuing the other checks", async () => {
    const r = remoteFixture();
    r.storage.listObjects.mockRejectedValue(new Error("offline"));
    r.db.all.mockResolvedValue([{ n: 0 }]);
    const result = await scanResidue(r, tenant);
    expect(result.findings.find((f) => f.source === "r2")?.state).toBe(
      "unknown",
    );
    expect(
      result.findings.find((f) => f.source === "pg.users")?.state,
    ).toBe("clear");
    expect(
      result.findings.find((f) => f.source === "durable_objects")?.state,
    ).toBe("unknown");
  });
  it("preserves first-completion audit history as expected evidence, not current residue", async () => {
    const r = remoteFixture();
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
  it("keeps PostgreSQL residue after another source fails, and continues querying", async () => {
    const r = remoteFixture();
    r.db.all.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM readings WHERE")) throw Error("read unavailable");
      if (sql.includes("FROM reading_embeddings WHERE")) return [{ n: 2 }];
      return sql.includes("COUNT(*)") ? [{ n: 0 }] : [];
    });
    const result = await scanResidue(r, tenant);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "pg.readings", state: "unknown" }),
      expect.objectContaining({ source: "pg.reading_embeddings", state: "residue", detail: { count: 2 } }),
      expect.objectContaining({ source: "pg.users", state: "clear" }),
    ]));
    expect(result).toMatchObject({ residue: true, incomplete: true });
    expect(r.storage.get).not.toHaveBeenCalled();
  });
  it.each(["success", "enumeration failure", "invalid audit tenant"])("closes the scan session after %s", async (scenario) => {
    const r = { ...remoteFixture(), closeDb: vi.fn().mockResolvedValue(undefined) };
    if (scenario === "enumeration failure") r.db.all.mockRejectedValue(Error("offline"));
    if (scenario === "invalid audit tenant") r.db.all.mockResolvedValue([{ tenant_id: "invalid" }]);
    const run = accountResidueScanCommand.run(["--all-deleted"], { io: { stdout: vi.fn(), stderr: vi.fn() }, connect: () => r });
    if (scenario === "success") await expect(run).resolves.toBe(0);
    else await expect(run).rejects.toThrow();
    expect(r.closeDb).toHaveBeenCalledOnce();
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
  const stagingQueue = () =>
    Response.json({ success: true, result: { queue_name: "reading-lite-staging-wipe" } });
  it.each([
    { r2: "r2-account", expected: "r2-account" },
    { r2: "", expected: "cloudflare-account" },
  ])(
    "uses the first non-empty account credential: $expected",
    async ({ r2, expected }) => {
      const send = vi.fn().mockImplementation(async () => stagingQueue());
      const remote = accountRemote("reading-lite-staging", send, {
        CORPUS_R2_ACCOUNT_ID: r2,
        CLOUDFLARE_ACCOUNT_ID: "cloudflare-account",
        CORPUS_CF_API_TOKEN: "",
        CLOUDFLARE_API_TOKEN: "fallback-token",
      });
      await remote.enqueue(tenant, true, "queue-test");
      expect(send.mock.calls[0]![0]).toContain(`/accounts/${expected}/`);
      expect(send.mock.calls[0]![1].headers.authorization).toBe(
        "Bearer fallback-token",
      );
    },
  );
  it("keeps a non-empty corpus token ahead of the Cloudflare fallback", async () => {
    const send = vi.fn().mockImplementation(async () => stagingQueue());
    await accountRemote("reading-lite-staging", send, {
      ...vars,
      CLOUDFLARE_API_TOKEN: "fallback-token",
    }).enqueue(tenant, true, "queue-test");
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
  it("rejects non-200, unsuccessful envelopes and malformed success before sending a message", async () => {
    for (const response of [
      new Response("{}", { status: 400 }),
      Response.json({ success: false, result: {} }),
      Response.json({ success: true, result: [] }),
    ]) {
      const send = vi.fn().mockResolvedValue(response);
      await expect(
        accountRemote("reading-lite-staging", send, vars).enqueue(tenant, true, "queue-test"),
      ).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("verifies the queue name before sending the JSON envelope", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(stagingQueue())
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));
    await accountRemote("reading-lite-staging", send, vars).enqueue(tenant, true, "queue-test");
    expect(send.mock.calls[0]![0]).toContain("/queues/queue-test");
    expect(JSON.parse(send.mock.calls[1]![1].body)).toEqual({
      content_type: "json",
      body: { version: 1, tenantId: tenant, force: true },
    });
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
