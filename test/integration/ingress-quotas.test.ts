import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";
import { mintReadingId, type Services } from "../../src/services";
import { insertQuotaTenant } from "../helpers/tenant-fixtures";
import { FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";

function services(): Services {
  return {
    fetch: (() => {
      throw new Error("no upstream fetch on the intake path");
    }) as unknown as typeof fetch,
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

function installQueueStub(): void {
  (env as unknown as { READING_JOBS: unknown }).READING_JOBS = {
    send: vi.fn(async () => {}),
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(installQueueStub);
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

  it("does not consume monthly quota when returning an existing ready/pending owner", async () => {
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
    await (env as unknown as Env).CONTROL_PLANE.prepare("DELETE FROM tenant_limits WHERE tenant_id = ?")
      .bind(tenantId)
      .run();
    const res = await post(token, "https://quota.test/no-limits");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "usage guard unavailable" });
  });

  it("does not treat founder headroom as a 503", async () => {
    const res = await post("test-token", "https://quota.test/founder-ok");
    expect(res.status).toBe(202);
    expect(FOUNDER_TENANT_ID).toMatch(/^usr_/);
  });
});
