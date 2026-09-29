import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OperatorStatus } from "../../src/control-plane/operator-status";
import type { Env } from "../../src/index";
import { GLOBAL_USAGE_GUARD_NAME } from "../../src/control-plane/constants";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID, insertSecondTenant } from "../helpers/tenant-fixtures";
import { testControlPlane } from "../helpers/control-plane-db";

function endpoint(bindings = env as unknown as Env) {
  return new OperatorStatus(createExecutionContext(), bindings);
}
describe("operator status entrypoint", () => {
  it("inspects quota and retained spend read-only, including a held reading slot", async () => {
    const ns = (env as unknown as Env).TENANT_USAGE_GUARD!;
    const guard = ns.get(ns.idFromName(FOUNDER_TENANT_ID));
    const reserve = await guard.fetch("https://guard/", { method: "POST", body: JSON.stringify({kind:"reserve_reading",tenantId:FOUNDER_TENANT_ID,opId:"inspection-reading",nowMs:Date.now()}) });
    expect(await reserve.json()).toMatchObject({ok:true});
    const request = () => endpoint().fetch(new Request(`https://operator/status?tenant=${FOUNDER_TENANT_ID}&details=1`));
    const first = await (await request()).json() as any;
    const second = await (await request()).json() as any;
    expect(first.tenantDetails.monthly.count).toBe(1);
    expect(first.tenantDetails.reservations.records).toEqual([expect.objectContaining({key:"op:inspection-reading",status:"held",expired:false})]);
    expect(second.tenantDetails.monthly).toEqual(first.tenantDetails.monthly);
    expect(second.tenantDetails.reservations).toEqual(first.tenantDetails.reservations);
    expect(first.details.spend.complete).toBe(true);
    expect(first.details.leases.complete).toBe(true);
  });
  it("fails details when the tenant guard is unavailable", async () => {
    const response = await endpoint({...env,TENANT_USAGE_GUARD:undefined} as unknown as Env).fetch(new Request(`https://operator/status?tenant=${FOUNDER_TENANT_ID}&details=1`));
    expect(response.status).toBe(503);
  });
  it("returns details only for the selected populated tenant", async () => {
    await insertSecondTenant(env as unknown as Env);
    const ns = (env as unknown as Env).TENANT_USAGE_GUARD!;
    const reserve = async (tenantId: string, opId: string) => {
      const response = await ns.get(ns.idFromName(tenantId)).fetch("https://guard/", {
        method: "POST",
        body: JSON.stringify({ kind: "reserve_reading", tenantId, opId, nowMs: Date.now() }),
      });
      expect(await response.json()).toMatchObject({ ok: true });
    };
    await reserve(FOUNDER_TENANT_ID, "status-a-only");
    await reserve(OTHER_TENANT_ID, "status-b-only");

    const response = await endpoint().fetch(
      new Request(`https://operator/status?tenant=${FOUNDER_TENANT_ID}&details=1`),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.tenantId).toBe(FOUNDER_TENANT_ID);
    expect(body.tenantDetails.reservations.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "op:status-a-only" })]),
    );
    expect(body.tenantDetails.reservations.records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "op:status-b-only" })]),
    );
  });
  it.each(["details=0","details=1&details=1"])("rejects invalid detail query %s",async query=>{
    expect((await endpoint().fetch(new Request(`https://operator/status?${query}`))).status).toBe(400);
  });
  it("reads the deployed guard counters through the named entrypoint", async () => {
    const ns = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
    const stub = ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME));
    const quote = {
      dayKey: new Date().toISOString().slice(0, 10),
      catalogVersion: 1,
      requestFingerprint: "status-fixture",
      maxMicrodollars: 25,
    };
    const call = async (kind: string) =>
      (
        await stub.fetch("https://guard/", {
          method: "POST",
          body: JSON.stringify({
            kind,
            payer: "tenant",
            tenantId: FOUNDER_TENANT_ID,
            opId: "status-op",
            quote,
            nowMs: Date.now(),
          }),
        })
      ).json();
    await call("reserve_spend");
    await call("mark_spend_dispatched");
    const before = await (
      await endpoint().fetch(
        new Request(`https://operator/status?tenant=${FOUNDER_TENANT_ID}`),
      )
    ).json();
    expect(before).toMatchObject({
      globalChargedMicrodollars: 25,
      tenantChargedMicrodollars: 25,
      tenantId: FOUNDER_TENANT_ID,
    });
    const variant = ` ${FOUNDER_TENANT_ID.toUpperCase()} `;
    expect(
      await (
        await endpoint().fetch(
          new Request(
            `https://operator/status?tenant=${encodeURIComponent(variant)}`,
          ),
        )
      ).json(),
    ).toMatchObject({
      tenantId: FOUNDER_TENANT_ID,
      tenantChargedMicrodollars: 25,
    });
    expect(
      await (
        await stub.fetch("https://guard/", {
          method: "POST",
          body: JSON.stringify({ kind: "spend_status", tenantId: variant }),
        })
      ).json(),
    ).toMatchObject({
      tenantId: FOUNDER_TENANT_ID,
      tenantChargedMicrodollars: 25,
    });
    await testControlPlane(env).run(
      "UPDATE system_policy SET paid_work_enabled = false, policy_version = policy_version + 1",
    );
    expect(
      await (
        await endpoint().fetch(
          new Request(`https://operator/status?tenant=${FOUNDER_TENANT_ID}`),
        )
      ).json(),
    ).toMatchObject({ globalChargedMicrodollars: 25 });
    await testControlPlane(env).run(
      "UPDATE system_policy SET paid_work_enabled = true, policy_version = policy_version + 1",
    );
    expect(await call("mark_spend_dispatched")).toMatchObject({
      ok: true,
      fresh: false,
    });
    expect(
      await (
        await endpoint().fetch(new Request("https://operator/status"))
      ).json(),
    ).toMatchObject({ globalChargedMicrodollars: 25 });
  });
  it("does not expose the entrypoint on the public router", async () => {
    const response = await SELF.fetch("https://example.com/status");
    expect(response.status).not.toBe(200);
  });
  it.each([
    ["POST", "/status", 405],
    ["GET", "/reserve_spend", 404],
    ["GET", "/status?tenant=bad", 400],
    ["GET", "/status?kind=release_spend", 400],
    [
      "GET",
      `/status?tenant=${FOUNDER_TENANT_ID}&tenant=${FOUNDER_TENANT_ID}`,
      400,
    ],
  ])("rejects %s %s", async (method, path, status) => {
    expect(
      (
        await endpoint().fetch(
          new Request(`https://operator${path}`, { method }),
        )
      ).status,
    ).toBe(status);
  });
  it("returns unavailable when the guard binding is absent", async () => {
    const response = await endpoint({
      ...env,
      GLOBAL_USAGE_GUARD: undefined,
    } as unknown as Env).fetch(new Request("https://operator/status"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "accounting_unavailable" });
  });
});
