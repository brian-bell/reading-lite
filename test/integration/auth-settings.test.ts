import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { CSRF_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { insertSecondTenant } from "../helpers/tenant-fixtures";

const NOW = "2026-08-16T12:00:00.000Z";

function services() {
  return {
    fetch: globalThis.fetch,
    lookup: async () => [{ address: "93.184.216.34" }],
    now: () => NOW,
    newId: () => "rd_AUTH01",
  };
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; csrf?: string } = {},
  workerEnv: Env = env as unknown as Env,
) {
  const sent: MagicLinkMail[] = [];
  const app = createApp({
    services: services(),
    auth: { sendMagicLink: async (message) => { sent.push(message); } },
  });
  const ctx = createExecutionContext();
  const headers = new Headers({ origin: "http://t" });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.csrf) headers.set(CSRF_HEADER, init.csrf);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sent };
}

function cookieFrom(res: Response): string {
  const value = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(value);
  if (!match) throw new Error("missing session cookie");
  return `${SESSION_COOKIE_NAME}=${match[1]}`;
}

async function redeem(email: string, redemptionId: string) {
  const challenge = await request("/api/auth/challenge", { method: "POST", body: { email } });
  expect(challenge.sent).toHaveLength(1);
  const credential = challenge.sent[0]!.verifyUrl.split("#")[1]!;
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
  });
  expect(redeemed.res.status).toBe(200);
  const cookie = cookieFrom(redeemed.res);
  const whoami = await request("/api/whoami", { cookie });
  const identity = (await whoami.res.json()) as { csrf_token: string; user_id: string };
  return { cookie, csrf: identity.csrf_token, userId: identity.user_id };
}

describe("auth settings tenant isolation", () => {
  it("returns and mutates only the authenticated session owner's settings", async () => {
    const workerEnv = env as unknown as Env;
    const otherTenant = await insertSecondTenant(workerEnv);
    const owner = await redeem("founder@test.example", "clm_settings_owner");
    const other = await redeem("other@test.example", "clm_settings_other");

    const ownerBefore = await request("/api/auth/settings", { cookie: owner.cookie });
    const otherBefore = await request("/api/auth/settings", { cookie: other.cookie });
    expect(ownerBefore.res.status).toBe(200);
    expect(otherBefore.res.status).toBe(200);
    expect((await ownerBefore.res.json()) as { user_id: string }).toMatchObject({ user_id: owner.userId });
    expect((await otherBefore.res.json()) as { user_id: string }).toMatchObject({ user_id: otherTenant.tenantId });

    const changed = await request("/api/auth/settings", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { notify_immediate: false, digest_cadence: "weekly", time_zone: "America/New_York" },
    });
    expect(changed.res.status).toBe(200);
    expect(await changed.res.json()).toMatchObject({ user_id: owner.userId, notify_immediate: false, digest_cadence: "weekly" });

    const otherAfter = await request("/api/auth/settings", { cookie: other.cookie });
    expect(otherAfter.res.status).toBe(200);
    expect(await otherAfter.res.json()).toMatchObject({
      user_id: otherTenant.tenantId,
      notify_immediate: true,
      digest_cadence: "off",
      time_zone: "UTC",
    });
  });
});
