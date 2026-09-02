import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { CSRF_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { mintReadingId, type Services } from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import {
  FOUNDER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
  testReadingStore,
} from "../helpers/tenant-fixtures";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TOKEN = "test-token";
const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function services(now = NOW) {
  return {
    fetch: globalThis.fetch,
    now: () => now,
    newId: () => "rd_AUTH01",
  };
}

async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    authorization?: string;
    cookie?: string;
    origin?: string;
    csrf?: string;
    now?: string;
  } = {},
  workerEnv: Env = env as unknown as Env,
) {
  const sent: MagicLinkMail[] = [];
  const app = createApp({
    services: services(init.now ?? NOW),
    auth: {
      sendMagicLink: async (message) => {
        sent.push(message);
      },
    },
  });
  const ctx = createExecutionContext();
  const headers = new Headers();
  const origin = init.origin ?? "http://t";
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin !== "") headers.set("origin", origin);
  if (init.csrf) headers.set(CSRF_HEADER, init.csrf);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sent };
}

function cookieFrom(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
  return match ? `${SESSION_COOKIE_NAME}=${match[1]}` : null;
}

function credentialFrom(verifyUrl: string): string {
  const hash = verifyUrl.split("#")[1];
  if (!hash) throw new Error("missing fragment");
  return hash;
}

async function redeemSession(redemptionId: string) {
  const challenge = await request("/api/auth/challenge", {
    method: "POST",
    body: { email: "founder@test.example" },
  });
  const credential = credentialFrom(challenge.sent[0]!.verifyUrl);
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
  });
  expect(redeemed.res.status).toBe(200);
  const nextCookie = cookieFrom(redeemed.res);
  expect(nextCookie).toBeTruthy();
  const whoami = await request("/api/whoami", { cookie: nextCookie! });
  const body = (await whoami.res.json()) as { csrf_token: string };
  return { cookie: nextCookie!, csrf: body.csrf_token };
}

const FOUNDER_SETTINGS_DEFAULTS = {
  schema_version: 1,
  notify_immediate: 1,
  digest_cadence: "off",
  time_zone: "UTC",
  digest_hour_local: 9,
  digest_weekday: 1,
} as const;

async function restoreFounderSettings(): Promise<void> {
  const workerEnv = env as unknown as Env;
  const nowMs = Date.now();
  await workerEnv.CONTROL_PLANE.prepare(
    `INSERT INTO user_settings (
       user_id, schema_version, notify_immediate, digest_cadence,
       time_zone, digest_hour_local, digest_weekday, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       notify_immediate = excluded.notify_immediate,
       digest_cadence = excluded.digest_cadence,
       time_zone = excluded.time_zone,
       digest_hour_local = excluded.digest_hour_local,
       digest_weekday = excluded.digest_weekday`,
  )
    .bind(
      FOUNDER_TENANT_ID,
      FOUNDER_SETTINGS_DEFAULTS.schema_version,
      FOUNDER_SETTINGS_DEFAULTS.notify_immediate,
      FOUNDER_SETTINGS_DEFAULTS.digest_cadence,
      FOUNDER_SETTINGS_DEFAULTS.time_zone,
      FOUNDER_SETTINGS_DEFAULTS.digest_hour_local,
      FOUNDER_SETTINGS_DEFAULTS.digest_weekday,
      nowMs,
      nowMs,
    )
    .run();
}

type AnyMock = ReturnType<typeof vi.fn>;
function installVectorizeStub(): void {
  const vectors = new Map<string, { values: number[]; namespace?: string }>();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, {
        values: v.values as number[],
        ...(v.namespace === undefined ? {} : { namespace: v.namespace }),
      });
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  }) as AnyMock;
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: "m" } as VectorizeAsyncMutation;
  }) as AnyMock;
  const query = vi.fn(async (_v: number[], opts: VectorizeQueryOptions) => {
    const k = opts.topK ?? 5;
    const matches = Array.from(vectors.entries())
      .filter(([, v]) => v.namespace === opts.namespace)
      .slice(0, k)
      .map(([id, v]) => ({ id, score: 0.9, values: v.values, metadata: {} }));
    return { count: matches.length, matches } as unknown as VectorizeMatches;
  }) as AnyMock;
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert,
    deleteByIds,
    query,
  } as unknown as VectorizeIndex;
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

function makeStubFetch(opts: { resendStatus?: number; resendBody?: unknown } = {}) {
  const embedding = new Array(1536).fill(0.1);
  const toolInput = {
    title: "Test Article",
    tldr: "A short summary.",
    tags: ["test"],
    keywords: ["test", "article", "integration"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: "summary body",
  };
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.openai.com/v1/embeddings")) {
      return new Response(
        JSON.stringify({ data: [{ embedding }], usage: { prompt_tokens: 10, total_tokens: 10 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.openai.com/v1/responses")) {
      return new Response(
        JSON.stringify({
          id: "resp_01",
          object: "response",
          status: "completed",
          output: [
            {
              id: "msg_01",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: JSON.stringify(toolInput), annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 150,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.resend.com/emails")) {
      const status = opts.resendStatus ?? 200;
      const body = opts.resendBody ?? { id: "resend_01" };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

function resendCalls(fetchFn: ReturnType<typeof makeStubFetch>) {
  return fetchFn.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://api.resend.com/emails");
  });
}

function makeServices(fetchFn: typeof fetch, idCounter = { n: 0 }): Services {
  const start = Date.parse("2026-04-26T20:00:00.000Z");
  return {
    fetch: fetchFn,
    now: () => new Date(start + idCounter.n * 1000).toISOString(),
    newId: () => {
      idCounter.n++;
      return mintReadingId();
    },
  };
}

async function processReady(
  args: ProcessReadingArgs,
  fetchFn: ReturnType<typeof makeStubFetch>,
  tenant = founderTenant(),
): Promise<void> {
  const reader = testReadingStore(env, tenant);
  await reader.writeManifest(args.keyPrefix, {
    id: args.id,
    url: args.url,
    url_hash: args.urlHash,
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: args.createdAt,
    updated_at: args.createdAt,
  });
  await reader.writeByIdPointer(args.id, { id: args.id, key_prefix: args.keyPrefix });
  await processReading(args, env as unknown as Env, makeServices(fetchFn), tenant);
}

function submitArgs(id: string, url: string, extra: Partial<ProcessReadingArgs> = {}): ProcessReadingArgs {
  const createdAt = "2026-04-26T20:00:00.000Z";
  return {
    id,
    url,
    urlHash: "a".repeat(64),
    createdAt,
    keyPrefix: buildKeyPrefix(id, createdAt),
    attemptId: `at_${id}`,
    attemptStartedAt: createdAt,
    trigger: "submit",
    ...extra,
  };
}

describe("GET/POST /api/auth/settings", () => {
  afterEach(restoreFounderSettings);

  it("returns the full settings row to a session and updates notify_immediate only", async () => {
    const session = await redeemSession("clm_settings_get");
    const bearerGet = await request("/api/auth/settings", { authorization: `Bearer ${TOKEN}` });
    expect(bearerGet.res.status).toBe(403);

    const got = await request("/api/auth/settings", { cookie: session.cookie });
    expect(got.res.status).toBe(200);
    const before = (await got.res.json()) as {
      user_id: string;
      schema_version: number;
      notify_immediate: boolean;
      digest_cadence: string;
      time_zone: string;
      digest_hour_local: number;
      digest_weekday: number;
      created_at_ms: number;
      updated_at_ms: number;
    };
    expect(before).toMatchObject({
      user_id: FOUNDER_TENANT_ID,
      schema_version: 1,
      notify_immediate: true,
      digest_cadence: "off",
      time_zone: "UTC",
      digest_hour_local: 9,
      digest_weekday: 1,
    });
    expect(typeof before.created_at_ms).toBe("number");
    expect(typeof before.updated_at_ms).toBe("number");

    const missingCsrf = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      body: { notify_immediate: false },
    });
    expect(missingCsrf.res.status).toBe(403);

    const bearerPost = await request("/api/auth/settings", {
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
      body: { notify_immediate: false },
    });
    expect(bearerPost.res.status).toBe(403);

    const invalid = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { digest_cadence: "daily" },
    });
    expect(invalid.res.status).toBe(400);

    const patched = await request("/api/auth/settings", {
      method: "PATCH",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { notify_immediate: false },
    });
    expect(patched.res.status).toBe(405);

    const updated = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      now: new Date(NOW_MS + 5_000).toISOString(),
      body: { notify_immediate: false, digest_cadence: "weekly" },
    });
    expect(updated.res.status).toBe(200);
    const after = (await updated.res.json()) as typeof before;
    expect(after.notify_immediate).toBe(false);
    expect(after.digest_cadence).toBe("off");
    expect(after.time_zone).toBe("UTC");
    expect(after.updated_at_ms).toBe(NOW_MS + 5_000);

    const workerEnv = env as unknown as Env;
    const current = (
      await workerEnv.CONTROL_PLANE.prepare(
        "SELECT id FROM sessions WHERE revoked_at_ms IS NULL ORDER BY created_at_ms DESC LIMIT 1",
      ).first<{ id: string }>()
    )?.id;
    expect(current).toBeTruthy();
    await workerEnv.CONTROL_PLANE.prepare("UPDATE sessions SET authenticated_at_ms = ? WHERE id = ?")
      .bind(NOW_MS - 11 * 60 * 1000, current)
      .run();

    const stale = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      now: new Date(NOW_MS + 10_000).toISOString(),
      body: { notify_immediate: true },
    });
    expect(stale.res.status).toBe(200);
    expect(((await stale.res.json()) as { notify_immediate: boolean }).notify_immediate).toBe(true);
  });

  it("returns 404 when the settings row is missing", async () => {
    const session = await redeemSession("clm_settings_missing");
    const workerEnv = env as unknown as Env;
    await workerEnv.CONTROL_PLANE.prepare("DELETE FROM user_settings WHERE user_id = ?")
      .bind(FOUNDER_TENANT_ID)
      .run();

    const got = await request("/api/auth/settings", { cookie: session.cookie });
    expect(got.res.status).toBe(404);

    const posted = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { notify_immediate: true },
    });
    expect(posted.res.status).toBe(404);
  });
});

describe("processReading immediate notification recipient", () => {
  beforeEach(() => {
    installVectorizeStub();
  });
  afterEach(async () => {
    await restoreFounderSettings();
    await clearBucket();
    const workerEnv = env as unknown as Env;
    workerEnv.EMAIL_FROM = "reading-lite@test.example";
    workerEnv.APP_ENV = "test";
    delete workerEnv.AUTH_MAIL_ALLOWLIST;
    await workerEnv.CONTROL_PLANE.prepare(
      "UPDATE users SET status = 'active', email_verified_at_ms = COALESCE(email_verified_at_ms, ?) WHERE id = ?",
    )
      .bind(Date.now(), FOUNDER_TENANT_ID)
      .run();
  });

  it("sends to email_display and never EMAIL_TO, using the tenant list index", async () => {
    await insertSecondTenant(env as unknown as Env);
    const otherReader = testReadingStore(env, otherTenant());
    await otherReader.writeListIndex({
      version: 1,
      items: [
        {
          id: "rd_OTHER",
          key_prefix: "readings/x",
          url: "https://example.com/other-secret",
          title: "SECRET-OTHER-TITLE",
          status: "ready",
          created_at: "2026-04-01T00:00:00.000Z",
        },
      ],
    });

    const fetchFn = makeStubFetch();
    await processReady(submitArgs("rd_MAIL01", "https://example.com/notify-me"), fetchFn);

    const calls = resendCalls(fetchFn);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]![1]!.body as string) as { to: string; html: string; text: string };
    expect(body.to).toBe("founder@test.example");
    expect(body.to).not.toBe((env as unknown as Env).EMAIL_TO);
    expect(JSON.stringify(body)).not.toContain("reader@test.example");
    expect(body.html).not.toContain("SECRET-OTHER-TITLE");
    expect(body.text).not.toContain("other@test.example");
    expect(body.html).toContain("https://reading.test.example/readings/rd_MAIL01");
  });

  it("skips import even when email is true", async () => {
    const fetchFn = makeStubFetch();
    await processReady(
      submitArgs("rd_MAIL02", "https://example.com/import-silent", {
        trigger: "import",
        email: true,
        source: { kind: "markdown", markdown: "# Imported\n\nEnough words to summarize locally." },
      }),
      fetchFn,
    );
    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("skips opt-out, email:false, empty FROM, and unverified users without a send_email event", async () => {
    const workerEnv = env as unknown as Env;
    const app = createApp({ services: makeServices(makeStubFetch()) });

    const fetchSilent = makeStubFetch();
    await processReady(
      submitArgs("rd_MAIL03", "https://example.com/item-false", { email: false }),
      fetchSilent,
    );
    expect(resendCalls(fetchSilent)).toHaveLength(0);

    await workerEnv.CONTROL_PLANE.prepare("UPDATE user_settings SET notify_immediate = 0 WHERE user_id = ?")
      .bind(FOUNDER_TENANT_ID)
      .run();
    const fetchOptOut = makeStubFetch();
    await processReady(submitArgs("rd_MAIL04", "https://example.com/opt-out"), fetchOptOut);
    expect(resendCalls(fetchOptOut)).toHaveLength(0);

    await restoreFounderSettings();
    const origFrom = workerEnv.EMAIL_FROM;
    workerEnv.EMAIL_FROM = "";
    const fetchEmptyFrom = makeStubFetch();
    await processReady(submitArgs("rd_MAIL05", "https://example.com/empty-from"), fetchEmptyFrom);
    expect(resendCalls(fetchEmptyFrom)).toHaveLength(0);
    workerEnv.EMAIL_FROM = origFrom;

    await workerEnv.CONTROL_PLANE.prepare("UPDATE users SET email_verified_at_ms = NULL WHERE id = ?")
      .bind(FOUNDER_TENANT_ID)
      .run();
    const fetchUnverified = makeStubFetch();
    await processReady(submitArgs("rd_MAIL06", "https://example.com/unverified"), fetchUnverified);
    expect(resendCalls(fetchUnverified)).toHaveLength(0);

    const diagnostics = await app.request(
      "/api/readings/rd_MAIL04/diagnostics",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      attempts: Array<{ events: Array<{ stage: string }> }>;
    };
    expect(diag.attempts[0]?.events.some((event) => event.stage === "send_email")).toBe(false);
  });

  it("keeps the manifest ready when recipient lookup throws", async () => {
    const workerEnv = env as unknown as Env;
    const origPrepare = workerEnv.CONTROL_PLANE.prepare.bind(workerEnv.CONTROL_PLANE);
    workerEnv.CONTROL_PLANE.prepare = (sql: string) => {
      if (sql.includes("LEFT JOIN user_settings")) {
        throw new Error("d1 lookup failed");
      }
      return origPrepare(sql);
    };

    const fetchFn = makeStubFetch();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processReady(submitArgs("rd_MAIL09", "https://example.com/lookup-throw"), fetchFn);
    } finally {
      workerEnv.CONTROL_PLANE.prepare = origPrepare;
    }

    expect(resendCalls(fetchFn)).toHaveLength(0);
    const app = createApp({ services: makeServices(fetchFn) });
    const get = await app.request(
      "/api/readings/rd_MAIL09",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(((await get.json()) as { status: string }).status).toBe("ready");

    const diagnostics = await app.request(
      "/api/readings/rd_MAIL09/diagnostics",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      manifest: { status: string };
      attempts: Array<{
        status: string;
        events: Array<{ stage: string; status: string; error?: { message: string } }>;
      }>;
    };
    expect(diag.manifest.status).toBe("ready");
    expect(diag.attempts[0]!.status).toBe("succeeded");
    const sendEmail = diag.attempts[0]!.events.find((event) => event.stage === "send_email");
    expect(sendEmail?.status).toBe("failed");
    expect(sendEmail?.error?.message).toContain("d1 lookup failed");
    consoleErr.mockRestore();
  });

  it("redacts recipients in send_email diagnostics and logs when Resend fails", async () => {
    const fetchFn = makeStubFetch({
      resendStatus: 500,
      resendBody: { message: "Invalid to: founder@test.example" },
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await processReady(submitArgs("rd_MAIL07", "https://example.com/resend-redact"), fetchFn);

    const app = createApp({ services: makeServices(fetchFn) });
    const diagnostics = await app.request(
      "/api/readings/rd_MAIL07/diagnostics",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      manifest: { status: string };
      attempts: Array<{
        status: string;
        events: Array<{ stage: string; status: string; error?: { message: string } }>;
      }>;
    };
    expect(diag.manifest.status).toBe("ready");
    const sendEmail = diag.attempts[0]!.events.find((event) => event.stage === "send_email");
    expect(sendEmail?.status).toBe("failed");
    expect(sendEmail?.error?.message).toContain("f***@test.example");
    expect(JSON.stringify(diag)).not.toContain("founder@test.example");
    expect(JSON.stringify(diag)).not.toContain("reader@test.example");

    const logged = consoleErr.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
    expect(logged).toContain("f***@test.example");
    expect(logged).not.toContain("founder@test.example");
    consoleErr.mockRestore();
  });

  it("skips staging allowlist misses", async () => {
    const workerEnv = env as unknown as Env;
    const origAppEnv = workerEnv.APP_ENV;
    const origAllowlist = workerEnv.AUTH_MAIL_ALLOWLIST;
    const origFounder = workerEnv.FOUNDER_EMAIL;
    workerEnv.APP_ENV = "staging";
    workerEnv.AUTH_MAIL_ALLOWLIST = "";
    workerEnv.FOUNDER_EMAIL = "someone-else@example.com";
    try {
      const fetchFn = makeStubFetch();
      await processReady(submitArgs("rd_MAIL08", "https://example.com/allowlist"), fetchFn);
      expect(resendCalls(fetchFn)).toHaveLength(0);
    } finally {
      workerEnv.APP_ENV = origAppEnv;
      if (origAllowlist === undefined) delete workerEnv.AUTH_MAIL_ALLOWLIST;
      else workerEnv.AUTH_MAIL_ALLOWLIST = origAllowlist;
      workerEnv.FOUNDER_EMAIL = origFounder;
    }
  });
});
