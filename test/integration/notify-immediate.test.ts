import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { CSRF_HEADER } from "../../src/schemas/api";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { mintReadingId, type Services } from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import {
  FOUNDER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
  PUBLIC_LOOKUP,
  reserveReadingSlot,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { testControlPlane } from "../helpers/control-plane-db";
import { interceptSql } from "../helpers/sql-faults";
import { toTimestamp } from "../../src/control-plane/pg-time";

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
    lookup: PUBLIC_LOOKUP,
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
  notify_immediate: true,
  digest_cadence: "off",
  time_zone: "UTC",
  digest_hour_local: 9,
  digest_weekday: 1,
} as const;

async function restoreFounderSettings(): Promise<void> {
  const workerEnv = env as unknown as Env;
  const now = toTimestamp(Date.now());
  await testControlPlane(workerEnv).run(
    `INSERT INTO user_settings (
       user_id, schema_version, notify_immediate, digest_cadence,
       time_zone, digest_hour_local, digest_weekday, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       notify_immediate = excluded.notify_immediate,
       digest_cadence = excluded.digest_cadence,
       time_zone = excluded.time_zone,
       digest_hour_local = excluded.digest_hour_local,
       digest_weekday = excluded.digest_weekday`,
    FOUNDER_TENANT_ID,
    FOUNDER_SETTINGS_DEFAULTS.schema_version,
    FOUNDER_SETTINGS_DEFAULTS.notify_immediate,
    FOUNDER_SETTINGS_DEFAULTS.digest_cadence,
    FOUNDER_SETTINGS_DEFAULTS.time_zone,
    FOUNDER_SETTINGS_DEFAULTS.digest_hour_local,
    FOUNDER_SETTINGS_DEFAULTS.digest_weekday,
    now,
    now,
  );
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
    lookup: PUBLIC_LOOKUP,
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
  await testReadingsFor(tenant).seed(
    {
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
    },
    { keyPrefix: args.keyPrefix },
  );
  await reserveReadingSlot(env, tenant, args);
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
      body: { notify_immediate: false },
    });
    expect(updated.res.status).toBe(200);
    const after = (await updated.res.json()) as typeof before;
    expect(after.notify_immediate).toBe(false);
    expect(after.digest_cadence).toBe("off");
    expect(after.time_zone).toBe("UTC");
    expect(after.digest_hour_local).toBe(9);
    expect(after.digest_weekday).toBe(1);
    expect(after.updated_at_ms).toBe(NOW_MS + 5_000);

    const workerEnv = env as unknown as Env;
    const current = (
      await testControlPlane(workerEnv).first<{ id: string }>(
        "SELECT id FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
    )?.id;
    expect(current).toBeTruthy();
    await testControlPlane(workerEnv).run(
      "UPDATE sessions SET authenticated_at = ? WHERE id = ?",
      toTimestamp(NOW_MS - 11 * 60 * 1000),
      current,
    );

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
    await testControlPlane(workerEnv).run("DELETE FROM user_settings WHERE user_id = ?", FOUNDER_TENANT_ID);

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

  it("persists digest fields sent with notify_immediate, including cadence off", async () => {
    const session = await redeemSession("clm_settings_digest");

    const weekly = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      now: new Date(NOW_MS + 20_000).toISOString(),
      body: {
        notify_immediate: false,
        digest_cadence: "weekly",
        time_zone: "America/New_York",
        digest_hour_local: 8,
        digest_weekday: 5,
      },
    });
    expect(weekly.res.status).toBe(200);
    expect(await weekly.res.json()).toMatchObject({
      notify_immediate: false,
      digest_cadence: "weekly",
      time_zone: "America/New_York",
      digest_hour_local: 8,
      digest_weekday: 5,
      updated_at_ms: NOW_MS + 20_000,
    });

    const off = await request("/api/auth/settings", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      now: new Date(NOW_MS + 25_000).toISOString(),
      body: {
        notify_immediate: true,
        digest_cadence: "off",
        time_zone: "Europe/London",
        digest_hour_local: 0,
        digest_weekday: 7,
      },
    });
    expect(off.res.status).toBe(200);
    expect(await off.res.json()).toMatchObject({
      notify_immediate: true,
      digest_cadence: "off",
      time_zone: "Europe/London",
      digest_hour_local: 0,
      digest_weekday: 7,
    });

    const got = await request("/api/auth/settings", { cookie: session.cookie });
    expect(got.res.status).toBe(200);
    expect(await got.res.json()).toMatchObject({
      notify_immediate: true,
      digest_cadence: "off",
      time_zone: "Europe/London",
      digest_hour_local: 0,
      digest_weekday: 7,
    });
  });

  it("rejects invalid digest cadence, time zone, hour, and weekday with 400", async () => {
    const session = await redeemSession("clm_settings_digest_invalid");
    const base = { method: "POST" as const, cookie: session.cookie, csrf: session.csrf };

    const monthly = await request("/api/auth/settings", {
      ...base,
      body: { notify_immediate: true, digest_cadence: "monthly" },
    });
    expect(monthly.res.status).toBe(400);

    const tz = await request("/api/auth/settings", {
      ...base,
      body: { notify_immediate: true, time_zone: "Not/A_Zone" },
    });
    expect(tz.res.status).toBe(400);

    const hour = await request("/api/auth/settings", {
      ...base,
      body: { notify_immediate: true, digest_hour_local: 24 },
    });
    expect(hour.res.status).toBe(400);

    const weekday = await request("/api/auth/settings", {
      ...base,
      body: { notify_immediate: true, digest_weekday: 0 },
    });
    expect(weekday.res.status).toBe(400);

    const stillDefault = await request("/api/auth/settings", { cookie: session.cookie });
    expect(await stillDefault.res.json()).toMatchObject({
      digest_cadence: "off",
      time_zone: "UTC",
      digest_hour_local: 9,
      digest_weekday: 1,
    });
  });
});

describe("processReading immediate notification recipient", () => {
  afterEach(async () => {
    await restoreFounderSettings();
    await clearBucket();
    const workerEnv = env as unknown as Env;
    workerEnv.EMAIL_FROM = "reading-lite@test.example";
    workerEnv.APP_ENV = "test";
    delete workerEnv.AUTH_MAIL_ALLOWLIST;
    await testControlPlane(workerEnv).run(
      "UPDATE users SET status = 'active', email_display = 'founder@test.example', email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
      toTimestamp(Date.now()),
      FOUNDER_TENANT_ID,
    );
  });

  it("sends to email_display and never EMAIL_TO, using the tenant list index", async () => {
    await insertSecondTenant(env as unknown as Env);
    await testReadingsFor(otherTenant()).seedListItems([
      {
        id: "rd_OTHER",
        key_prefix: "readings/x",
        url: "https://example.com/other-secret",
        title: "SECRET-OTHER-TITLE",
        status: "ready",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);

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

    await testControlPlane(workerEnv).run(
      "UPDATE user_settings SET notify_immediate = false WHERE user_id = ?",
      FOUNDER_TENANT_ID,
    );
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

    await testControlPlane(workerEnv).run(
      "UPDATE users SET email_verified_at = NULL WHERE id = ?",
      FOUNDER_TENANT_ID,
    );
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
    const lookup = interceptSql(/s\.notify_immediate\s+FROM users u\s+LEFT JOIN user_settings/, () => new Error("recipient lookup failed"));

    const fetchFn = makeStubFetch();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processReady(submitArgs("rd_MAIL09", "https://example.com/lookup-throw"), fetchFn);
    } finally {
      lookup.mockRestore();
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
    expect(sendEmail?.error?.message).toContain("recipient lookup failed");
    consoleErr.mockRestore();
  });

  // Runs one ready reading whose Resend call fails with `resendMessage`, then
  // returns the send_email diagnostics error text and the console.error text
  // (message field of JSON lines, raw text otherwise) for leak assertions.
  async function failedSendEmailText(id: string, url: string, resendMessage: string) {
    const fetchFn = makeStubFetch({ resendStatus: 500, resendBody: { message: resendMessage } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processReady(submitArgs(id, url), fetchFn);
      const app = createApp({ services: makeServices(fetchFn) });
      const diagnostics = await app.request(
        `/api/readings/${id}/diagnostics`,
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
      const sendEmail = diag.attempts[0]!.events.find((event) => event.stage === "send_email");
      const logged = consoleErr.mock.calls.map((call) => {
        const first = call[0];
        if (typeof first === "string") {
          try {
            return String((JSON.parse(first) as { message?: string }).message ?? first);
          } catch {
            return first;
          }
        }
        return String(first);
      }).join("\n");
      return { diag, sendEmail, sendMessage: sendEmail?.error?.message ?? "", logged };
    } finally {
      consoleErr.mockRestore();
    }
  }

  it("redacts recipients in send_email diagnostics and logs when Resend fails", async () => {
    const { diag, sendEmail, sendMessage, logged } = await failedSendEmailText(
      "rd_MAIL07",
      "https://example.com/resend-redact",
      "Invalid to: founder@test.example",
    );
    expect(diag.manifest.status).toBe("ready");
    expect(sendEmail?.status).toBe("failed");
    expect(sendMessage).toContain("f***@test.example");
    expect(JSON.stringify(diag)).not.toContain("founder@test.example");
    expect(JSON.stringify(diag)).not.toContain("reader@test.example");
    expect(JSON.stringify(diag)).not.toContain("reading-lite@test.example");
    expect(logged).toContain("f***@test.example");
    expect(logged).not.toContain("founder@test.example");
    expect(logged).not.toContain("reading-lite@test.example");
  });

  it.each([
    {
      name: "slash, quoted, IDN, and no-dot recipients",
      id: "rd_MAIL10",
      url: "https://example.com/resend-shapes",
      setup: async (workerEnv: Env) => {
        const unusual = "first/last@test.example";
        await testControlPlane(workerEnv).run(
          "UPDATE users SET email_display = ? WHERE id = ?",
          unusual,
          FOUNDER_TENANT_ID,
        );
        const leaked = [unusual, '"Foo Bar"@example.com', "user@exämple.com", "user@localhost", "a @ b"];
        return { leaked, message: `Invalid to: ${leaked.join(" and ")}`, restore: async () => {} };
      },
    },
    {
      name: "EMAIL_FROM",
      id: "rd_MAIL11",
      url: "https://example.com/resend-from",
      setup: async (workerEnv: Env) => {
        const from = "noreply @ reading.test";
        const previous = workerEnv.EMAIL_FROM;
        workerEnv.EMAIL_FROM = from;
        return { leaked: [from], message: `Invalid from: ${from}`, restore: async () => { workerEnv.EMAIL_FROM = previous; } };
      },
    },
  ])("scrubs $name from send_email diagnostics and logs", async ({ id, url, setup }) => {
    const workerEnv = env as unknown as Env;
    const { leaked, message, restore } = await setup(workerEnv);
    try {
      const { sendMessage, logged } = await failedSendEmailText(id, url, message);
      for (const address of leaked) {
        expect(sendMessage).not.toContain(address);
        expect(logged).not.toContain(address);
      }
    } finally {
      await restore();
    }
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
