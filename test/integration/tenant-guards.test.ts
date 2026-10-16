// The tenant boundary as an attacker meets it, end to end through the Worker:
// another tenant's readings, sessions, tokens, provider keys and account, over
// HTTP, MCP and the FrontendReads entrypoint, plus the cookie guards (Origin,
// session-bound CSRF, no bearer-to-cookie fallback) every browser write passes,
// the Anthropic key routes (mask only, that key's own credential version, the
// selection reset on remove, and a deletion that lands during validation), and
// the digest mail that leaves the system with a tenant's readings in it.
//
// The contract (docs/tenant-isolation-matrix.md): a foreign resource answers
// exactly like an unknown one, collections hold only the caller's records, a
// scope denial precedes any ownership lookup, and nothing the attacker sends
// changes the owner's rows, R2 objects or queue. Each table carries a positive
// control so a route that refused everyone could not pass it.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAccountDeletion } from "../../src/control-plane/account-delete";
import { SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import type { DigestEnvelopeV1 } from "../../src/control-plane/digest-envelope";
import { consumeProcessReadingMessage } from "../../src/control-plane/envelope";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { toTimestamp } from "../../src/control-plane/pg-time";
import { fanOutDueDigests, processDigestJob } from "../../src/digest-pipeline";
import { FrontendReads, type Env } from "../../src/index";
import { processReading } from "../../src/process-reading";
import { createApp } from "../../src/router";
import { CSRF_HEADER, EXPECTED_TENANT_HEADER } from "../../src/schemas/api";
import { mintReadingId } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  OTHER_TOKEN_SECRET,
  PUBLIC_LOOKUP,
  founderTenant,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import {
  clearBucket,
  drainQueue,
  installQueueStub,
  makeServices,
  makeStubFetch,
  queuedEnvelopes,
  queuedJobs,
  TOKEN,
} from "./readings-harness";

const workerEnv = env as unknown as Env;
const FOUNDER_EMAIL = "founder@test.example";
const OTHER_EMAIL = "other@test.example";
const UNKNOWN_ID = "rd_0000000000";
const NEVER_SUBMITTED = "https://example.com/never-submitted";
const DESK_SINCE_EPOCH = "/api/desk?since=1970-01-01T00:00:00.000Z";
const EMPTY_DESK = {
  on_desk: [], needs_you: [], needs_you_total: 0, processing: [], processing_total: 0, ready_since: [], ready_since_total: 0,
};

beforeEach(() => {
  installQueueStub();
});
afterEach(clearBucket);

type App = ReturnType<typeof createApp>;

async function bearer(app: App, token: string, path: string, init: { method?: string; json?: unknown } = {}) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    }),
    workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

async function callTool(app: App, token: string, name: string, args: Record<string, unknown>) {
  const res = await bearer(app, token, "/mcp", {
    method: "POST",
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const { result } = (await res.json()) as { result: ToolResult };
  return { result, payload: JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown> };
}

// A browser-shaped request on the real clock: FrontendReads authenticates on
// the real clock, so the sessions minted here must be current.
type CallInit = {
  method?: string;
  body?: unknown;
  authorization?: string;
  cookie?: string;
  // Defaults to the same origin; "" sends none.
  origin?: string;
  secFetchSite?: string;
  csrf?: string;
  expectedTenant?: string;
  fetch?: typeof fetch;
  env?: Env;
};

async function call(path: string, init: CallInit = {}) {
  const sent: MagicLinkMail[] = [];
  const app = createApp({
    services: {
      fetch: init.fetch ?? globalThis.fetch,
      lookup: PUBLIC_LOOKUP,
      now: () => new Date().toISOString(),
      newId: mintReadingId,
    },
    auth: {
      sendMagicLink: async (message) => {
        sent.push(message);
      },
      sendSecurityMail: async () => {},
    },
  });
  const headers = new Headers();
  if (init.origin !== "") headers.set("origin", init.origin ?? "http://t");
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.secFetchSite) headers.set("sec-fetch-site", init.secFetchSite);
  if (init.csrf) headers.set(CSRF_HEADER, init.csrf);
  if (init.expectedTenant !== undefined) headers.set(EXPECTED_TENANT_HEADER, init.expectedTenant);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    init.env ?? workerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sent };
}

const credentialFrom = (mail: MagicLinkMail | undefined) => mail!.verifyUrl.split("#")[1]!;

async function signIn(email: string, redemptionId: string) {
  const challenge = await call("/api/auth/challenge", { method: "POST", body: { email } });
  const redeemed = await call("/api/auth/redeem", {
    method: "POST",
    body: { credential: credentialFrom(challenge.sent[0]), redemption_id: redemptionId },
  });
  expect(redeemed.res.status, `sign in ${email}`).toBe(200);
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(redeemed.res.headers.get("set-cookie") ?? "");
  const cookie = `${SESSION_COOKIE_NAME}=${match![1]}`;
  const { csrf_token } = (await (await call("/api/whoami", { cookie })).res.json()) as { csrf_token: string };
  return { cookie, csrf: csrf_token };
}

async function bucketSnapshot() {
  const listed = await env.READINGS_BUCKET.list();
  expect(listed.truncated).toBe(false);
  return Promise.all(listed.objects.map(async ({ key }) => [key, await (await env.READINGS_BUCKET.get(key))!.text()]));
}

const userStatus = async (id: string) =>
  (await testControlPlane(workerEnv).first<{ status: string }>("SELECT status FROM users WHERE id = ?", id))?.status;

describe("tenant guards", () => {
  it("another tenant's readings look unknown and stay untouched over HTTP, MCP and FrontendReads", async () => {
    await insertSecondTenant(workerEnv);
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const url = "https://example.com/tenant-guards-private";
    const submitted = await bearer(app, TOKEN, "/api/readings", { method: "POST", json: { url, email: false } });
    expect(submitted.status).toBe(202);
    const { id } = (await submitted.json()) as { id: string };
    await drainQueue(services);
    const founder = testReadingsFor(founderTenant());
    expect(await founder.hasEmbedding(id)).toBe(true);
    const onDesk = await bearer(app, TOKEN, "/api/desk", { method: "POST", json: { id } });
    expect(await onDesk.json(), "owner's desk").toEqual({ desk: [id] });
    const before = await bucketSnapshot();

    // Reads first, so a mutation that wrongly lands cannot empty a later read row.
    const http = [
      { label: "GET detail", path: `/api/readings/${id}`, unknown: `/api/readings/${UNKNOWN_ID}` },
      { label: "GET content", path: `/api/readings/${id}/content`, unknown: `/api/readings/${UNKNOWN_ID}/content` },
      { label: "GET content/raw", path: `/api/readings/${id}/content/raw`, unknown: `/api/readings/${UNKNOWN_ID}/content/raw` },
      {
        label: "GET diagnostics",
        path: `/api/readings/${id}/diagnostics`,
        unknown: `/api/readings/${UNKNOWN_ID}/diagnostics`,
      },
      {
        label: "GET lookup",
        path: `/api/readings/lookup?url=${encodeURIComponent(url)}`,
        unknown: `/api/readings/lookup?url=${encodeURIComponent(NEVER_SUBMITTED)}`,
      },
      {
        label: "POST reprocess",
        method: "POST",
        path: `/api/readings/${id}/reprocess`,
        unknown: `/api/readings/${UNKNOWN_ID}/reprocess`,
      },
      { label: "DELETE", method: "DELETE", path: `/api/readings/${id}`, unknown: `/api/readings/${UNKNOWN_ID}` },
      { label: "POST desk", method: "POST", path: "/api/desk", json: { id }, unknown: "/api/desk", unknownJson: { id: UNKNOWN_ID } },
      { label: "DELETE desk entry", method: "DELETE", path: `/api/desk/${id}`, unknown: `/api/desk/${UNKNOWN_ID}` },
    ];
    for (const row of http) {
      if (!row.method) {
        const owner = await bearer(app, TOKEN, row.path);
        expect(owner.status, `${row.label} as owner`).toBe(200);
        await owner.text();
      }
      const foreign = await bearer(app, OTHER_TOKEN_SECRET, row.path, { method: row.method, json: row.json });
      const unknown = await bearer(app, OTHER_TOKEN_SECRET, row.unknown, { method: row.method, json: row.unknownJson });
      expect(unknown.status, `${row.label} unknown`).toBe(404);
      expect([foreign.status, await foreign.text()], row.label).toEqual([unknown.status, await unknown.text()]);
    }
    const strangerClear = await bearer(app, OTHER_TOKEN_SECRET, "/api/desk", { method: "DELETE" });
    expect(await strangerClear.json(), "another tenant clears only its own desk").toEqual({ desk: [] });

    for (const path of ["/api/readings", "/api/readings?q=Test%20Article"]) {
      const ids = async (token: string) =>
        ((await (await bearer(app, token, path)).json()) as { readings: { id: string }[] }).readings.map((r) => r.id);
      expect(await ids(TOKEN), `${path} as owner`).toEqual([id]);
      expect(await ids(OTHER_TOKEN_SECRET), path).toEqual([]);
    }
    const graph = async (token: string) => (await bearer(app, token, "/api/readings/relationships")).json();
    expect(((await graph(TOKEN)) as { readings: { id: string }[] }).readings.map((r) => r.id), "relationships as owner").toEqual([id]);
    expect(await graph(OTHER_TOKEN_SECRET), "relationships").toEqual({ readings: [], relationships: [] });
    const deskRead = async (token: string) => (await bearer(app, token, DESK_SINCE_EPOCH)).json();
    expect(((await deskRead(TOKEN)) as { on_desk: { id: string }[] }).on_desk.map((r) => r.id), "desk read as owner").toEqual([id]);
    expect(await deskRead(OTHER_TOKEN_SECRET), "desk read").toEqual(EMPTY_DESK);

    const tools = [
      { name: "get_reading", ownerReads: true },
      { name: "get_reading_content", ownerReads: true },
      { name: "get_diagnostics", ownerReads: true },
      { name: "reprocess_reading", args: { body: { force: true } } },
      { name: "delete_reading" },
    ];
    for (const tool of tools) {
      if (tool.ownerReads) {
        expect((await callTool(app, TOKEN, tool.name, { id })).payload.id, `${tool.name} as owner`).toBe(id);
      }
      const foreign = await callTool(app, OTHER_TOKEN_SECRET, tool.name, { id, ...tool.args });
      const unknown = await callTool(app, OTHER_TOKEN_SECRET, tool.name, { id: UNKNOWN_ID, ...tool.args });
      expect(unknown.payload.http_status, `${tool.name} unknown`).toBe(404);
      expect(foreign.result, tool.name).toEqual(unknown.result);
    }

    // The owner's own read-only token: the scope check answers 403 before any
    // ownership lookup, so a known input and an unknown one are indistinguishable.
    const readOnly = "tenant-guards-read-only";
    const tokenId = `tok_${crypto.randomUUID()}`;
    const secretHmac = await hmacHex(
      await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
      readOnly,
    );
    await testControlPlane(workerEnv).batch([
      {
        sql: `INSERT INTO api_tokens (id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at)
              VALUES (?, ?, 'read-only', 'legacy', ?, 1, ?, ?)`,
        params: [tokenId, FOUNDER_TENANT_ID, secretHmac, toTimestamp(Date.now()), toTimestamp(Date.now() + 60_000)],
      },
      { sql: "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, 'readings:read')", params: [tokenId] },
    ]);
    const denied = [
      { name: "submit_url", known: { url }, unknown: { url: NEVER_SUBMITTED } },
      {
        name: "import_markdown",
        known: { source_url: url, markdown: "# denied" },
        unknown: { source_url: NEVER_SUBMITTED, markdown: "# denied" },
      },
      { name: "reprocess_reading", known: { id, body: { force: true } }, unknown: { id: UNKNOWN_ID, body: { force: true } } },
      { name: "delete_reading", known: { id }, unknown: { id: UNKNOWN_ID } },
    ];
    for (const row of denied) {
      const known = await callTool(app, readOnly, row.name, row.known);
      const unknown = await callTool(app, readOnly, row.name, row.unknown);
      expect(known.payload.http_status, `${row.name} read-only`).toBe(403);
      expect(unknown.result, `${row.name} read-only`).toEqual(known.result);
    }

    const reads = new FrontendReads(createExecutionContext(), workerEnv);
    const host = "readinglite.ai";
    const founderSession = await signIn(FOUNDER_EMAIL, "clm_guards_reads_a");
    const otherSession = await signIn(OTHER_EMAIL, "clm_guards_reads_b");
    expect((await reads.reading({ cookie: founderSession.cookie, host, id })).status, "FrontendReads as owner").toBe(200);
    const foreign = await reads.reading({ cookie: otherSession.cookie, host, id });
    const unknown = await reads.reading({ cookie: otherSession.cookie, host, id: UNKNOWN_ID });
    expect(unknown.status, "FrontendReads unknown").toBe(404);
    expect(foreign, "FrontendReads").toEqual(unknown);
    const ownGraph = await reads.relationships({ cookie: founderSession.cookie, host });
    expect(ownGraph.status, "FrontendReads relationships as owner").toBe(200);
    expect((ownGraph.body as { readings: { id: string }[] }).readings.map((r) => r.id)).toEqual([id]);
    const otherGraph = await reads.relationships({ cookie: otherSession.cookie, host });
    expect(otherGraph.body, "FrontendReads relationships").toEqual({ readings: [], relationships: [] });
    expect((await reads.terms({ cookie: otherSession.cookie, host })).body, "FrontendReads terms").toEqual({
      people: [],
      orgs: [],
      keywords: [],
      hosts: [],
    });
    const since = "1970-01-01T00:00:00.000Z";
    const ownDesk = await reads.desk({ cookie: founderSession.cookie, host, since });
    expect(ownDesk.status, "FrontendReads desk as owner").toBe(200);
    expect((ownDesk.body as { on_desk: { id: string }[] }).on_desk.map((r) => r.id)).toEqual([id]);
    expect((await reads.desk({ cookie: otherSession.cookie, host, since })).body, "FrontendReads desk").toEqual(EMPTY_DESK);

    expect(await bucketSnapshot(), "R2 objects").toEqual(before);
    expect(queuedEnvelopes, "queue").toEqual([]);
    expect((await founder.manifest(id))?.status, "owner's reading").toBe("ready");
    expect(await founder.hasEmbedding(id), "owner's embedding").toBe(true);
    expect(await founder.urlOwnerId(url), "owner's URL claim").toBe(id);
    const detail = (await (await bearer(app, TOKEN, `/api/readings/${id}`)).json()) as { desk_position?: number };
    expect(detail.desk_position, "owner's desk position").toBe(1);
  });

  it("two tenants save the same URL and reach ready without observing each other", async () => {
    await insertSecondTenant(workerEnv);
    const READING_ID = /rd_[0-9A-HJ-NP-Z]{10}/g;
    // The summarizer cites exactly the neighbour ids its prompt carried, so a
    // reading's connections record what the model was shown.
    const fetchFn = makeStubFetch({
      toolInputFromRequest: (requestBody) => {
        const cited = [...new Set(requestBody.match(READING_ID) ?? [])];
        return {
          title: "Test Article",
          tldr: "A short summary.",
          tags: ["test"],
          keywords: ["test", "article", "integration"],
          people: [],
          orgs: [],
          novelty_verdict: cited.length > 0 ? "familiar" : "novel",
          connections: cited.map((id) => ({ id, reason: "covers the same ground" })),
          summary_markdown: "summary body",
        };
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const submit = async (token: string, url: string) => {
      const res = await bearer(app, token, "/api/readings", { method: "POST", json: { url, email: false } });
      expect(res.status, `${token} submits ${url}`).toBe(202);
      return ((await res.json()) as { id: string }).id;
    };

    // Every stub embedding is identical, so the founder's earlier reading is
    // the nearest neighbour of anything that can see it.
    const earlier = await submit(TOKEN, "https://example.com/tenant-guards-earlier");
    await drainQueue(services);
    const shared = "https://example.com/tenant-guards-shared";
    const founderShared = await submit(TOKEN, shared);
    const otherShared = await submit(OTHER_TOKEN_SECRET, shared);
    expect(otherShared).not.toBe(founderShared);

    // Both terminal commits interleave.
    const envelopes = queuedEnvelopes.splice(0);
    queuedJobs.splice(0);
    await Promise.all(
      envelopes.map((body) =>
        consumeProcessReadingMessage(
          { body, ack() {} },
          {
            db: testControlPlane(workerEnv),
            nowMs: Date.now(),
            process: (job, tenant) => processReading(job, workerEnv, services, tenant),
          },
        ),
      ),
    );

    const tenants = [
      {
        label: "founder",
        token: TOKEN,
        readings: testReadingsFor(founderTenant()),
        root: `u/${FOUNDER_TENANT_ID}/`,
        sharedId: founderShared,
        // The in-tenant positive: similarity still flows within a tenant.
        neighbours: [earlier],
      },
      {
        label: "other",
        token: OTHER_TOKEN_SECRET,
        readings: testReadingsFor(otherTenant()),
        root: `u/${OTHER_TENANT_ID}/`,
        sharedId: otherShared,
        neighbours: [],
      },
    ];
    const keys = (await env.READINGS_BUCKET.list()).objects.map((object) => object.key);
    for (const t of tenants) {
      const own = [t.sharedId, ...t.neighbours].sort();
      const detail = (await (await bearer(app, t.token, `/api/readings/${t.sharedId}`)).json()) as {
        status: string;
        connections?: { id: string }[];
        connections_neighbourhood_ids?: string[];
      };
      expect(detail.status, `${t.label} status`).toBe("ready");
      expect(detail.connections_neighbourhood_ids, `${t.label} neighbourhood`).toEqual(t.neighbours);
      expect(detail.connections?.map((c) => c.id), `${t.label} connections`).toEqual(t.neighbours);

      const list = (await (await bearer(app, t.token, "/api/readings")).json()) as { readings: { id: string }[] };
      expect(list.readings.map((r) => r.id).sort(), `${t.label} list`).toEqual(own);
      const similar = await bearer(app, t.token, "/api/readings/similar", {
        method: "POST",
        json: { query_embedding: new Array(1536).fill(0.1), k: 20 },
      });
      const items = ((await similar.json()) as { items: { id: string }[] }).items.map((item) => item.id);
      expect(items.sort(), `${t.label} similar`).toEqual(own);

      expect(await t.readings.urlOwnerId(shared), `${t.label} URL owner`).toBe(t.sharedId);
      expect(await t.readings.hasEmbedding(t.sharedId), `${t.label} embedding`).toBe(true);
      expect(keys.some((key) => key.startsWith(t.root)), `${t.label} R2 objects`).toBe(true);
    }
    expect(keys.filter((key) => !tenants.some((t) => key.startsWith(t.root))), "keys outside a tenant root").toEqual([]);

    // Stronger than connections: only the founder's shared reading's prompt
    // names any reading, so the other tenant's prompt never carried the
    // founder's library even as sub-floor context.
    const prompts = fetchFn.mock.calls
      .filter(([input]) => String(input instanceof Request ? input.url : input).startsWith("https://api.openai.com/v1/responses"))
      .map(([, init]) => String(init?.body ?? ""));
    expect(prompts, "summarize requests").toHaveLength(3);
    expect(prompts.filter((body) => body.match(READING_ID) !== null).length, "prompts naming a reading").toBe(1);
  });

  it("one tenant's credentials cannot list, revoke or delete another tenant's sessions, tokens, provider key or account", async () => {
    await insertSecondTenant(workerEnv);
    const founder = await signIn(FOUNDER_EMAIL, "clm_guards_a");
    const other = await signIn(OTHER_EMAIL, "clm_guards_b");
    const json = async <T>(pending: ReturnType<typeof call>) => (await (await pending).res.json()) as T;

    const otherSessionId = (
      await json<{ sessions: { id: string; current: boolean }[] }>(call("/api/auth/sessions", { cookie: other.cookie }))
    ).sessions.find((s) => s.current)!.id;
    const otherToken = await call("/api/auth/tokens", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { name: "other-ops", scopes: ["readings:read"] },
    });
    expect(otherToken.res.status).toBe(201);
    const otherTokenId = ((await otherToken.res.json()) as { id: string }).id;

    const resources = [
      {
        label: "session",
        path: "/api/auth/sessions",
        key: "sessions",
        table: "sessions",
        id: otherSessionId,
        unknown: "ses_22222222-2222-4222-8222-222222222222",
      },
      {
        label: "token",
        path: "/api/auth/tokens",
        key: "tokens",
        table: "api_tokens",
        id: otherTokenId,
        unknown: "tok_22222222-2222-4222-8222-222222222222",
      },
    ];
    for (const r of resources) {
      const listed = await json<Record<string, { id: string }[]>>(call(r.path, { cookie: founder.cookie }));
      expect(listed[r.key]!.map((row) => row.id), `${r.label} list`).not.toContain(r.id);
      const revoke = (id: string) => call(`${r.path}/${id}`, { method: "DELETE", cookie: founder.cookie, csrf: founder.csrf });
      const foreign = (await revoke(r.id)).res;
      const unknown = (await revoke(r.unknown)).res;
      expect(unknown.status, `${r.label} unknown`).toBe(404);
      expect([foreign.status, await foreign.text()], `${r.label} revoke`).toEqual([unknown.status, await unknown.text()]);
      const row = await testControlPlane(workerEnv).first<{ revoked_at: string | null }>(
        `SELECT revoked_at FROM ${r.table} WHERE id = ?`,
        r.id,
      );
      expect(row?.revoked_at, `${r.label} revoked_at`).toBeNull();
    }

    const change = await call("/api/auth/email-change", {
      method: "POST",
      cookie: founder.cookie,
      csrf: founder.csrf,
      body: { email: "founder-next@test.example" },
    });
    expect(change.res.status).toBe(200);
    const stolen = await call("/api/auth/redeem", {
      method: "POST",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { credential: credentialFrom(change.sent[0]), redemption_id: "clm_guards_steal" },
    });
    expect(stolen.res.status, "redeem another user's email change").toBe(403);
    const emails = await testControlPlane(workerEnv).all<{ id: string; email_canonical: string }>(
      "SELECT id, email_canonical FROM users WHERE id IN (?, ?) ORDER BY email_canonical",
      FOUNDER_TENANT_ID,
      OTHER_TENANT_ID,
    );
    expect(emails, "emails after a stolen redeem").toEqual([
      { id: FOUNDER_TENANT_ID, email_canonical: FOUNDER_EMAIL },
      { id: OTHER_TENANT_ID, email_canonical: OTHER_EMAIL },
    ]);

    const providerEnv = { ...workerEnv, PROVIDER_KEY_SECRET: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" };
    const catalog: typeof fetch = async () =>
      Response.json({ data: [{ id: workerEnv.OPENAI_SUMMARIZATION_MODEL }, { id: "text-embedding-3-small" }] });
    const connected = await call("/api/auth/provider", {
      method: "POST",
      cookie: founder.cookie,
      csrf: founder.csrf,
      body: { api_key: "sk-guards-key-1234" },
      fetch: catalog,
      env: providerEnv,
    });
    expect(connected.res.status).toBe(200);
    for (const [label, session, lastFour] of [["founder", founder, "1234"], ["other", other, undefined]] as const) {
      const settings = await json<{ credential: { last_four: string } | null; anthropic_credential: unknown }>(
        call("/api/auth/provider", { cookie: session.cookie, env: providerEnv }),
      );
      expect(settings.credential?.last_four, `${label} provider key`).toBe(lastFour);
      expect(settings.anthropic_credential, `${label} anthropic key`).toBeNull();
    }

    const pinned = await call("/api/account", {
      method: "DELETE",
      cookie: founder.cookie,
      csrf: founder.csrf,
      expectedTenant: OTHER_TENANT_ID,
      body: { confirm: "delete" },
    });
    expect(pinned.res.status, "account delete pinned to the other tenant").toBe(412);
    expect([await userStatus(FOUNDER_TENANT_ID), await userStatus(OTHER_TENANT_ID)], "after pinned delete").toEqual([
      "active",
      "active",
    ]);

    const revokeAll = await call("/api/auth/sessions/revoke-all", {
      method: "POST",
      cookie: founder.cookie,
      csrf: founder.csrf,
      body: {},
    });
    expect(revokeAll.res.status).toBe(200);
    const whoami = async (init: CallInit) => (await call("/api/whoami", init)).res.status;
    expect(await whoami({ cookie: founder.cookie }), "founder cookie after its revoke-all").toBe(401);
    expect(await whoami({ cookie: other.cookie }), "other cookie after founder revoke-all").toBe(200);
    expect(
      await whoami({ authorization: `Bearer ${OTHER_TOKEN_SECRET}` }),
      "other bearer after founder revoke-all",
    ).toBe(200);

    const founderAgain = await signIn(FOUNDER_EMAIL, "clm_guards_a_again");
    const deleted = await call("/api/account", {
      method: "DELETE",
      cookie: other.cookie,
      csrf: other.csrf,
      body: { confirm: "delete" },
    });
    expect(deleted.res.status).toBe(200);
    expect([await userStatus(FOUNDER_TENANT_ID), await userStatus(OTHER_TENANT_ID)], "after other deletes").toEqual([
      "active",
      "deleting",
    ]);
    expect(await whoami({ cookie: founderAgain.cookie }), "founder cookie after other deletes").toBe(200);
  });

  it("cookie writes need same-origin and a session-bound CSRF token, and a bearer never falls back to a cookie", async () => {
    const session = await signIn(FOUNDER_EMAIL, "clm_guards_csrf");
    // The same user's other live session: CSRF is bound to the session, not the user.
    const sibling = await signIn(FOUNDER_EMAIL, "clm_guards_csrf_sibling");
    expect(sibling.csrf).not.toBe(session.csrf);
    const write = (slug: string): CallInit => ({
      method: "POST",
      cookie: session.cookie,
      body: { url: `https://example.com/guards-${slug}` },
    });

    const refused: [string, string, CallInit, number][] = [
      // A valid CSRF token does not rescue a missing or foreign Origin.
      ["cookie write with no Origin", "/api/readings", { ...write("no-origin"), csrf: session.csrf, origin: "" }, 401],
      [
        "cookie write from a foreign Origin",
        "/api/readings",
        { ...write("cross-origin"), csrf: session.csrf, origin: "https://evil.example" },
        401,
      ],
      ["cookie write without CSRF", "/api/readings", write("no-csrf"), 403],
      ["cookie write with a wrong CSRF", "/api/readings", { ...write("wrong-csrf"), csrf: "0".repeat(64) }, 403],
      ["cookie write with another session's CSRF", "/api/readings", { ...write("sibling-csrf"), csrf: sibling.csrf }, 403],
      ["cookie DELETE without CSRF", `/api/readings/${UNKNOWN_ID}`, { method: "DELETE", cookie: session.cookie }, 403],
      [
        "invalid bearer beside a valid cookie and CSRF",
        "/api/readings",
        { ...write("bad-bearer"), csrf: session.csrf, authorization: "Bearer definitely-wrong" },
        401,
      ],
      ["cookie GET with sec-fetch-site none", "/api/whoami", { cookie: session.cookie, origin: "", secFetchSite: "none" }, 401],
      [
        "cookie GET with sec-fetch-site cross-site",
        "/api/whoami",
        { cookie: session.cookie, origin: "", secFetchSite: "cross-site" },
        401,
      ],
      [
        "MCP from a foreign Origin",
        "/mcp",
        {
          method: "POST",
          authorization: `Bearer ${TOKEN}`,
          origin: "https://attacker.example",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        },
        403,
      ],
      // Account deletion takes a session only.
      ["account delete with a bearer", "/api/account", { method: "DELETE", authorization: `Bearer ${TOKEN}`, body: { confirm: "delete" } }, 403],
    ];
    for (const [label, path, init, status] of refused) {
      expect((await call(path, init)).res.status, label).toBe(status);
    }
    expect(await testReadingsFor(founderTenant()).ids(), "readings after refused writes").toEqual([]);
    expect(queuedEnvelopes, "queue after refused writes").toEqual([]);
    expect(await userStatus(FOUNDER_TENANT_ID), "founder after refused account delete").toBe("active");

    const allowed: [string, string, CallInit, number][] = [
      ["same-origin cookie write with CSRF", "/api/readings", { ...write("cookie-ok"), csrf: session.csrf }, 202],
      [
        "bearer write with no Origin",
        "/api/readings",
        { method: "POST", authorization: `Bearer ${TOKEN}`, origin: "", body: { url: "https://example.com/guards-bearer-ok" } },
        202,
      ],
      ["cookie GET with sec-fetch-site same-origin", "/api/whoami", { cookie: session.cookie, origin: "", secFetchSite: "same-origin" }, 200],
    ];
    for (const [label, path, init, status] of allowed) {
      expect((await call(path, init)).res.status, label).toBe(status);
    }
  });

  // Mail cannot be recalled: a digest built from the wrong tenant's list, or
  // sent to the deployment's EMAIL_TO, leaks titles for good.
  it("sends each tenant's digest only to that tenant, with only its own readings", async () => {
    const NOW_MS = Date.parse("2026-09-02T09:00:00.000Z");
    const IN_WINDOW = "2026-09-02T08:00:00.000Z";
    await insertSecondTenant(workerEnv);
    const queued: DigestEnvelopeV1[] = [];
    workerEnv.DIGEST_JOBS = {
      send: async (msg: DigestEnvelopeV1) => void queued.push(msg),
    } as unknown as Queue<DigestEnvelopeV1>;
    await testControlPlane(env).run("UPDATE user_settings SET digest_cadence = 'daily', time_zone = 'UTC', digest_hour_local = 9");
    const item = (id: string, title: string) => ({
      id,
      key_prefix: `readings/${id}`,
      url: `https://example.com/${id}`,
      title,
      tldr: `${title} tldr`,
      status: "ready" as const,
      created_at: IN_WINDOW,
      updated_at: IN_WINDOW,
    });
    await testReadingsFor(founderTenant()).seedListItems([item("rd_FNDR01", "Founder Only Title")]);
    await testReadingsFor(otherTenant()).seedListItems([item("rd_OTHR01", "Other Only Title")]);

    expect(await fanOutDueDigests(workerEnv, { nowMs: NOW_MS }), "fan-out").toEqual({ enqueued: 2 });
    let sent = 0;
    const resend = vi.fn<typeof fetch>(async () => Response.json({ id: `re_digest_${++sent}` }));
    for (const body of queued) await processDigestJob(body, workerEnv, { nowMs: NOW_MS, fetch: resend });

    const mails = resend.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as { to: string; html: string; text: string });
    expect(mails.map((m) => m.to).sort(), "recipients").toEqual([FOUNDER_EMAIL, OTHER_EMAIL]);
    const rows = [
      [FOUNDER_EMAIL, "rd_FNDR01", "rd_OTHR01"],
      [OTHER_EMAIL, "rd_OTHR01", "rd_FNDR01"],
    ] as const;
    for (const [to, own, foreign] of rows) {
      const mail = JSON.stringify(mails.find((m) => m.to === to));
      expect(mail, `${to} gets its own reading`).toContain(own);
      expect(mail, `${to} never sees the other tenant's`).not.toContain(foreign);
      expect(mail, `${to} never goes to EMAIL_TO`).not.toContain(workerEnv.EMAIL_TO);
    }
  });

  const PROVIDER_SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const ANTHROPIC_URL = `https://api.anthropic.com/v1/models/${workerEnv.ANTHROPIC_MODEL}`;

  it("refuses a bearer and a missing CSRF token on the Anthropic key routes", async () => {
    const session = await signIn(FOUNDER_EMAIL, "clm_guards_anthropic_gate");
    const providerEnv = { ...workerEnv, PROVIDER_KEY_SECRET: PROVIDER_SECRET };
    const key = "sk-ant-guards-refused-4242";
    const fetchImpl: typeof fetch = async () => {
      throw new Error("provider called");
    };
    const refused: Array<[string, CallInit]> = [
      ["POST bearer", { method: "POST", authorization: `Bearer ${TOKEN}`, body: { api_key: key } }],
      ["DELETE bearer", { method: "DELETE", authorization: `Bearer ${TOKEN}` }],
      ["POST without CSRF", { method: "POST", cookie: session.cookie, body: { api_key: key } }],
      ["DELETE without CSRF", { method: "DELETE", cookie: session.cookie }],
      ["POST with a wrong CSRF", { method: "POST", cookie: session.cookie, csrf: "0".repeat(64), body: { api_key: key } }],
    ];
    for (const [label, init] of refused) {
      const { res } = await call("/api/auth/provider/anthropic", { ...init, fetch: fetchImpl, env: providerEnv });
      expect(res.status, label).toBe(403);
      expect(await res.text(), label).toBe(JSON.stringify({ error: "forbidden" }));
    }
    expect(
      await testControlPlane(workerEnv).all(
        "SELECT provider FROM tenant_provider_credentials WHERE tenant_id = ?",
        FOUNDER_TENANT_ID,
      ),
      "stored keys",
    ).toEqual([]);
  });

  it("stores only the Anthropic key's mask, versions that key alone, and hides it from another tenant", async () => {
    await insertSecondTenant(workerEnv);
    const founder = await signIn(FOUNDER_EMAIL, "clm_guards_anthropic_store");
    const other = await signIn(OTHER_EMAIL, "clm_guards_anthropic_other");
    const providerEnv = { ...workerEnv, PROVIDER_KEY_SECRET: PROVIDER_SECRET };
    const openaiKey = "sk-openai-guards-1111";
    const firstKey = "sk-ant-guards-aaaa-2222";
    const rejectedKey = "sk-ant-guards-bbbb-4444";
    const replacementKey = "sk-ant-guards-cccc-3333";
    const secrets = [firstKey, rejectedKey, replacementKey];
    const bodies: string[] = [];
    const logs: string[] = [];
    const note = (...args: any[]) => {
      logs.push(args.map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(" "));
    };
    const spies = [
      vi.spyOn(console, "debug").mockImplementation(note),
      vi.spyOn(console, "error").mockImplementation(note),
      vi.spyOn(console, "info").mockImplementation(note),
      vi.spyOn(console, "log").mockImplementation(note),
      vi.spyOn(console, "warn").mockImplementation(note),
    ];
    let anthropic: { key: string; status: number } = { key: firstKey, status: 200 };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/models") {
        return Response.json({
          data: [{ id: workerEnv.OPENAI_SUMMARIZATION_MODEL }, { id: "text-embedding-3-small" }],
        });
      }
      if (url !== ANTHROPIC_URL) throw new Error(`unexpected provider url ${url}`);
      const headers = new Headers(init?.headers);
      if (headers.get("x-api-key") !== anthropic.key) throw new Error("anthropic request carried the wrong key");
      if (headers.get("anthropic-version") !== "2023-06-01") throw new Error("missing anthropic-version");
      if (headers.get("authorization") !== null) throw new Error("authorization header was sent to Anthropic");
      if (init?.redirect !== "manual" || init.cache !== "no-store") {
        throw new Error("anthropic request was not redirect-manual and uncached");
      }
      if (anthropic.status !== 200) return new Response("nope", { status: anthropic.status });
      return Response.json({ type: "model", id: workerEnv.ANTHROPIC_MODEL });
    };
    const read = async (pending: ReturnType<typeof call>) => {
      const { res } = await pending;
      const text = await res.text();
      bodies.push(text);
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    };
    const versions = () =>
      testControlPlane(workerEnv).all<{ provider: string; credential_version: number; last_four: string }>(
        `SELECT provider, credential_version, last_four
         FROM tenant_provider_credentials WHERE tenant_id = ? ORDER BY provider`,
        FOUNDER_TENANT_ID,
      );
    const operatorCap = (await testControlPlane(workerEnv).first<{ daily_spend_microdollars: number }>(
      "SELECT daily_spend_microdollars FROM tenant_limits WHERE tenant_id = ?",
      FOUNDER_TENANT_ID,
    ))!.daily_spend_microdollars;
    const caps = {
      effort: "high",
      daily_spend_cap_microdollars: null,
      effective_daily_spend_microdollars: operatorCap,
      operator_daily_spend_microdollars: operatorCap,
    };
    try {
      const connect = (path: string, apiKey: string) =>
        read(call(path, {
          method: "POST",
          cookie: founder.cookie,
          csrf: founder.csrf,
          body: { api_key: apiKey },
          fetch: fetchImpl,
          env: providerEnv,
        }));
      const openai = await connect("/api/auth/provider", openaiKey);
      expect(openai.status, "openai connect").toBe(200);
      const before = Date.now();
      const connected = await connect("/api/auth/provider/anthropic", firstKey);
      const after = Date.now();
      expect(connected.status, "anthropic connect").toBe(200);
      const validatedAt = (connected.body.anthropic_credential as { validated_at_ms: number }).validated_at_ms;
      expect(validatedAt).toBeGreaterThanOrEqual(before);
      expect(validatedAt).toBeLessThanOrEqual(after);
      expect(connected.body).toEqual({
        credential: { provider: "openai", last_four: "1111", status: "active", validated_at_ms: expect.any(Number) },
        anthropic_credential: { provider: "anthropic", last_four: "2222", status: "active", validated_at_ms: validatedAt },
        summarization_provider: "openai",
        ...caps,
      });
      expect(await versions(), "versions after connect").toEqual([
        { provider: "anthropic", credential_version: 1, last_four: "2222" },
        { provider: "openai", credential_version: 1, last_four: "1111" },
      ]);

      anthropic = { key: rejectedKey, status: 401 };
      const rejected = await connect("/api/auth/provider/anthropic", rejectedKey);
      expect(rejected.status, "rejected replace").toBe(400);
      expect(rejected.body).toEqual({ error: "invalid key", code: "invalid_key" });
      expect(await versions(), "versions after a rejected replace").toEqual([
        { provider: "anthropic", credential_version: 1, last_four: "2222" },
        { provider: "openai", credential_version: 1, last_four: "1111" },
      ]);

      anthropic = { key: replacementKey, status: 200 };
      const replaced = await connect("/api/auth/provider/anthropic", replacementKey);
      expect(replaced.status, "anthropic replace").toBe(200);
      expect(replaced.body).toMatchObject({
        credential: { last_four: "1111" },
        anthropic_credential: { provider: "anthropic", last_four: "3333", status: "active" },
      });
      expect(await versions(), "replace bumps only the Anthropic credential version").toEqual([
        { provider: "anthropic", credential_version: 2, last_four: "3333" },
        { provider: "openai", credential_version: 1, last_four: "1111" },
      ]);

      const selected = await read(call("/api/auth/provider/preferences", {
        method: "POST",
        cookie: founder.cookie,
        csrf: founder.csrf,
        body: { summarization_provider: "anthropic" },
        env: providerEnv,
      }));
      expect(selected.status, "select anthropic").toBe(200);
      expect(selected.body.summarization_provider).toBe("anthropic");

      const hidden = await read(call("/api/auth/provider", { cookie: other.cookie, env: providerEnv }));
      expect(hidden.status, "other tenant").toBe(200);
      expect(hidden.body).toMatchObject({
        credential: null,
        anthropic_credential: null,
        summarization_provider: "openai",
      });

      const removed = await read(call("/api/auth/provider/anthropic", {
        method: "DELETE",
        cookie: founder.cookie,
        csrf: founder.csrf,
        env: providerEnv,
      }));
      expect(removed.status, "remove").toBe(200);
      expect(removed.body).toMatchObject({
        credential: { provider: "openai", last_four: "1111", status: "active" },
        anthropic_credential: null,
        summarization_provider: "openai",
      });
      expect(await versions(), "anthropic row removed").toEqual([
        { provider: "openai", credential_version: 1, last_four: "1111" },
      ]);

      const again = await read(call("/api/auth/provider/preferences", {
        method: "POST",
        cookie: founder.cookie,
        csrf: founder.csrf,
        body: { summarization_provider: "anthropic" },
        env: providerEnv,
      }));
      expect(again.status, "anthropic without a key").toBe(400);
      expect(again.body).toEqual({ error: "anthropic key required", code: "anthropic_key_required" });

      const leaked = secrets.filter((secret) => bodies.some((body) => body.includes(secret)) || logs.some((line) => line.includes(secret)));
      expect(leaked, "anthropic keys in a response or log").toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("does not store an Anthropic key when account deletion lands during validation", async () => {
    const session = await signIn(FOUNDER_EMAIL, "clm_guards_anthropic_delete");
    const providerEnv = { ...workerEnv, PROVIDER_KEY_SECRET: PROVIDER_SECRET };
    const key = "sk-ant-guards-race-5555";
    const db = testControlPlane(workerEnv);
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) !== ANTHROPIC_URL) throw new Error(`unexpected provider url ${String(input)}`);
      const deleted = await beginAccountDeletion(db, { userId: FOUNDER_TENANT_ID, nowMs: Date.now() });
      if (deleted.kind !== "started") throw new Error(`account deletion ${deleted.kind}`);
      const status = await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", FOUNDER_TENANT_ID);
      if (status?.status !== "deleting") throw new Error(`user status ${status?.status ?? "missing"}`);
      const left = await db.all("SELECT provider FROM tenant_provider_credentials WHERE tenant_id = ?", FOUNDER_TENANT_ID);
      if (left.length !== 0) throw new Error("credentials survived deletion");
      return Response.json({ type: "model", id: workerEnv.ANTHROPIC_MODEL });
    };
    const { res } = await call("/api/auth/provider/anthropic", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { api_key: key },
      fetch: fetchImpl,
      env: providerEnv,
    });
    const text = await res.text();
    expect(text.includes(key), "response body").toBe(false);
    expect(res.status, text).toBe(403);
    expect(JSON.parse(text)).toEqual({ error: "forbidden" });
    expect(await db.first("SELECT status FROM users WHERE id = ?", FOUNDER_TENANT_ID)).toEqual({ status: "deleting" });
    expect(
      await db.all(
        "SELECT provider, last_four FROM tenant_provider_credentials WHERE tenant_id = ?",
        FOUNDER_TENANT_ID,
      ),
      "credential rows",
    ).toEqual([]);
  });
});
