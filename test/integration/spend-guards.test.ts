// Paid-work guards against the real usage guards and PostgreSQL: spend
// admission under the tenant, reader and global caps; the OperatorSpend
// entrypoint operator commands bill through; processReading's choice of key
// and its stops when a lease or guard is gone; and intake refusing work it
// cannot admit. The Node-pool paid dispatch test pins createPaidFetch's own
// refusals against a fake authority; these rows add the ledger, the tenant and
// the lease the fake cannot have.
//
// Rows that need their own counters mint a tenant. The global day counter is
// shared within an `it`, so charges are read as deltas.

import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_USAGE_GUARD_NAME } from "../../src/control-plane/constants";
import { parseProviderKeySecret } from "../../src/control-plane/crypto";
import { parseTenantId, type TenantContext } from "../../src/control-plane/ids";
import { OperatorSpend } from "../../src/control-plane/operator-spend";
import { createPaidFetch, spendRpcFor, type SpendRpc } from "../../src/control-plane/paid-dispatch";
import { DeferPaidWorkError } from "../../src/control-plane/processing-leases";
import {
  deleteProviderCredential,
  deleteProviderCredentials,
  markProviderCredentialInvalid,
  readProviderCredential,
  upsertProviderCredential,
} from "../../src/control-plane/provider-credentials";
import { updateProviderPreferences } from "../../src/control-plane/provider-settings";
import type { Env } from "../../src/index";
import { actualPaidCost, quotePaidRequest } from "../../src/modules/paid-pricing";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { createApp } from "../../src/router";
import type { Manifest } from "../../src/schemas/manifest";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";
import { testReadingsFor } from "../helpers/test-readings";
import { FOUNDER_TENANT_ID, insertQuotaTenant, PUBLIC_LOOKUP, reserveReadingSlot } from "../helpers/tenant-fixtures";
import { clearBucket, installQueueStub } from "./readings-harness";

const EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_INIT = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "text-embedding-3-small", input: "Hello" }),
};
const USAGE = { data: [], usage: { prompt_tokens: 1, total_tokens: 1 } };
const CREATED_AT = "2026-09-28T00:00:00.000Z";
const SERVICES_NOW = "2026-09-28T00:00:01.000Z";
const KEY_SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const DEPLOYMENT_KEY = "sk-deployment-do-not-send";
const NO_RETRY_DELAY = { RETRY_MAX_ATTEMPTS: "2", RETRY_BASE_DELAY_MS: "0", RETRY_MAX_DELAY_MS: "0" };

afterEach(async () => {
  vi.restoreAllMocks();
  await clearBucket();
});

const sql = (query: string, ...params: unknown[]) => testControlPlane(env).run(query, ...params);
const tenantOf = (tenantId: string): TenantContext => ({ tenantId: parseTenantId(tenantId)! });
const newTenant = () => insertQuotaTenant(env as unknown as Env, { submissions_per_hour: 100, monthly_readings: 100 });

async function charged(tenantId: string): Promise<{ global: number; tenant: number }> {
  const ns = (env as unknown as Env).GLOBAL_USAGE_GUARD!;
  const res = await ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME)).fetch("https://guard/", {
    method: "POST",
    body: JSON.stringify({ kind: "spend_status", tenantId }),
  });
  const status = (await res.json()) as { globalChargedMicrodollars: number; tenantChargedMicrodollars: number };
  return { global: status.globalChargedMicrodollars, tenant: status.tenantChargedMicrodollars };
}

/** Wraps a real guard RPC so a row can see, and interfere with, each spend verb. */
function paidEmbed(tenantId: string, provider: typeof fetch, kinds: string[] = [], wrap?: (rpc: SpendRpc) => SpendRpc) {
  const real = spendRpcFor(env as unknown as Env);
  const rpc = wrap ? wrap(real) : real;
  return createPaidFetch({
    tenantId,
    attemptId: crypto.randomUUID(),
    stage: "embed_source",
    fetch: provider,
    now: Date.now,
    rpc: async (body) => {
      kinds.push(String(body.kind));
      return rpc(body);
    },
  })(EMBED_URL, EMBED_INIT);
}

function embeddingResponse(): Response {
  return Response.json({ data: [{ embedding: new Array(1536).fill(0.1) }], usage: { prompt_tokens: 10, total_tokens: 10 } });
}

const READING = {
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

function summaryResponse(): Response {
  return Response.json({
    id: "resp_01",
    object: "response",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(READING) }] }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    },
  });
}

function anthropicSummaryResponse(): Response {
  return Response.json({
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_01", name: "emit_reading", input: READING }],
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
}

/** A pending Markdown reading with its slot reserved, as intake leaves it; no URL extract. */
async function seedPending(tenant: TenantContext, url: string): Promise<ProcessReadingArgs> {
  const id = mintReadingId();
  const attemptId = `at_${id}`;
  const keyPrefix = buildKeyPrefix(id, CREATED_AT);
  const urlHash = await sha256Hex(url);
  const manifest: Manifest = {
    id,
    url,
    url_hash: urlHash,
    source_type: "markdown",
    status: "pending",
    active_attempt: { id: attemptId, trigger: "submit", status: "running", stage: "queued", started_at: CREATED_AT },
    content_type: "text/markdown",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
  await testReadingsFor(tenant).seed(manifest, { keyPrefix });
  const job: ProcessReadingArgs = {
    id,
    url,
    urlHash,
    createdAt: CREATED_AT,
    keyPrefix,
    attemptId,
    attemptStartedAt: CREATED_AT,
    trigger: "submit",
    email: false,
    source: {
      kind: "markdown",
      markdown: "# Test Article\n\nA paragraph long enough to embed and summarize without fetching a URL.",
      title: "Test Article",
    },
  };
  await reserveReadingSlot(env, tenant, job);
  return job;
}

function services(fetchFn: typeof fetch): Services {
  return { fetch: fetchFn, lookup: PUBLIC_LOOKUP, now: () => SERVICES_NOW, newId: mintReadingId };
}

const isEmbed = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input).startsWith(EMBED_URL);
const callsTo = (fetchFn: ReturnType<typeof vi.fn<typeof fetch>>, embed: boolean) =>
  fetchFn.mock.calls.filter(([input]) => isEmbed(input) === embed).length;

async function storeKey(tenantId: string, plaintext: string, provider: "openai" | "anthropic" = "openai"): Promise<void> {
  await upsertProviderCredential(testControlPlane(env), {
    tenantId,
    plaintext,
    root: { secret: parseProviderKeySecret(KEY_SECRET), version: 1 },
    nowMs: Date.parse(CREATED_AT),
    validatedAtMs: Date.parse(CREATED_AT),
    provider,
  });
}

function keysOn(): Env {
  return {
    ...env,
    ...NO_RETRY_DELAY,
    TENANT_PROVIDER_KEYS: "1",
    PROVIDER_KEY_SECRET: KEY_SECRET,
    OPENAI_API_KEY: DEPLOYMENT_KEY,
    ANTHROPIC_API_KEY: "sk-anthropic-deployment",
  } as Env;
}

/** Swaps a usage guard binding for one whose stub runs `handler` around each RPC. */
function interceptGuard(
  binding: "GLOBAL_USAGE_GUARD" | "TENANT_USAGE_GUARD",
  handler: (body: Record<string, unknown>, next: () => Promise<Response>) => Promise<Response>,
): () => void {
  const bindings = env as unknown as Record<string, DurableObjectNamespace | undefined>;
  const original = bindings[binding]!;
  bindings[binding] = {
    idFromName: original.idFromName.bind(original),
    get: (id: DurableObjectId) => {
      const stub = original.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          handler(JSON.parse(typeof init?.body === "string" ? init.body : "{}"), () => stub.fetch(input as never, init)),
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
  return () => {
    bindings[binding] = original;
  };
}

describe("spend guards", () => {
  it("paid work is admitted only under the tenant and global caps, and a lost dispatch keeps its charge", async () => {
    const quote = (await quotePaidRequest(EMBED_URL, EMBED_INIT))!;
    const max = quote.maxMicrodollars;
    const actual = actualPaidCost(quote, USAGE)!;
    const ADMITTED = ["reserve_spend", "mark_spend_dispatched", "settle_spend"];
    const rows: Array<{
      name: string;
      arrange?: (tenantId: string) => Promise<unknown>;
      wrap?: (rpc: SpendRpc) => SpendRpc;
      kinds: string[];
      // Absent: admitted. Otherwise the SpendAdmissionError reason.
      denied?: string;
      charge: "none" | "max" | "actual";
    }> = [
      { name: "admitted under every cap", kinds: ADMITTED, charge: "actual" },
      {
        name: "tenant cap one below the quote",
        arrange: (tenantId) => sql("UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?", max - 1, tenantId),
        kinds: ["reserve_spend"], denied: "daily_spend", charge: "none",
      },
      {
        name: "reader's own cap below the operator default",
        arrange: (tenantId) => sql("UPDATE user_settings SET daily_spend_cap_microdollars = ? WHERE user_id = ?", max - 1, tenantId),
        kinds: ["reserve_spend"], denied: "daily_spend", charge: "none",
      },
      {
        // NULL is "no budget chosen", which blocks paid work rather than meaning unlimited.
        name: "global budget unset",
        arrange: () => sql("UPDATE system_policy SET daily_spend_microdollars = NULL WHERE id = 1"),
        kinds: ["reserve_spend"], denied: "missing_limits", charge: "none",
      },
      {
        name: "paid work switched off",
        arrange: () => sql("UPDATE system_policy SET paid_work_enabled = false WHERE id = 1"),
        kinds: ["reserve_spend"], denied: "paid_work_disabled", charge: "none",
      },
      {
        name: "quote priced from another catalog version",
        arrange: () => sql("UPDATE system_policy SET catalog_version = 999 WHERE id = 1"),
        kinds: ["reserve_spend"], denied: "catalog_version", charge: "none",
      },
      {
        // A timeout does not prove the request never reached the provider, so
        // its maximum stays charged and fills this tenant's cap.
        name: "an earlier dispatch timed out at the tenant's cap",
        arrange: async (tenantId) => {
          await sql("UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?", max, tenantId);
          await expect(paidEmbed(tenantId, async () => { throw new Error("timeout"); }), "timed-out dispatch").rejects.toThrow("timeout");
        },
        kinds: ["reserve_spend"], denied: "daily_spend", charge: "none",
      },
      {
        // The mark committed but its answer was lost: the request may count as
        // dispatched, so the release cannot refund it.
        name: "the dispatch mark's response is lost",
        wrap: (rpc) => async (body) => {
          const decision = await rpc(body);
          if (body.kind === "mark_spend_dispatched") throw new Error("dispatch recorded, response lost");
          return decision;
        },
        kinds: ["reserve_spend", "mark_spend_dispatched", "release_spend"], denied: "unavailable", charge: "max",
      },
      {
        name: "the kill switch flips between reserve and dispatch",
        wrap: (rpc) => async (body) => {
          if (body.kind === "mark_spend_dispatched") await sql("UPDATE system_policy SET paid_work_enabled = false WHERE id = 1");
          return rpc(body);
        },
        kinds: ["reserve_spend", "mark_spend_dispatched", "release_spend"], denied: "paid_work_disabled", charge: "none",
      },
      {
        // Both tenants are capped at one quote, and the other has spent its
        // own: counters are per tenant, so that denies only the other.
        name: "another tenant has spent the same cap",
        arrange: async (tenantId) => {
          const other = (await newTenant()).tenantId;
          for (const id of [tenantId, other]) {
            await sql("UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?", max, id);
          }
          // No usage in the response holds the maximum.
          expect((await paidEmbed(other, async () => Response.json({ data: [] }))).status, "other tenant spends its cap").toBe(200);
          await expect(paidEmbed(other, async () => Response.json(USAGE)), "other tenant at its cap").rejects.toMatchObject({
            reason: "daily_spend",
          });
        },
        kinds: ADMITTED, charge: "actual",
      },
    ];

    for (const row of rows) {
      const { tenantId } = await newTenant();
      try {
        await row.arrange?.(tenantId);
        const before = await charged(tenantId);
        const provider = vi.fn<typeof fetch>(async () => Response.json(USAGE));
        const kinds: string[] = [];
        const outcome = await paidEmbed(tenantId, provider, kinds, row.wrap).catch((error: unknown) => error);
        if (row.denied) {
          expect(outcome, row.name).toBeInstanceOf(DeferPaidWorkError);
          expect(outcome, row.name).toMatchObject({ name: "SpendAdmissionError", reason: row.denied });
          expect(provider, row.name).not.toHaveBeenCalled();
        } else {
          expect((outcome as Response).status, row.name).toBe(200);
          expect(provider, row.name).toHaveBeenCalledOnce();
        }
        expect(kinds, row.name).toEqual(row.kinds);
        const after = await charged(tenantId);
        const delta = { none: 0, max, actual }[row.charge];
        expect({ global: after.global - before.global, tenant: after.tenant - before.tenant }, row.name).toEqual({
          global: delta,
          tenant: delta,
        });
      } finally {
        await sql(
          "UPDATE system_policy SET daily_spend_microdollars = 100000000000, catalog_version = 1, paid_work_enabled = true WHERE id = 1",
        );
      }
    }
  });

  it("the OperatorSpend entrypoint forwards only the four spend verbs for a real tenant", async () => {
    const operatorSpend = (bindings: Env) => new OperatorSpend(createExecutionContext(), bindings);
    const ask = async (bindings: Env, body: unknown) =>
      operatorSpend(bindings).fetch(
        new Request("https://operator/spend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const quote = { dayKey: new Date().toISOString().slice(0, 10), catalogVersion: 1, requestFingerprint: "f".repeat(64), maxMicrodollars: 10 };
    const identity = { tenantId: FOUNDER_TENANT_ID, opId: "operator:test:operator:1", quote };
    // Against an unbound env, so a 400 proves the request never reached a guard.
    const unbound = {} as Env;
    const rows: Array<[string, unknown, number, unknown?]> = [
      ["a lease verb", { kind: "acquire_lease", tenantId: FOUNDER_TENANT_ID, attemptId: "at_x", nowMs: 1 }, 400],
      ["a purge verb", { kind: "purge_tenant", tenantId: FOUNDER_TENANT_ID }, 400],
      ["a status verb", { kind: "spend_status" }, 400],
      // The pre-tenant storage root has no spend counter; --billing-tenant must name a user.
      ["the global tenant id", { ...identity, kind: "release_spend", tenantId: "global" }, 400],
      ["an extra field", { ...identity, kind: "release_spend", attemptId: "at_x" }, 400],
      // An operator command cannot admit work the tenant's own key pays for.
      ["a tenant-funded reserve", { ...identity, kind: "reserve_spend", nowMs: 1, payer: "tenant" }, 400],
      ["a spend verb with no authority bound", { ...identity, kind: "release_spend" }, 200, { ok: false, reason: "unavailable" }],
    ];
    for (const [name, body, status, decision] of rows) {
      const res = await ask(unbound, body);
      expect(res.status, name).toBe(status);
      if (decision) expect(await res.json(), name).toEqual(decision);
    }

    // Against the real guards: a dispatch whose usage cannot be read holds the
    // maximum, which is the whole cap here, so the next one is denied.
    const max = (await quotePaidRequest(EMBED_URL, EMBED_INIT))!.maxMicrodollars;
    await sql("UPDATE tenant_limits SET daily_spend_microdollars = ? WHERE tenant_id = ?", max, FOUNDER_TENANT_ID);
    const kinds: string[] = [];
    const paid = (provider: typeof fetch) =>
      createPaidFetch({
        tenantId: FOUNDER_TENANT_ID,
        attemptId: "operator:test",
        stage: "operator",
        fetch: provider,
        now: Date.now,
        rpc: async (body) => {
          kinds.push(String(body.kind));
          return (await ask(env as unknown as Env, body)).json();
        },
      })(EMBED_URL, EMBED_INIT);
    expect((await paid(async () => Response.json({ data: [] }))).status).toBe(200);
    expect(kinds).toEqual(["reserve_spend", "mark_spend_dispatched"]);
    const provider = vi.fn<typeof fetch>(async () => Response.json(USAGE));
    await expect(paid(provider)).rejects.toMatchObject({ reason: "daily_spend" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("processReading pays only with the tenant's own key", async () => {
    const logged: string[] = [];
    for (const method of ["info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const bearer = (key: string) => `authorization=Bearer ${key}`;
    const xApiKey = (key: string) => `x-api-key=${key}`;
    const rows: Array<{
      name: string;
      key: string | null;
      // Stored beside `key`, with Anthropic selected as the reader's provider.
      anthropicKey?: string;
      provider: (input: RequestInfo | URL, tenantId: string, embeds: number) => Promise<Response>;
      sent: string[];
      error?: Record<string, unknown>;
      after?: (tenantId: string) => Promise<void>;
    }> = [];
    // Two tenants, each through an HTTP retry: the retry re-resolves the key
    // and never falls back to the deployment's.
    for (const key of ["sk-tenant-a-aaaa", "sk-tenant-b-bbbb"]) {
      rows.push({
        name: `own key ${key} through a 500 retry`,
        key,
        provider: async (input, _tenantId, embeds) =>
          !isEmbed(input) ? summaryResponse() : embeds === 1 ? new Response("unavailable", { status: 500 }) : embeddingResponse(),
        sent: Array(4).fill(bearer(key)),
      });
    }
    rows.push(
      {
        name: "no key stored",
        key: null,
        provider: async () => embeddingResponse(),
        sent: [],
        error: { code: "provider_key_required" },
      },
      {
        // Each dispatch resolves the key again, so removal stops the next one.
        name: "key removed after the first dispatch",
        key: "sk-tenant-removed-1111",
        provider: async (input, tenantId) => {
          if (!isEmbed(input)) throw new Error("provider called after the key was removed");
          await deleteProviderCredentials(testControlPlane(env), tenantId);
          return embeddingResponse();
        },
        sent: [bearer("sk-tenant-removed-1111")],
        error: { code: "provider_key_required" },
      },
      {
        // Each provider reads its own header; the other's never rides along.
        name: "both keys, Anthropic selected",
        key: "sk-tenant-openai-1212",
        anthropicKey: "sk-ant-tenant-3434",
        provider: async (input) => (isEmbed(input) ? embeddingResponse() : anthropicSummaryResponse()),
        sent: [bearer("sk-tenant-openai-1212"), xApiKey("sk-ant-tenant-3434"), bearer("sk-tenant-openai-1212")],
      },
      {
        name: "Anthropic rejects its key",
        key: "sk-tenant-openai-5656",
        anthropicKey: "sk-ant-tenant-rejected-7878",
        provider: async (input) => isEmbed(input)
          ? embeddingResponse()
          : new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }),
        sent: [bearer("sk-tenant-openai-5656"), xApiKey("sk-ant-tenant-rejected-7878")],
        error: { code: "provider_key_invalid", provider: "anthropic", stage: "summarize", http_status: 401 },
        after: async (tenantId) => {
          const db = testControlPlane(env);
          expect((await readProviderCredential(db, tenantId, "anthropic"))?.status).toBe("invalid");
          expect((await readProviderCredential(db, tenantId, "openai"))?.status).toBe("active");
        },
      },
      {
        // No deployment fallback, and no switch to OpenAI for the summary.
        name: "Anthropic key removed after embed_source",
        key: "sk-tenant-openai-9090",
        anthropicKey: "sk-ant-tenant-removed-2323",
        provider: async (input, tenantId) => {
          if (!isEmbed(input)) throw new Error("summarized after the Anthropic key was removed");
          await deleteProviderCredential(testControlPlane(env), { tenantId, provider: "anthropic" });
          return embeddingResponse();
        },
        sent: [bearer("sk-tenant-openai-9090")],
        error: { code: "provider_key_required", provider: "anthropic", stage: "summarize" },
      },
    );

    const keys = [DEPLOYMENT_KEY, "sk-anthropic-deployment"];
    for (const row of rows) {
      const { tenantId } = await newTenant();
      const tenant = tenantOf(tenantId);
      if (row.key) {
        keys.push(row.key);
        await storeKey(tenantId, row.key);
      }
      if (row.anthropicKey) {
        keys.push(row.anthropicKey);
        await storeKey(tenantId, row.anthropicKey, "anthropic");
        await expect(updateProviderPreferences(testControlPlane(env), {
          userId: tenantId, nowMs: Date.parse(CREATED_AT), effort: "medium", summarizationProvider: "anthropic",
        })).resolves.toBe("ok");
      }
      const sent: string[] = [];
      let embeds = 0;
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization");
        const apiKey = headers.get("x-api-key");
        sent.push([auth && `authorization=${auth}`, apiKey && `x-api-key=${apiKey}`].filter(Boolean).join(" "));
        if (isEmbed(input)) embeds += 1;
        return row.provider(input, tenantId, embeds);
      });
      const job = await seedPending(tenant, `https://keys.example/${tenantId}`);
      await processReading(job, keysOn(), services(fetchFn), tenant);

      expect(sent, row.name).toEqual(row.sent);
      const manifest = await testReadingsFor(tenant).manifest(job.id);
      if (row.error) {
        expect(manifest, row.name).toMatchObject({ status: "failed", error: { ...row.error, retryable: false } });
      } else {
        expect(manifest?.status, row.name).toBe("ready");
      }
      await row.after?.(tenantId);
      const attempt = await testControlPlane(env).first<{ text: string; provider: string | null }>(
        `SELECT concat_ws(' ', checkpoint::text, error::text, events::text) AS text,
                checkpoint->'config'->>'provider' AS provider
         FROM reading_attempts WHERE tenant_id = ? AND id = ?`,
        tenantId,
        job.attemptId,
      );
      expect(attempt, `${row.name}: attempt row`).not.toBeNull();
      if (row.sent.length > 0) {
        expect(attempt!.provider, `${row.name}: attempt config`).toBe(row.anthropicKey ? "anthropic" : "openai");
      }
      const durable = `${attempt!.text} ${JSON.stringify(manifest)}`;
      for (const key of keys) expect(durable.includes(key), `${row.name}: attempt row holds ${key}`).toBe(false);
    }
    const log = logged.join("\n");
    for (const key of keys) expect(log.includes(key), `logs hold ${key}`).toBe(false);
  });

  it("processReading stops paid work when its lease or guard is gone, and publishes nothing", async () => {
    const plain = () => ({ ...env, ...NO_RETRY_DELAY }) as unknown as Env;
    const rows: Array<{
      name: string;
      // Installs the fault; returns its undo. `fetchFn` is the provider, `summarySpend` collects summarize's spend verbs.
      install: (ctx: { fetchFn: ReturnType<typeof vi.fn<typeof fetch>>; summarySpend: string[] }) => () => void;
      embeds: number;
      summarySpend?: string[];
    }> = [
      {
        // Leases are presented inside the HTTP retry loop: the retry after a
        // 500 is a new bill and must not leave without a live lease.
        name: "lease lost between an embed's 500 and its retry",
        install: ({ fetchFn }) =>
          interceptGuard("GLOBAL_USAGE_GUARD", async (body, next) =>
            body.kind === "renew_lease" && callsTo(fetchFn, true) >= 1 ? Response.json({ ok: false, reason: "unavailable" }) : next(),
          ),
        embeds: 1,
      },
      {
        name: "global usage guard binding absent",
        install: () => {
          const bindings = env as unknown as { GLOBAL_USAGE_GUARD?: DurableObjectNamespace };
          const original = bindings.GLOBAL_USAGE_GUARD;
          bindings.GLOBAL_USAGE_GUARD = undefined;
          return () => {
            bindings.GLOBAL_USAGE_GUARD = original;
          };
        },
        embeds: 0,
      },
      {
        // The reading slot commits only once summarize holds dispatch
        // permission; a failed commit settles that permission at zero.
        name: "reading-slot commit fails at summarize",
        install: ({ summarySpend }) => {
          const restoreGlobal = interceptGuard("GLOBAL_USAGE_GUARD", async (body, next) => {
            if (String(body.opId).includes(":summarize:")) summarySpend.push(String(body.kind));
            return next();
          });
          const restoreTenant = interceptGuard("TENANT_USAGE_GUARD", async (body, next) =>
            body.kind === "commit_reading" ? Response.json({ ok: false, reason: "unavailable" }) : next(),
          );
          return () => {
            restoreTenant();
            restoreGlobal();
          };
        },
        embeds: 2,
        summarySpend: ["reserve_spend", "mark_spend_dispatched", "settle_spend"],
      },
    ];

    for (const row of rows) {
      const { tenantId } = await newTenant();
      const tenant = tenantOf(tenantId);
      const job = await seedPending(tenant, `https://lease.example/${tenantId}`);
      let embeds = 0;
      const fetchFn = vi.fn<typeof fetch>(async (input) => {
        if (!isEmbed(input)) return summaryResponse();
        embeds += 1;
        return embeds === 1 ? new Response("unavailable", { status: 500 }) : embeddingResponse();
      });
      const summarySpend: string[] = [];
      const restore = row.install({ fetchFn, summarySpend });
      try {
        const outcome = await processReading(job, plain(), services(fetchFn), tenant).catch((error: unknown) => error);
        expect(outcome, row.name).toBeInstanceOf(DeferPaidWorkError);
      } finally {
        restore();
      }
      expect(callsTo(fetchFn, true), `${row.name}: embeds`).toBe(row.embeds);
      expect(callsTo(fetchFn, false), `${row.name}: summaries`).toBe(0);
      if (row.summarySpend) expect(summarySpend, row.name).toEqual(row.summarySpend);
      await expect(testReadingsFor(tenant).manifest(job.id), row.name).resolves.toMatchObject({
        status: "pending",
        active_attempt: { id: job.attemptId },
      });
    }
  });

  it("intake refuses paid work it cannot admit and claims nothing", async () => {
    const rows: Array<{
      name: string;
      arrange: (tenantId: string) => Promise<unknown>;
      keys?: true;
      status: number;
      body: Record<string, unknown>;
      retryAfter?: RegExp;
    }> = [
      {
        name: "tenant limits missing",
        arrange: (tenantId) => sql("DELETE FROM tenant_limits WHERE tenant_id = ?", tenantId),
        status: 429,
        body: { error: "usage guard unavailable" },
      },
      {
        name: "monthly quota spent",
        arrange: async (tenantId) => {
          await sql("UPDATE tenant_limits SET monthly_readings = 1 WHERE tenant_id = ?", tenantId);
          // Intake counts the month on the injected services clock.
          const ns = (env as unknown as Env).TENANT_USAGE_GUARD!;
          const res = await ns.get(ns.idFromName(tenantId)).fetch("https://tenant-usage-guard/", {
            method: "POST",
            body: JSON.stringify({ kind: "reserve_reading", tenantId, opId: "at_earlier", nowMs: Date.parse(SERVICES_NOW) }),
          });
          expect(await res.json(), "earlier reading takes the only slot").toMatchObject({ ok: true });
        },
        status: 429,
        body: { code: "quota_exhausted", limit: "monthly" },
        retryAfter: /^[1-9][0-9]*$/,
      },
      {
        name: "tenant keys on, no key stored",
        arrange: async () => {},
        keys: true,
        status: 409,
        body: { error: "connect a key, then retry", code: "provider_key_required" },
      },
      {
        name: "tenant keys on, key marked invalid",
        arrange: async (tenantId) => {
          await storeKey(tenantId, "sk-tenant-intake-7777");
          await markProviderCredentialInvalid(testControlPlane(env), { tenantId, credentialVersion: 1, nowMs: Date.parse(CREATED_AT) });
        },
        keys: true,
        status: 409,
        body: { error: "connect a key, then retry", code: "provider_key_required" },
      },
    ];

    for (const row of rows) {
      const queued = installQueueStub();
      const { tenantId, token } = await newTenant();
      await row.arrange(tenantId);
      const url = `https://intake.example/${tenantId}`;
      const res = await createApp({ services: services(vi.fn<typeof fetch>()) }).request(
        "/api/readings",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ url, email: false }),
        },
        row.keys ? keysOn() : env,
      );
      expect(res.status, row.name).toBe(row.status);
      expect(await res.json(), row.name).toMatchObject(row.body);
      if (row.retryAfter) expect(res.headers.get("Retry-After"), row.name).toMatch(row.retryAfter);
      expect(queued, `${row.name}: queued`).toHaveLength(0);
      const readings = testReadingsFor(tenantOf(tenantId));
      await expect(readings.urlOwnerId(url), `${row.name}: URL claim`).resolves.toBeNull();
      const [{ n }] = await readings.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM readings WHERE tenant_id = $1", [tenantId]);
      expect(n, `${row.name}: reading rows`).toBe(0);
    }
  });
});
