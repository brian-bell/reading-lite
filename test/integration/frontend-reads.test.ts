import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { FrontendReads, type Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { manifestToIndexItem } from "../../src/modules/stores/list-index";
import type { Manifest } from "../../src/schemas/manifest";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
  testReadingStore,
} from "../helpers/tenant-fixtures";

// The backend's read-only entrypoint for the frontend Worker (ADR 0003, Server
// reads). Reached only through a service binding; these tests construct it
// directly with the test env, as the runtime would for an RPC call.

const workerEnv = env as unknown as Env;
const HOST = "readinglite.ai";

function services() {
  return {
    fetch: globalThis.fetch,
    lookup: async () => [{ address: "93.184.216.34" }],
    // FrontendReads runs the Worker's own app on the real clock, so sessions
    // minted here must be current.
    now: () => new Date().toISOString(),
    newId: () => "rd_FRONT001",
  };
}

async function publicRequest(path: string, headers: Record<string, string>) {
  const app = createApp({ services: services() });
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://${HOST}${path}`, { headers }), workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { res };
}

async function signIn(email: string, redemptionId: string): Promise<string> {
  const origin = `https://${HOST}`;
  const sent: MagicLinkMail[] = [];
  const challengeApp = createApp({
    services: services(),
    auth: {
      sendMagicLink: async (message) => {
        sent.push(message);
      },
    },
  });
  const challenge = await challengeApp.fetch(
    new Request(`${origin}/api/auth/challenge`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    workerEnv,
    createExecutionContext(),
  );
  expect(challenge.status).toBe(200);
  const credential = sent[0]!.verifyUrl.split("#")[1]!;
  const redeemed = await challengeApp.fetch(
    new Request(`${origin}/api/auth/redeem`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ credential, redemption_id: redemptionId }),
    }),
    workerEnv,
    createExecutionContext(),
  );
  expect(redeemed.status).toBe(200);
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(redeemed.headers.get("set-cookie") ?? "");
  expect(match).toBeTruthy();
  return `${SESSION_COOKIE_NAME}=${match![1]}`;
}

function manifest(id: string): Manifest {
  const at = "2026-09-01T12:00:00.000Z";
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "ready",
    title: `Title ${id}`,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 1,
    content_sha256: "0".repeat(64),
    created_at: at,
    updated_at: at,
  } as Manifest;
}

async function seed(tenant: ReturnType<typeof founderTenant>, m: Manifest) {
  const reader = testReadingStore(workerEnv, tenant);
  const keyPrefix = buildKeyPrefix(m.id, m.created_at);
  await reader.writeManifest(keyPrefix, m);
  await reader.writeByIdPointer(m.id, { id: m.id, key_prefix: keyPrefix });
  await reader.appendOrReplaceListIndexItem(manifestToIndexItem(m, keyPrefix));
}

function entrypoint(): FrontendReads {
  return new FrontendReads(createExecutionContext(), workerEnv);
}

afterEach(async () => {
  const list = await workerEnv.READINGS_BUCKET.list();
  for (const obj of list.objects) await workerEnv.READINGS_BUCKET.delete(obj.key);
});

describe("FrontendReads.whoami", () => {
  it("returns 401 without a cookie or with an unknown session", async () => {
    for (const cookie of [null, "", `${SESSION_COOKIE_NAME}=not-a-session`, "theme=dark"]) {
      const result = await entrypoint().whoami({ cookie, host: HOST });
      expect(result, String(cookie)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
  });

  it("authenticates a session cookie with no browser headers and matches the HTTP API", async () => {
    const cookie = await signIn("founder@test.example", "clm_front_whoami");
    const result = await entrypoint().whoami({ cookie, host: HOST });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tenant_id: FOUNDER_TENANT_ID,
      principal: "session",
      email: "founder@test.example",
    });

    const http = await publicRequest("/api/whoami", { cookie, "sec-fetch-site": "same-origin" });
    expect(http.res.status).toBe(200);
    expect(result.body).toEqual(await http.res.json());
  });

  it("returns 401 for a revoked session", async () => {
    const cookie = await signIn("founder@test.example", "clm_front_revoked");
    await workerEnv.CONTROL_PLANE.prepare("UPDATE sessions SET revoked_at_ms = ?").bind(Date.now()).run();
    expect(await entrypoint().whoami({ cookie, host: HOST })).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns only status and body, so no header (Set-Cookie included) crosses the binding", async () => {
    const cookie = await signIn("founder@test.example", "clm_front_shape");
    for (const result of [
      await entrypoint().whoami({ cookie, host: HOST }),
      await entrypoint().whoami({ cookie: null, host: HOST }),
      await entrypoint().reading({ cookie, host: HOST, id: "rd_MISSING01" }),
    ]) {
      expect(Object.keys(result).sort()).toEqual(["body", "status"]);
    }
  });

  it("does not forward bearer credentials or accept other inputs", async () => {
    const reads = entrypoint();
    for (const input of [
      { cookie: "Bearer test-token", host: HOST },
      { cookie: null, host: HOST, authorization: "Bearer test-token" },
    ]) {
      const result = await reads.whoami(input as never);
      expect(result.status).not.toBe(200);
    }
  });

  it.each([
    ["an empty host", ""],
    ["a host with a path", "readinglite.ai/api/readings"],
    ["a host with userinfo", "user@readinglite.ai"],
    ["a URL", "https://readinglite.ai"],
  ])("rejects %s with 400", async (_label, host) => {
    expect(await entrypoint().whoami({ cookie: null, host })).toEqual({
      status: 400,
      body: { error: "invalid request" },
    });
  });

  it("accepts a loopback host with a port", async () => {
    const cookie = await signIn("founder@test.example", "clm_front_loopback");
    const result = await entrypoint().whoami({ cookie, host: "127.0.0.1:5174" });
    expect(result.status).toBe(200);
  });
});

describe("FrontendReads.reading", () => {
  it("returns 401 without a session", async () => {
    await seed(founderTenant(), manifest("rd_FRONTA01"));
    expect(await entrypoint().reading({ cookie: null, host: HOST, id: "rd_FRONTA01" })).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("reads the session tenant's reading and matches the HTTP API", async () => {
    await seed(founderTenant(), manifest("rd_FRONTA01"));
    const cookie = await signIn("founder@test.example", "clm_front_read");
    const result = await entrypoint().reading({ cookie, host: HOST, id: "rd_FRONTA01" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: "rd_FRONTA01", title: "Title rd_FRONTA01" });

    const http = await publicRequest("/api/readings/rd_FRONTA01", { cookie, "sec-fetch-site": "same-origin" });
    expect(result.body).toEqual(await http.res.json());
  });

  it("never reads another tenant's reading", async () => {
    await insertSecondTenant(workerEnv);
    await seed(founderTenant(), manifest("rd_FRONTA01"));
    await seed(otherTenant(), manifest("rd_FRONTB01"));
    const founder = await signIn("founder@test.example", "clm_front_a");
    const other = await signIn("other@test.example", "clm_front_b");

    expect(await entrypoint().reading({ cookie: founder, host: HOST, id: "rd_FRONTB01" })).toEqual({
      status: 404,
      body: { error: "not found" },
    });
    expect(await entrypoint().reading({ cookie: other, host: HOST, id: "rd_FRONTA01" })).toEqual({
      status: 404,
      body: { error: "not found" },
    });
    const own = await entrypoint().reading({ cookie: other, host: HOST, id: "rd_FRONTB01" });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: "rd_FRONTB01" });
  });

  it("returns 412 when the expected tenant is not the acting tenant", async () => {
    await seed(founderTenant(), manifest("rd_FRONTA01"));
    const cookie = await signIn("founder@test.example", "clm_front_412");
    expect(
      await entrypoint().reading({ cookie, host: HOST, id: "rd_FRONTA01", expectedTenant: OTHER_TENANT_ID }),
    ).toEqual({ status: 412, body: { error: "expected tenant mismatch", acting_tenant: FOUNDER_TENANT_ID } });
    const matching = await entrypoint().reading({
      cookie,
      host: HOST,
      id: "rd_FRONTA01",
      expectedTenant: FOUNDER_TENANT_ID,
    });
    expect(matching.status).toBe(200);
  });

  it.each(["../whoami", "rd_FRONTA01/content", "rd_FRONTA01?x=1", "..", ""])(
    "keeps id %j inside reading detail",
    async (id) => {
      await seed(founderTenant(), manifest("rd_FRONTA01"));
      const cookie = await signIn("founder@test.example", "clm_front_ids");
      const result = await entrypoint().reading({ cookie, host: HOST, id });
      expect([400, 404]).toContain(result.status);
      expect(JSON.stringify(result.body)).not.toContain(FOUNDER_TENANT_ID);
    },
  );
});

describe("FrontendReads surface", () => {
  it("exposes only the allowlisted read methods", () => {
    const methods = Object.getOwnPropertyNames(FrontendReads.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(["fetch", "reading", "whoami"]);
  });

  it("answers fetch with 404", async () => {
    const res = entrypoint().fetch();
    expect(res.status).toBe(404);
  });

  it("does not make the public HTTP API trust a cookie without browser same-origin headers", async () => {
    const cookie = await signIn("founder@test.example", "clm_front_public");
    const variants: Record<string, string>[] = [
      { cookie },
      { cookie, "sec-fetch-site": "none" },
      { cookie, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of variants) {
      const { res } = await publicRequest("/api/whoami", headers);
      expect(res.status).toBe(401);
    }
  });
});
