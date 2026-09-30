import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";
import { mintReadingId, type Services } from "../../src/services";
import { insertQuotaTenant, PUBLIC_LOOKUP } from "../helpers/tenant-fixtures";
import { testControlPlane } from "../helpers/control-plane-db";
import { clearBucket, installQueueStub } from "./readings-harness";

function services(): Services {
  return {
    fetch: (() => {
      throw new Error("no upstream fetch on the intake path");
    }) as unknown as typeof fetch,
    lookup: PUBLIC_LOOKUP,
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

beforeEach(() => {
  installQueueStub();
});
afterEach(clearBucket);

function post(token: string, url: string) {
  const app = createApp({ services: services() });
  return app.request(
    "/api/readings",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url, email: false }),
    },
    env,
  );
}

describe("ingress submission quotas", () => {
  it("returns 429 with Retry-After when monthly reading quota is exhausted", async () => {
    const { token } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 1,
    });
    const first = await post(token, "https://quota.test/one");
    expect(first.status).toBe(202);
    const second = await post(token, "https://quota.test/two");
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    const body = (await second.json()) as { error: string; code: string; limit: string; reset_at: string };
    expect(body).toMatchObject({
      error: "monthly reading quota exceeded",
      code: "quota_exhausted",
      limit: "monthly",
    });
    expect(Number.isNaN(Date.parse(body.reset_at))).toBe(false);
  });

  it("does not consume monthly quota when returning an existing pending owner", async () => {
    const { token } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 1,
    });
    const url = "https://quota.test/existing";
    const first = await post(token, url);
    expect(first.status).toBe(202);
    const again = await post(token, url);
    expect(again.status).toBe(200);
    const other = await post(token, "https://quota.test/existing-other");
    expect(other.status).toBe(429);
    const body = (await other.json()) as { limit: string };
    expect(body.limit).toBe("monthly");
  });

  it("returns 429 when request-rate is exhausted without activating a second reading", async () => {
    const { token } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 1,
      monthly_readings: 20,
    });
    const first = await post(token, "https://quota.test/rate-one");
    expect(first.status).toBe(202);
    const second = await post(token, "https://quota.test/rate-two");
    expect(second.status).toBe(429);
    const body = (await second.json()) as { code: string; limit: string };
    expect(body).toMatchObject({ code: "rate_limited", limit: "request_rate" });
  });

  it("fails closed with 429 when tenant_limits is missing", async () => {
    const { token, tenantId } = await insertQuotaTenant(env as unknown as Env, {
      submissions_per_hour: 20,
      monthly_readings: 20,
    });
    await testControlPlane((env as unknown as Env)).run(
      "DELETE FROM tenant_limits WHERE tenant_id = ?",
      tenantId,
    );
    const res = await post(token, "https://quota.test/no-limits");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "usage guard unavailable" });
  });
});
