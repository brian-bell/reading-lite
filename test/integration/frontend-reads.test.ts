import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { FrontendReads, type Env } from "../../src/index";
import { createApp } from "../../src/router";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import type { Manifest } from "../../src/schemas/manifest";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { testControlPlane } from "../helpers/control-plane-db";
import { toTimestamp } from "../../src/control-plane/pg-time";

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
  await testReadingsFor(tenant).seed(m);
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
    await testControlPlane(workerEnv).run("UPDATE sessions SET revoked_at = ?", toTimestamp(Date.now()));
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
      await entrypoint().list({ cookie, host: HOST }),
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

describe("FrontendReads.list", () => {
  function tagged(id: string, createdAt: string, title: string, tags: string[]): Manifest {
    return { ...manifest(id), title, tags, created_at: createdAt, updated_at: createdAt };
  }

  async function seedLibrary() {
    await seed(founderTenant(), tagged("rd_LISTA0001", "2026-09-01T10:00:00.000Z", "Gardens of attention", ["design"]));
    await seed(founderTenant(), tagged("rd_LISTA0002", "2026-09-02T10:00:00.000Z", "Quiet software", ["attention"]));
    await seed(founderTenant(), tagged("rd_LISTA0003", "2026-09-03T10:00:00.000Z", "Slow reading", ["attention"]));
  }

  it("returns 401 without a session", async () => {
    await seedLibrary();
    expect(await entrypoint().list({ cookie: null, host: HOST })).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it.each([
    ["the first page", {}, ""],
    ["a search", { q: "quiet" }, "?q=quiet"],
    ["a tag", { tag: "attention" }, "?tag=attention"],
    ["an offset", { offset: 1 }, "?offset=1"],
    ["everything at once", { q: "slow", tag: "attention", offset: 0 }, "?q=slow&tag=attention&offset=0"],
  ])("matches the HTTP API for %s", async (_label, params, query) => {
    await seedLibrary();
    const cookie = await signIn("founder@test.example", `clm_front_list_${query.length}`);
    const result = await entrypoint().list({ cookie, host: HOST, ...params });
    expect(result.status).toBe(200);

    const http = await publicRequest(`/api/readings${query}`, { cookie, "sec-fetch-site": "same-origin" });
    expect(http.res.status).toBe(200);
    expect(result.body).toEqual(await http.res.json());
  });

  it("forwards q, tag, and offset to the list handler", async () => {
    await seedLibrary();
    const cookie = await signIn("founder@test.example", "clm_front_list_params");
    const ids = async (params: { q?: string; tag?: string; offset?: number }) => {
      const result = await entrypoint().list({ cookie, host: HOST, ...params });
      return (result.body as { readings: { id: string }[] }).readings.map((row) => row.id);
    };
    expect(await ids({})).toEqual(["rd_LISTA0003", "rd_LISTA0002", "rd_LISTA0001"]);
    expect(await ids({ q: "quiet" })).toEqual(["rd_LISTA0002"]);
    expect(await ids({ tag: "attention" })).toEqual(["rd_LISTA0003", "rd_LISTA0002"]);
    expect(await ids({ offset: 2 })).toEqual(["rd_LISTA0001"]);
    expect(await ids({ q: "", tag: "" })).toEqual(["rd_LISTA0003", "rd_LISTA0002", "rd_LISTA0001"]);
  });

  it.each([
    ["a negative offset", { offset: -1 }],
    ["a fractional offset", { offset: 1.5 }],
    ["an offset given as a string", { offset: "20" }],
    ["an oversized search", { q: "x".repeat(2049) }],
    ["an oversized tag", { tag: "x".repeat(2049) }],
    ["a page size", { limit: 100 }],
    ["a bad host", { host: "readinglite.ai/api" }],
  ])("rejects %s with 400", async (_label, extra) => {
    const cookie = await signIn("founder@test.example", "clm_front_list_invalid");
    expect(await entrypoint().list({ cookie, host: HOST, ...extra } as never)).toEqual({
      status: 400,
      body: { error: "invalid request" },
    });
  });

  it("returns 412 when the expected tenant is not the acting tenant", async () => {
    await seedLibrary();
    const cookie = await signIn("founder@test.example", "clm_front_list_412");
    expect(await entrypoint().list({ cookie, host: HOST, expectedTenant: OTHER_TENANT_ID })).toEqual({
      status: 412,
      body: { error: "expected tenant mismatch", acting_tenant: FOUNDER_TENANT_ID },
    });
    const matching = await entrypoint().list({ cookie, host: HOST, expectedTenant: FOUNDER_TENANT_ID });
    expect(matching.status).toBe(200);
  });

  it("never mixes two tenants' concurrent lists", async () => {
    await insertSecondTenant(workerEnv);
    await seed(founderTenant(), manifest("rd_LISTA0001"));
    await seed(founderTenant(), manifest("rd_LISTA0002"));
    await seed(otherTenant(), manifest("rd_LISTB0001"));
    const founder = await signIn("founder@test.example", "clm_front_list_a");
    const other = await signIn("other@test.example", "clm_front_list_b");

    const order = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "founder" : "other"));
    const results = await Promise.all(
      order.map(async (who) => ({
        who,
        result: await entrypoint().list({ cookie: who === "founder" ? founder : other, host: HOST }),
      })),
    );
    for (const { who, result } of results) {
      expect(result.status).toBe(200);
      const ids = (result.body as { readings: { id: string }[] }).readings.map((row) => row.id).sort();
      expect(ids, who).toEqual(who === "founder" ? ["rd_LISTA0001", "rd_LISTA0002"] : ["rd_LISTB0001"]);
    }
  });
});

describe("FrontendReads surface", () => {
  it("exposes only the allowlisted read methods", () => {
    const methods = Object.getOwnPropertyNames(FrontendReads.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(["fetch", "list", "reading", "whoami"]);
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
