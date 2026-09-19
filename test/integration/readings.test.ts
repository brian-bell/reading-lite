import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromD1 } from "../../src/control-plane/db";
import {
  consumeProcessReadingMessage,
  type ProcessReadingEnvelopeV1,
} from "../../src/control-plane/envelope";
import { createApp } from "../../src/router";
import { handleDeadLetter, type Env } from "../../src/index";
import {
  markDeadLettered,
  processReading,
  type ProcessReadingArgs,
} from "../../src/process-reading";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { SimilarityStore, tenantVectorId } from "../../src/modules/stores/similarity-store";
import {
  buildKeyPrefix,
  manifestToIndexItem,
  ReadingStore,
} from "../../src/modules/stores/reading-store";
import { GetReadingResponseSchema } from "../../src/schemas/api";
import {
  FOUNDER_TENANT_ID,
  OTHER_TENANT_ID,
  OTHER_TOKEN_ID,
  OTHER_TOKEN_SECRET,
  founderTenant,
  insertSecondTenant,
  otherTenant,
  PUBLIC_LOOKUP,
  reserveReadingSlot,
} from "../helpers/tenant-fixtures";
import { testReadingsFor, type TestReadings } from "../helpers/test-readings";
import type { TenantContext } from "../../src/control-plane/ids";
import type { ListIndexItem } from "../../src/schemas/api";
import type { Manifest } from "../../src/schemas/manifest";
import { writeResults } from "../../scripts/corpus-lib/batch/write-phase";
import type { BatchResult } from "../../scripts/corpus-lib/batch/clients";
import type { Sidecar, SidecarTarget } from "../../scripts/corpus-lib/batch/types";

// Reading state is PostgreSQL rows now (ADR 0005). Many tests here arrange a
// reading the way the old storage spelled it: a manifest at a key prefix, the
// by-url and by-id pointers, a list row. `rowStore` keeps those verbs so each
// test still reads as the scenario it describes, and maps them onto rows:
//
// - writeManifest seeds the reading (its rows ARE the list row and the by-id
//   pointer, so those two writes have nothing left to do);
// - writeByUrlPointer makes that reading the URL's owner, which is all a by-url
//   pointer ever meant. One that names a reading not seeded yet is applied when
//   the reading arrives;
// - the reads project rows back into the old shapes.
//
// Assertions about the pointer objects themselves went with the pointers.
const idOfPrefix = (keyPrefix: string) => keyPrefix.slice(keyPrefix.lastIndexOf("-") + 1);

function rowStore(tenant: TenantContext = founderTenant()) {
  const readings: TestReadings = testReadingsFor(tenant);
  const tenantId = String(tenant.tenantId);
  const pendingOwners = new Map<string, string>();
  const own = async (urlHash: string, readingId: string) => {
    const [exists] = await readings.sql.query("SELECT 1 FROM readings WHERE tenant_id = $1 AND id = $2", [tenantId, readingId]);
    if (!exists) {
      pendingOwners.set(urlHash, readingId);
      return;
    }
    await readings.sql.query(
      `INSERT INTO reading_urls (tenant_id, url_hash, reading_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, url_hash) DO UPDATE SET reading_id = EXCLUDED.reading_id`,
      [tenantId, urlHash, readingId],
    );
  };
  return {
    readings,
    async writeManifest(keyPrefix: string, manifest: Manifest): Promise<void> {
      await readings.seed(manifest, { keyPrefix });
      const owner = pendingOwners.get(manifest.url_hash);
      if (owner === manifest.id) {
        pendingOwners.delete(manifest.url_hash);
        await own(manifest.url_hash, owner);
      }
    },
    readManifest: (keyPrefix: string) => readings.manifest(idOfPrefix(keyPrefix)),
    loadReadingById: (readingId: string) => readings.store.loadReadingById(readingId),
    writeByUrlPointer: (urlHash: string, pointer: { id: string }) => own(urlHash, pointer.id),
    async readByUrlPointer(urlHash: string): Promise<{ id: string; key_prefix: string } | null> {
      const [row] = await readings.sql.query<{ id: string; key_prefix: string }>(
        `SELECT r.id, r.key_prefix FROM reading_urls u
         JOIN readings r ON (r.tenant_id, r.id) = (u.tenant_id, u.reading_id)
         WHERE u.tenant_id = $1 AND u.url_hash = $2`,
        [tenantId, urlHash],
      );
      return row ?? null;
    },
    async readByIdPointer(readingId: string): Promise<{ id: string; key_prefix: string } | null> {
      const keyPrefix = await readings.keyPrefix(readingId);
      return keyPrefix === null ? null : { id: readingId, key_prefix: keyPrefix };
    },
    // The reading's rows are its by-id pointer and its list row.
    writeByIdPointer: async (_id: string, _pointer: unknown): Promise<void> => undefined,
    appendOrReplaceListIndexItem: async (_item: ListIndexItem): Promise<void> => undefined,
    writeListIndex: (index: { items: ListIndexItem[] }) => readings.seedListItems(index.items),
    async readListIndex(): Promise<{ version: 1; items: ListIndexItem[] }> {
      return { version: 1, items: await readings.store.allListItems() };
    },
    writeExtracted: (keyPrefix: string, markdown: string) =>
      readings.content.put(`${keyPrefix}/extracted.md`, markdown, "text/markdown; charset=utf-8"),
    writeRaw: (keyPrefix: string, ext: string, bytes: Uint8Array, contentType: string) =>
      readings.content.put(`${keyPrefix}/raw.${ext}`, bytes, contentType),
  };
}

// Vectorize is stubbed in the env at the integration boundary because Miniflare
// has no native Vectorize emulator. We mutate env.READINGS_INDEX in-place per
// test. The stub honours `namespace` the way Vectorize does — a query only
// matches vectors stored in the same namespace (undefined being a namespace of
// its own) — because wrangler.test.toml runs with TENANT_DATA_PLANE=1 and the
// tenant-isolation tests rely on that segmentation being real.
type AnyMock = ReturnType<typeof vi.fn>;
function installVectorizeStub(): {
  upsert: AnyMock;
  query: AnyMock;
  deleteByIds: AnyMock;
  vectors: Map<string, { values: number[]; namespace?: string; metadata: Record<string, unknown> }>;
} {
  const vectors = new Map<
    string,
    { values: number[]; namespace?: string; metadata: Record<string, unknown> }
  >();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, {
        values: v.values as number[],
        ...(v.namespace === undefined ? {} : { namespace: v.namespace }),
        metadata: (v.metadata ?? {}) as Record<string, unknown>,
      });
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const query = vi.fn(async (_v: number[], opts: VectorizeQueryOptions) => {
    const k = opts.topK ?? 5;
    const matches = Array.from(vectors.entries())
      .filter(([, v]) => v.namespace === opts.namespace)
      .slice(0, k)
      .map(([id, v]) => ({ id, score: 0.9, values: v.values, metadata: v.metadata }));
    return { count: matches.length, matches } as unknown as VectorizeMatches;
  });
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert,
    deleteByIds,
    query,
  } as unknown as VectorizeIndex;
  return { upsert, query, deleteByIds, vectors };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

// Production sends ProcessReadingEnvelopeV1 through Cloudflare Queues. Miniflare
// has no native queue emulator (and per CLAUDE.md adding the binding to
// wrangler.test.toml hangs the runtime), so we install a stub that captures
// `send()` calls. `queuedJobs` is the job view used by existing assertions;
// `queuedEnvelopes` is the on-the-wire v1 payload. `drainQueue` runs the
// fail-closed consumer (validate + admit founder tenant/token) then processReading.
let queuedEnvelopes: ProcessReadingEnvelopeV1[] = [];
let queuedJobs: ProcessReadingArgs[] = [];
function installQueueStub(): ProcessReadingArgs[] {
  queuedEnvelopes = [];
  queuedJobs = [];
  (env as unknown as { READING_JOBS: Queue<ProcessReadingEnvelopeV1> }).READING_JOBS = {
    send: vi.fn(async (msg: ProcessReadingEnvelopeV1) => {
      queuedEnvelopes.push(msg);
      queuedJobs.push(msg.job);
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
  return queuedJobs;
}

function installRejectingQueueStub(error: unknown = new Error("queue send failed")) {
  (env as unknown as { READING_JOBS: Queue<ProcessReadingEnvelopeV1> }).READING_JOBS = {
    send: vi.fn(async () => {
      throw error;
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
}

async function drainQueue(services: Services): Promise<void> {
  while (queuedEnvelopes.length > 0) {
    const envelope = queuedEnvelopes.shift()!;
    queuedJobs.shift();
    await consumeProcessReadingMessage(
      { body: envelope, ack() {} },
      {
        db: fromD1((env as unknown as Env).CONTROL_PLANE),
        nowMs: Date.now(),
        process: (job, tenant) => processReading(job, env as unknown as Env, services, tenant),
      },
    );
  }
}

const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function makeStubFetch(opts: {
  source?: { status?: number; body?: string; contentType?: string };
  embedding?: number[];
  toolInput?: Record<string, unknown>;
  // Derive the summarizer's structured output from the request it was sent,
  // instead of returning the canned `toolInput`. Lets a test make connections
  // a faithful echo of the neighbours the prompt actually cited, so a
  // cross-tenant similarity leak surfaces in the terminal manifest.
  toolInputFromRequest?: (requestBody: string) => Record<string, unknown>;
  anthropicStatus?: number;
  anthropicBody?: unknown;
  resendStatus?: number;
  resendBody?: unknown;
} = {}) {
  const source = opts.source ?? {
    status: 200,
    body: HTML,
    contentType: "text/html; charset=utf-8",
  };
  const embedding = opts.embedding ?? new Array(1536).fill(0.1);
  const toolInput = opts.toolInput ?? {
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
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const requestBody = async () =>
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : "";
    const summaryToolInput = async () =>
      opts.toolInputFromRequest ? opts.toolInputFromRequest(await requestBody()) : toolInput;
    if (url.startsWith("https://api.openai.com/v1/embeddings")) {
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
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
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(await summaryToolInput()),
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 10,
            },
            output_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 150,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      const status = opts.anthropicStatus ?? 200;
      const body = opts.anthropicBody ?? {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_01", name: "emit_reading", input: await summaryToolInput() }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.resend.com/emails")) {
      const status = opts.resendStatus ?? 200;
      const body = opts.resendBody ?? { id: "resend_01" };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // Source URL (or anything else) falls through to the source stub.
    return new Response(source.body, {
      status: source.status,
      headers: source.contentType ? { "content-type": source.contentType } : {},
    });
  });
  return fetchFn;
}

function resendCalls(fetchFn: ReturnType<typeof makeStubFetch>) {
  return fetchFn.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith("https://api.resend.com/emails");
  });
}

function makeServices(fetchFn: typeof fetch, idCounter = { n: 0 }, baseTime = "2026-04-26T20:00:00.000Z"): Services {
  const start = Date.parse(baseTime);
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

function r2ClientForBucket(bucket: R2Bucket, keyRoot = "") {
  const objectKey = (key: string) => `${keyRoot}${key}`;
  return {
    async put(key: string, body: Uint8Array | string, opts?: { contentType?: string }) {
      await bucket.put(objectKey(key), body, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined);
    },
    async putIfAbsent(key: string, body: Uint8Array | string, opts?: { contentType?: string }) {
      const result = await bucket.put(objectKey(key), body, {
        ...(opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : {}),
        onlyIf: new Headers({ "If-None-Match": "*" }),
      });
      return result !== null;
    },
    async get(key: string) {
      const obj = await bucket.get(objectKey(key));
      return obj ? obj.text() : null;
    },
    async head(key: string) {
      return (await bucket.head(objectKey(key))) !== null;
    },
    async delete(key: string) {
      await bucket.delete(objectKey(key));
    },
    async listKeys() {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ prefix: keyRoot || undefined, cursor });
        keys.push(...listed.objects.map((obj) => obj.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return keys;
    },
  };
}

const TOKEN = "test-token";

function founderObjectKey(relative: string): string {
  return `u/${FOUNDER_TENANT_ID}/${relative}`;
}

beforeEach(() => {
  installVectorizeStub();
  installQueueStub();
});
afterEach(clearBucket);

async function founderIds(): Promise<{ tenantId: string; tokenId: string }> {
  const workerEnv = env as unknown as Env;
  const user = await workerEnv.CONTROL_PLANE.prepare(
    "SELECT id FROM users WHERE email_canonical = ?",
  )
    .bind("founder@test.example")
    .first<{ id: string }>();
  const token = await workerEnv.CONTROL_PLANE.prepare(
    "SELECT id FROM api_tokens WHERE user_id = ?",
  )
    .bind(user!.id)
    .first<{ id: string }>();
  return { tenantId: user!.id, tokenId: token!.id };
}

// Drain-only cutover (ADR 0001): there is no legacy decoder. Operators stop
// producers, drain the old queue (unversioned leftovers are acked without
// processing), then deploy the v1 producer and consumer together.
describe("versioned tenant queue envelope cutover", () => {
  it("rejects leftover unversioned jobs and preserves founder submit-to-ready on v1", async () => {
    const { tenantId, tokenId } = await founderIds();
    const process = vi.fn();
    const leftover = {
      id: "rd_LEGACY",
      url: "https://example.com/legacy-drain",
      urlHash: "b".repeat(64),
      createdAt: "2026-08-16T12:00:00.000Z",
      keyPrefix: "readings/2026/08/16T120000Z-rd_LEGACY",
    };
    const leftoverAck = vi.fn();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await consumeProcessReadingMessage(
      { body: leftover, ack: leftoverAck },
      {
        db: fromD1((env as unknown as Env).CONTROL_PLANE),
        nowMs: Date.now(),
        process,
      },
    );
    expect(process).not.toHaveBeenCalled();
    expect(leftoverAck).toHaveBeenCalledOnce();
    consoleErr.mockRestore();

    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/envelope-cutover" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    expect(queuedEnvelopes).toHaveLength(1);
    expect(queuedEnvelopes[0]).toMatchObject({
      version: 1,
      tenant: { tenantId },
      actor: { kind: "api_token", credentialId: tokenId },
      job: { url: "https://example.com/envelope-cutover", trigger: "submit" },
    });
    expect(queuedEnvelopes[0]).not.toHaveProperty("scopes");

    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    const { id } = (await submit.json()) as { id: string };
    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ id, status: "ready", title: "Test Article" });
  });
});

describe("two-tenant save-to-ready lifecycle", () => {
  it("lets two users save the same URL and reach ready without observing each other", async () => {
    await insertSecondTenant(env as unknown as Env);
    const url = "https://example.com/shared-two-tenant";
    const urlHash = await sha256Hex(url);
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    async function submit(token: string) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("http://t/api/readings", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ url, email: false }),
        }),
        env,
        ctx,
      );
      return { res, ctx };
    }

    const founderSubmit = await submit(TOKEN);
    const otherSubmit = await submit(OTHER_TOKEN_SECRET);
    expect(founderSubmit.res.status).toBe(202);
    expect(otherSubmit.res.status).toBe(202);
    const founderBody = (await founderSubmit.res.json()) as { id: string };
    const otherBody = (await otherSubmit.res.json()) as { id: string };
    expect(founderBody.id).not.toBe(otherBody.id);
    expect(founderBody.id).toMatch(/^rd_/);
    expect(otherBody.id).toMatch(/^rd_/);

    await drainQueue(services);
    await waitOnExecutionContext(founderSubmit.ctx);
    await waitOnExecutionContext(otherSubmit.ctx);

    async function getReading(token: string, id: string) {
      return app.request(`/api/readings/${id}`, { headers: { authorization: `Bearer ${token}` } }, env);
    }
    async function listReadings(token: string) {
      return app.request("/api/readings", { headers: { authorization: `Bearer ${token}` } }, env);
    }

    const founderDetail = await getReading(TOKEN, founderBody.id);
    const otherDetail = await getReading(OTHER_TOKEN_SECRET, otherBody.id);
    expect(founderDetail.status).toBe(200);
    expect(otherDetail.status).toBe(200);
    expect(await founderDetail.json()).toMatchObject({ id: founderBody.id, status: "ready", url });
    expect(await otherDetail.json()).toMatchObject({ id: otherBody.id, status: "ready", url });

    const founderList = (await (await listReadings(TOKEN)).json()) as { readings: { id: string }[] };
    const otherList = (await (await listReadings(OTHER_TOKEN_SECRET)).json()) as { readings: { id: string }[] };
    expect(founderList.readings.map((r) => r.id)).toEqual([founderBody.id]);
    expect(otherList.readings.map((r) => r.id)).toEqual([otherBody.id]);

    const crossFounder = await getReading(TOKEN, otherBody.id);
    const crossOther = await getReading(OTHER_TOKEN_SECRET, founderBody.id);
    const unknown = await getReading(TOKEN, "rd_UNKNOWN");
    expect(crossFounder.status).toBe(404);
    expect(crossOther.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossFounder.json()).toEqual({ error: "not found" });
    expect(await crossOther.json()).toEqual({ error: "not found" });
    expect(await unknown.json()).toEqual({ error: "not found" });

    const resubmit = await submit(TOKEN);
    expect(resubmit.res.status).toBe(200);
    expect(await resubmit.res.json()).toMatchObject({ id: founderBody.id, status: "ready" });
    await waitOnExecutionContext(resubmit.ctx);

    expect(await env.READINGS_BUCKET.head(`index/by-url/${urlHash}`)).toBeNull();
    expect(await env.READINGS_BUCKET.head(`u/${FOUNDER_TENANT_ID}/index/by-url/${urlHash}`)).not.toBeNull();
    expect(await env.READINGS_BUCKET.head(`u/${OTHER_TENANT_ID}/index/by-url/${urlHash}`)).not.toBeNull();
    expect(await env.READINGS_BUCKET.head(`u/${FOUNDER_TENANT_ID}/index/list.json`)).not.toBeNull();
    expect(await env.READINGS_BUCKET.head(`u/${OTHER_TENANT_ID}/index/list.json`)).not.toBeNull();
  });

  it("keeps similarity, novelty, and connections private to the active tenant", async () => {
    await insertSecondTenant(env as unknown as Env);
    const stub = installVectorizeStub();
    const READING_ID_RE = /rd_[0-9A-HJ-NP-Z]{10}/g;
    // The summarizer echoes back exactly the neighbour ids its prompt cited, so
    // the terminal manifest's connections are a faithful record of what the
    // model was shown: a cross-tenant vector reaching the prompt would land the
    // other tenant's rd_ id in connections and fail the assertions below.
    const fetchFn = makeStubFetch({
      toolInputFromRequest: (requestBody) => {
        const cited = Array.from(new Set(requestBody.match(READING_ID_RE) ?? []));
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

    async function submitAndDrain(token: string, url: string) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("http://t/api/readings", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ url, email: false }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      await drainQueue(services);
      await waitOnExecutionContext(ctx);
      const detail = await app.request(
        `/api/readings/${id}`,
        { headers: { authorization: `Bearer ${token}` } },
        env,
      );
      expect(detail.status).toBe(200);
      return (await detail.json()) as {
        id: string;
        status: string;
        novelty_verdict?: string;
        connections?: Array<{ id: string; reason: string }>;
        connections_neighbourhood_ids?: string[];
        similarity?: { count: number };
      };
    }

    // Founder builds a two-reading library; the second must cite the first,
    // proving in-tenant similarity still flows (isolation is not "nobody sees
    // anything").
    const founderFirst = await submitAndDrain(TOKEN, "https://example.com/private-sim-founder-1");
    const founderSecond = await submitAndDrain(TOKEN, "https://example.com/private-sim-founder-2");
    expect(founderFirst.status).toBe("ready");
    expect(founderFirst.similarity?.count).toBe(0);
    expect(founderFirst.novelty_verdict).toBe("novel");
    expect(founderFirst.connections).toEqual([]);
    expect(founderFirst.connections_neighbourhood_ids).toEqual([]);
    expect(founderSecond.status).toBe("ready");
    expect(founderSecond.similarity?.count).toBe(1);
    expect(founderSecond.novelty_verdict).toBe("familiar");
    expect(founderSecond.connections).toEqual([
      { id: founderFirst.id, reason: "covers the same ground" },
    ]);
    expect(founderSecond.connections_neighbourhood_ids).toEqual([founderFirst.id]);

    // The other tenant's first save: the stub scores every same-namespace
    // vector at 0.9 (well above SIMILARITY_FLOOR), so if the founder's two
    // vectors were visible they would be cited. They must not be: the reading
    // comes back novel, unconnected, with an empty measured neighbourhood.
    const otherFirst = await submitAndDrain(OTHER_TOKEN_SECRET, "https://example.com/private-sim-other-1");
    expect(otherFirst.status).toBe("ready");
    expect(otherFirst.similarity?.count).toBe(0);
    expect(otherFirst.novelty_verdict).toBe("novel");
    expect(otherFirst.connections).toEqual([]);
    expect(otherFirst.connections_neighbourhood_ids).toEqual([]);

    // Stronger than the manifest checks: the other tenant's summarize request
    // must not mention any reading id at all — the founder's library never
    // reaches the prompt even as sub-floor context.
    const summarizeBodies = fetchFn.mock.calls
      .filter(([input]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return url.startsWith("https://api.openai.com/v1/responses");
      })
      .map(([, init]) => (typeof init?.body === "string" ? init.body : ""));
    expect(summarizeBodies).toHaveLength(3);
    expect(summarizeBodies[2]!.match(READING_ID_RE)).toBeNull();

    // Every vector landed in its tenant's namespace, under its tenant-prefixed
    // id (ADR 0002).
    expect(stub.vectors.get(tenantVectorId(FOUNDER_TENANT_ID, founderFirst.id))?.namespace).toBe(FOUNDER_TENANT_ID);
    expect(stub.vectors.get(tenantVectorId(FOUNDER_TENANT_ID, founderSecond.id))?.namespace).toBe(FOUNDER_TENANT_ID);
    expect(stub.vectors.get(tenantVectorId(OTHER_TENANT_ID, otherFirst.id))?.namespace).toBe(OTHER_TENANT_ID);
  });
});

describe.each([
  ["openai", "gpt-5.6-terra"],
  ["anthropic", "claude-sonnet-5"],
] as const)("realtime summarizer provider %s", (provider, model) => {
  it("completes submit, markdown import, and reprocess through the selected provider", async () => {
    const workerEnv = env as unknown as Env;
    const previousProvider = workerEnv.SUMMARIZER_PROVIDER;
    workerEnv.SUMMARIZER_PROVIDER = provider;
    try {
      const services = makeServices(makeStubFetch());
      const app = createApp({ services });

      const submitContext = createExecutionContext();
      const submit = await app.fetch(
        new Request("http://t/api/readings", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url: `https://example.com/provider-${provider}`,
          }),
        }),
        env,
        submitContext,
      );
      expect(submit.status).toBe(202);
      const submitted = (await submit.json()) as { id: string };
      await drainQueue(services);
      await waitOnExecutionContext(submitContext);

      const importedContext = createExecutionContext();
      const importedResponse = await app.fetch(
        new Request("http://t/api/readings/import-markdown", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            source_url: `https://example.com/provider-${provider}-markdown`,
            markdown: "# Provider import\n\nCaptured markdown content.",
          }),
        }),
        env,
        importedContext,
      );
      expect(importedResponse.status).toBe(202);
      const imported = (await importedResponse.json()) as { id: string };
      await drainQueue(services);
      await waitOnExecutionContext(importedContext);

      const reprocessContext = createExecutionContext();
      const reprocess = await app.fetch(
        new Request(
          `http://t/api/readings/${submitted.id}/reprocess`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ force: true }),
          },
        ),
        env,
        reprocessContext,
      );
      expect(reprocess.status).toBe(202);
      await drainQueue(services);
      await waitOnExecutionContext(reprocessContext);

      for (const [id, trigger] of [
        [submitted.id, "reprocess"],
        [imported.id, "import"],
      ] as const) {
        const response = await app.request(
          `/api/readings/${id}`,
          { headers: { authorization: `Bearer ${TOKEN}` } },
          env,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "ready",
          last_attempt: { trigger, status: "succeeded" },
          usage: {
            summarization: { provider, model },
            openai_embedding_tokens: 20,
          },
        });
      }
    } finally {
      if (previousProvider === undefined) {
        delete (workerEnv as { SUMMARIZER_PROVIDER?: string })
          .SUMMARIZER_PROVIDER;
      } else {
        workerEnv.SUMMARIZER_PROVIDER = previousProvider;
      }
    }
  });
});

describe("GET /health", () => {
  it("returns 200 ok without auth", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("auth", () => {
  it("rejects /api/readings without bearer", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request("/api/readings", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects with wrong token", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      { headers: { authorization: "Bearer wrong" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts with correct token", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("route namespace", () => {
  // The un-prefixed /readings* namespace belongs to the SPA (Pages serves the
  // detail page there); the Worker must not claim it, even for authed callers.
  it("does not serve the old /readings paths", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    for (const path of ["/readings", "/readings/rd_SOMEID"]) {
      const res = await app.request(
        path,
        { headers: { authorization: `Bearer ${TOKEN}` } },
        env,
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("POST /api/readings + GET /api/readings/:id (submit-and-poll)", () => {
  it("returns 202 immediately and the manifest reaches ready after the queue drains", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/article" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const submitJson = (await submit.json()) as { id: string; status: string };
    expect(submitJson.id).toMatch(/^rd_/);
    expect(submitJson.status).toBe("pending");

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const get = await app.request(
      `/api/readings/${submitJson.id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    const manifest = (await get.json()) as Record<string, unknown>;
    expect(manifest.status).toBe("ready");
    expect(manifest.title).toBe("Test Article");
    expect(manifest.tldr).toBe("A short summary.");
    expect(manifest.usage).toMatchObject({
      summarization: {
        provider: "openai",
        model: "gpt-5.6-terra",
        input_tokens: 100,
        output_tokens: 50,
        reasoning_tokens: 30,
        cached_input_tokens: 20,
        cache_write_tokens: 10,
      },
      openai_embedding_tokens: 20,
    });

    const diagnostics = await app.request(
      `/api/readings/${submitJson.id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(diagnostics.status).toBe(200);
    const diagnosticBody = (await diagnostics.json()) as {
      attempts: Array<{ status: string; finished_at?: string; events: Array<{ at: string }> }>;
    };
    const attempt = diagnosticBody.attempts[0]!;
    expect(attempt.status).toBe("succeeded");
    expect(attempt.finished_at).toBeDefined();
    const finishedAt = Date.parse(attempt.finished_at!);
    expect(attempt.events.every((event) => Date.parse(event.at) <= finishedAt)).toBe(true);
  });

  it("retrieves an X author's thread and uses it as the reading body", async () => {
    const baseFetch = makeStubFetch();
    const author = { id: "author-1", name: "Author Name", username: "author" };
    const root = {
      id: "100",
      text: "Root post",
      author_id: author.id,
      conversation_id: "100",
      created_at: "2026-04-26T12:00:00.000Z",
    };
    const child = {
      id: "200",
      text: "Thread continuation",
      author_id: author.id,
      conversation_id: "100",
      created_at: "2026-04-26T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const audience = {
      id: "300",
      text: "Audience text must stay out",
      author_id: "audience-1",
      conversation_id: "100",
      created_at: "2026-04-26T12:02:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.x.com/2/tweets/100?")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-x-token");
        return new Response(JSON.stringify({ data: root, includes: { users: [author] } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.x.com/2/tweets/search/recent?")) {
        return new Response(
          JSON.stringify({
            data: [root, child, audience],
            includes: {
              users: [
                author,
                { id: "audience-1", name: "Audience", username: "audience" },
              ],
            },
            meta: {},
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return baseFetch(input, init);
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://x.com/author/status/100?s=46" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const manifestResponse = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await manifestResponse.json()) as {
      status: string;
      source_type: string;
      content_type: string;
    };
    expect(manifest).toMatchObject({
      status: "ready",
      source_type: "url",
      content_type: "application/json; charset=utf-8",
    });

    const content = await app.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const markdown = await content.text();
    expect(markdown).toContain("# X thread by Author Name (@author)");
    expect(markdown).toContain("Root post");
    expect(markdown).toContain("Thread continuation");
    expect(markdown).not.toContain("Audience text must stay out");

    const summarizeCall = fetchFn.mock.calls.find(([input]) =>
      String(input).startsWith("https://api.openai.com/v1/responses"),
    );
    expect(String(summarizeCall?.[1]?.body)).toContain("Thread continuation");
  });

  it("surfaces the recent-search window error on an old X reading", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.x.com/2/tweets/100?")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "100",
              text: "Old root",
              author_id: "author-1",
              conversation_id: "100",
              created_at: "2026-04-18T12:00:00.000Z",
            },
            includes: {
              users: [{ id: "author-1", name: "Author Name", username: "author" }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request after old-thread gate: ${url}`);
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://x.com/author/status/100" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as {
      status: string;
      error: { code: string; message: string; stage: string; retryable: boolean };
    };
    expect(manifest).toMatchObject({
      status: "failed",
      error: {
        code: "XThreadOutsideRecentWindowError",
        message:
          "This X thread is older than the 7-day recent-search window and cannot be imported.",
        stage: "fetch_source",
        retryable: false,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("dedups: second POST with same URL returns the existing manifest, no second Vectorize upsert", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const stub = installVectorizeStub();

    // wire the fresh stub through process-reading's SimilarityStore via env mutation
    void new SimilarityStore(env.READINGS_INDEX);

    const ctx1 = createExecutionContext();
    const r1 = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      }),
      env,
      ctx1,
    );
    expect(r1.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    const upsertsAfterFirst = stub.upsert.mock.calls.length;

    const ctx2 = createExecutionContext();
    const r2 = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/dup" }),
      }),
      env,
      ctx2,
    );
    expect(r2.status).toBe(200);
    await drainQueue(services);
    await waitOnExecutionContext(ctx2);

    expect(stub.upsert.mock.calls.length).toBe(upsertsAfterFirst);
  });

  it("records a measured similarity snapshot on the terminal manifest", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    installVectorizeStub();

    const submit = async (url: string) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("http://t/api/readings", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
        env,
        ctx,
      );
      await drainQueue(services);
      await waitOnExecutionContext(ctx);
      const { id } = (await res.json()) as { id: string };
      const detail = await app.fetch(
        new Request(`http://t/api/readings/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
        env,
        createExecutionContext(),
      );
      return (await detail.json()) as {
        id: string;
        status: string;
        similarity?: { count: number; max?: number; mean?: number; computed_at: string };
        connections_neighbourhood_ids?: string[];
      };
    };

    // First reading: nothing in the index yet, so the neighbourhood is empty.
    // That must be recorded as count 0 rather than a fabricated score, and as
    // an empty judged candidate set rather than omitting the baseline.
    const first = await submit("https://example.com/sim-first");
    expect(first.status).toBe("ready");
    expect(first.similarity?.count).toBe(0);
    expect(first.similarity?.max).toBeUndefined();
    expect(first.similarity?.computed_at).toEqual(expect.any(String));
    expect(first.connections_neighbourhood_ids).toEqual([]);

    // Second reading now has the first as a neighbour, at the stub's 0.9.
    const second = await submit("https://example.com/sim-second");
    expect(second.similarity?.count).toBe(1);
    expect(second.similarity?.max).toBeCloseTo(0.9, 10);
    expect(second.similarity?.mean).toBeCloseTo(0.9, 10);
    expect(second.connections_neighbourhood_ids).toEqual([first.id]);
  });

  it("makes a new URL discoverable by lookup before processing finishes", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/pending-lookup" }),
      }),
      env,
      createExecutionContext(),
    );
    expect(submit.status).toBe(202);
    const submitJson = (await submit.json()) as { id: string };

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent("https://example.com/pending-lookup")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id: submitJson.id });
  });

  it("returns the existing pending reading for a duplicate submit without enqueueing duplicate work", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const url = "https://example.com/pending-duplicate";

    const first = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as { id: string };

    const second = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as Manifest;
    expect(secondJson.id).toBe(firstJson.id);
    expect(secondJson.status).toBe("pending");
    expect(queuedJobs).toHaveLength(1);
  });

  it("returns an old batch-owned pending reading without enqueueing realtime work", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/offline-batch-pending";
    const urlHash = await sha256Hex(url);
    const pending: Manifest = {
      id: "rd_BATCH_PENDING",
      url,
      url_hash: urlHash,
      source_type: "markdown",
      status: "pending",
      active_attempt: {
        id: "batch_rd_BATCH_PENDING",
        trigger: "import",
        status: "running",
        stage: "summarize",
        started_at: "2026-04-26T18:00:00.000Z",
      },
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "b".repeat(64),
      created_at: "2026-04-26T18:00:00.000Z",
      updated_at: "2026-04-26T18:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(pending.id, pending.created_at);
    await reader.writeManifest(keyPrefix, pending);
    await reader.writeByIdPointer(pending.id, { id: pending.id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id: pending.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(pending, keyPrefix));

    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const response = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      customEnv,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: pending.id,
      status: "pending",
      active_attempt: { id: "batch_rd_BATCH_PENDING", status: "running" },
    });
    expect(queuedJobs).toHaveLength(0);
  });

  it("converges simultaneous submits of one URL to one reading and one queued job", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const url = "https://example.com/burst-same-url";

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.fetch(
          new Request("http://t/api/readings", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ url }),
          }),
          env,
          ctx,
        ),
      ),
    );
    // Exactly one submit claims the slot and activates (202). Each loser either
    // reads the winner's pending manifest (200) or lands in the documented gap
    // between the winner's by-url pointer write and its manifest write, which
    // is a 409 "initializing" carrying the winner's id (see reading-claim.ts).
    // All three converge on the same reading; none may claim a second slot.
    expect(responses.every((r) => [200, 202, 409].includes(r.status))).toBe(true);
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ id: string }>),
    );
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(queuedJobs).toHaveLength(1);

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const list = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ id: string; status: string; url: string }> };
    expect(body.readings.filter((reading) => reading.url === url)).toEqual([
      expect.objectContaining({ id: bodies[0]!.id, status: "ready", url }),
    ]);
  });

  it("resubmitting a failed URL reprocesses the same reading id", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = "https://example.com/retry-failed-submit";

    const first = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      ctx,
    );
    const { id } = (await first.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    expect(queuedJobs).toHaveLength(0);

    const retry = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(202);
    const retryJson = (await retry.json()) as { id: string; status: string; attempt_id: string };
    expect(retryJson).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess", email: true });

    const list = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ id: string; url: string }> };
    expect(body.readings.filter((reading) => reading.url === url)).toEqual([
      expect.objectContaining({ id, url }),
    ]);
    consoleErr.mockRestore();
  });

  it("reprocesses in place after a failed fresh batch releases its by-url claim", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/failed-fresh-batch-release";
    const urlHash = await sha256Hex(url);
    const id = "rd_BATCH_FAILED_RELEASE";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const pending: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "markdown",
      status: "pending",
      active_attempt: {
        id: `batch_${id}`,
        trigger: "import",
        status: "running",
        stage: "summarize",
        started_at: createdAt,
      },
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: 36,
      content_sha256: "c".repeat(64),
      extracted_bytes: 36,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const pointer = { id, key_prefix: keyPrefix };
    await reader.writeByUrlPointer(urlHash, pointer);
    await reader.writeManifest(keyPrefix, pending);
    await reader.writeByIdPointer(id, pointer);
    await reader.writeExtracted(keyPrefix, "# Batch failed\n\nMarkdown in hand.");
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(pending, keyPrefix));

    const target: SidecarTarget = {
      customId: id,
      keyPrefix,
      id,
      url,
      urlHash,
      createdAt,
      sourceType: "markdown",
      contentType: "text/markdown; charset=utf-8",
      contentStatus: "captured",
      contentBytes: 36,
      contentSha256: "c".repeat(64),
      extractedBytes: 36,
      queryEmbedTokens: 12,
      releaseByUrlOnFailure: true,
    };
    const sidecar: Sidecar = {
      version: 2,
      provider: "anthropic",
      phase: "submitted",
      batchId: "msgbatch_failed_release",
      model: "claude-opus-4-8",
      processingStatus: "ended",
      resultsUrl: "https://example.com/results.jsonl",
      targets: [target],
    };
    const results: BatchResult[] = [
      {
        custom_id: id,
        result: { type: "errored", error: { type: "api_error", message: "manual batch failure" } },
      },
    ];

    await writeResults(sidecar, results, {
      r2: r2ClientForBucket(env.READINGS_BUCKET, `u/${FOUNDER_TENANT_ID}/`),
      vectorize: { upsert: vi.fn(), query: vi.fn() },
      embedMany: vi.fn(async () => ({ embeddings: [], tokensByInput: [] })),
      now: () => "2026-04-26T19:05:00.000Z",
    } as any);

    const failed = await reader.readManifest(keyPrefix);
    expect(failed).toMatchObject({
      id,
      status: "failed",
      error: { message: "manual batch failure", retryable: true },
    });
    expect(await reader.readByIdPointer(id)).toEqual(pointer);
    expect(await reader.readByUrlPointer(urlHash)).toBeNull();
    const failedIndex = await reader.readListIndex();
    expect(failedIndex?.items.find((item) => item.id === id)).toMatchObject({
      id,
      status: "failed",
      url,
    });

    const retry = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess" });

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id });
  });

  it("repairs a stale by-url pointer whose manifest is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/damaged-pointer";
    const urlHash = await sha256Hex(url);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    const body = (await submit.json()) as { id: string; status: string };
    expect(body).toMatchObject({ status: "pending" });
    expect(body.id).not.toBe("rd_ORPHAN");
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: body.id, trigger: "submit" });

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id: body.id });
  });

  it("GET /api/readings/lookup is read-only: a damaged pointer is 404, never scanned or repaired", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/lookup-readonly";
    const urlHash = await sha256Hex(url);
    // A damaged orphan pointer (manifest missing, past the grace window). A write
    // path would deep-scan + CAS-repair it; a lookup must do neither.
    const orphan = { id: "rd_ORPHAN", key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN" };
    await reader.writeByUrlPointer(urlHash, orphan);

    const listSpy = vi.spyOn(env.READINGS_BUCKET, "list");
    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put");

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );

    expect(lookup.status).toBe(404);
    expect(listSpy).not.toHaveBeenCalled(); // no bucket scan on a GET
    expect(putSpy).not.toHaveBeenCalled(); // no pointer-repair write on a GET
    expect(await reader.readByUrlPointer(urlHash)).toEqual(orphan); // pointer untouched
    listSpy.mockRestore();
    putSpy.mockRestore();
  });

  it("does not treat a future-dated missing-manifest owner as fresh", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/future-dated-pointer";
    const urlHash = await sha256Hex(url);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_FUTURE",
      key_prefix: "readings/2026/04/26T210000Z-rd_FUTURE",
    });

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    const body = (await submit.json()) as { id: string; status: string };
    expect(body).toMatchObject({ status: "pending" });
    expect(body.id).not.toBe("rd_FUTURE");
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: body.id, trigger: "submit" });
  });

  it("does not let a stale successful job overwrite a newer by-url owner", async () => {
    const services = makeServices(makeStubFetch());
    const vector = installVectorizeStub();
    const reader = rowStore();
    const url = "https://example.com/stale-job-success";
    const urlHash = await sha256Hex(url);
    const ownerCreatedAt = "2026-04-26T19:59:00.000Z";
    const ownerPrefix = buildKeyPrefix("rd_OWNER", ownerCreatedAt);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });

    const staleId = "rd_STALE";
    const staleCreatedAt = "2026-04-26T19:00:00.000Z";
    const stalePrefix = buildKeyPrefix(staleId, staleCreatedAt);
    // Seeded under the tenant-prefixed id + namespace, the way a gate-on
    // writer stores it — the has() assertion below only proves the cleanup
    // removed it if this key is the one the delete path addresses.
    vector.vectors.set(tenantVectorId(FOUNDER_TENANT_ID, staleId), {
      values: new Array(1536).fill(0.42),
      namespace: FOUNDER_TENANT_ID,
      metadata: { url, title: "Old stale vector" },
    });
    await reader.appendOrReplaceListIndexItem({
      id: staleId,
      key_prefix: stalePrefix,
      url,
      status: "pending",
      created_at: staleCreatedAt,
      updated_at: staleCreatedAt,
    });
    const staleJob: ProcessReadingArgs = {
      id: staleId,
      url,
      urlHash,
      createdAt: staleCreatedAt,
      keyPrefix: stalePrefix,
      trigger: "submit",
    };
    await reserveReadingSlot(env, founderTenant(), staleJob);
    await processReading(staleJob, env as unknown as Env, services, founderTenant());

    await expect(reader.readByUrlPointer(urlHash)).resolves.toEqual({
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });
    await expect(reader.readManifest(stalePrefix)).resolves.toMatchObject({
      id: staleId,
      status: "ready",
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({ items: [] });
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(vector.deleteByIds).toHaveBeenCalledWith([tenantVectorId(FOUNDER_TENANT_ID, staleId)]);
    expect(vector.vectors.has(tenantVectorId(FOUNDER_TENANT_ID, staleId))).toBe(false);
  });

  it("does not let a stale successful attempt overwrite a newer attempt for the same reading", async () => {
    const services = makeServices(makeStubFetch());
    const vector = installVectorizeStub();
    const reader = rowStore();
    const url = "https://example.com/stale-same-reading-success";
    const urlHash = await sha256Hex(url);
    const id = "rd_SAME_READING";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const newerPending: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_NEW",
        trigger: "submit",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T19:30:00.000Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: "2026-04-26T19:30:00.000Z",
    };
    vector.vectors.set(id, {
      values: new Array(1536).fill(0.24),
      metadata: { url, title: "Existing vector" },
    });
    await reader.writeManifest(keyPrefix, newerPending);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(newerPending, keyPrefix));

    await processReading(
      {
        id,
        url,
        urlHash,
        createdAt,
        keyPrefix,
        attemptId: "at_OLD",
        attemptStartedAt: "2026-04-26T19:00:00.000Z",
        trigger: "submit",
      },
      env as unknown as Env,
      services,
      founderTenant(),
    );

    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id,
      status: "pending",
      active_attempt: { id: "at_NEW" },
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({
      items: [{ id, status: "pending", active_attempt: { id: "at_NEW" } }],
    });
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(vector.deleteByIds).not.toHaveBeenCalled();
    expect(vector.vectors.has(id)).toBe(true);
  });

  it("does not let a stale successful attempt overwrite a newer ready reading", async () => {
    const services = makeServices(makeStubFetch());
    const vector = installVectorizeStub();
    const reader = rowStore();
    const url = "https://example.com/stale-after-ready";
    const urlHash = await sha256Hex(url);
    const id = "rd_READY_WINNER";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const ready: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "ready",
      title: "Winning Title",
      tldr: "The newer attempt already won.",
      tags: ["winner"],
      summary_markdown: "Winning summary",
      content_type: "text/html; charset=utf-8",
      content_status: "captured",
      content_bytes: 18,
      extracted_bytes: 18,
      content_sha256: "1".repeat(64),
      fetched_at: "2026-04-26T19:30:00.000Z",
      created_at: createdAt,
      updated_at: "2026-04-26T19:30:00.000Z",
      last_attempt: {
        id: "at_NEW_READY",
        trigger: "submit",
        status: "succeeded",
        stage: "write_indexes",
        started_at: "2026-04-26T19:29:00.000Z",
        finished_at: "2026-04-26T19:30:00.000Z",
      },
    };
    vector.vectors.set(id, {
      values: new Array(1536).fill(0.84),
      metadata: { url, title: "Winning Title" },
    });
    await reader.writeManifest(keyPrefix, ready);
    await reader.writeRaw(
      keyPrefix,
      "html",
      new TextEncoder().encode("winner raw"),
      "text/html; charset=utf-8",
    );
    await reader.writeExtracted(keyPrefix, "winner extracted");
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(ready, keyPrefix));

    await processReading(
      {
        id,
        url,
        urlHash,
        createdAt,
        keyPrefix,
        attemptId: "at_OLD_READY",
        attemptStartedAt: "2026-04-26T19:00:00.000Z",
        trigger: "submit",
      },
      env as unknown as Env,
      services,
      founderTenant(),
    );

    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id,
      status: "ready",
      title: "Winning Title",
      last_attempt: { id: "at_NEW_READY" },
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({
      items: [{ id, status: "ready", title: "Winning Title" }],
    });
    expect(await (await reader.readRaw(keyPrefix, "html"))?.text()).toBe("winner raw");
    expect(await (await reader.readExtracted(keyPrefix))?.text()).toBe("winner extracted");
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(vector.deleteByIds).not.toHaveBeenCalled();
    expect(vector.vectors.has(id)).toBe(true);
  });

  it("does not let a stale failed job publish a newer by-url owner's URL", async () => {
    const services = makeServices(makeStubFetch({ source: { status: 404, body: "not found" } }));
    const reader = rowStore();
    const url = "https://example.com/stale-job-failure";
    const urlHash = await sha256Hex(url);
    const ownerCreatedAt = "2026-04-26T19:59:00.000Z";
    const ownerPrefix = buildKeyPrefix("rd_OWNER", ownerCreatedAt);
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const staleId = "rd_STALE_FAILED";
    const staleCreatedAt = "2026-04-26T19:00:00.000Z";
    const stalePrefix = buildKeyPrefix(staleId, staleCreatedAt);
    await reader.appendOrReplaceListIndexItem({
      id: staleId,
      key_prefix: stalePrefix,
      url,
      status: "pending",
      created_at: staleCreatedAt,
      updated_at: staleCreatedAt,
    });
    await processReading(
      {
        id: staleId,
        url,
        urlHash,
        createdAt: staleCreatedAt,
        keyPrefix: stalePrefix,
        trigger: "submit",
      },
      env as unknown as Env,
      services,
      founderTenant(),
    );

    await expect(reader.readByUrlPointer(urlHash)).resolves.toEqual({
      id: "rd_OWNER",
      key_prefix: ownerPrefix,
    });
    await expect(reader.readManifest(stalePrefix)).resolves.toMatchObject({
      id: staleId,
      status: "failed",
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({ items: [] });
    consoleErr.mockRestore();
  });

  it("does not let a stale failed attempt overwrite a newer attempt for the same reading", async () => {
    const services = makeServices(makeStubFetch({ source: { status: 404, body: "not found" } }));
    const reader = rowStore();
    const url = "https://example.com/stale-same-reading-failure";
    const urlHash = await sha256Hex(url);
    const id = "rd_SAME_READING_FAILED";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const newerPending: Manifest = {
      id,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_NEW_FAILED",
        trigger: "submit",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T19:30:00.000Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: "2026-04-26T19:30:00.000Z",
    };
    await reader.writeManifest(keyPrefix, newerPending);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(newerPending, keyPrefix));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await processReading(
      {
        id,
        url,
        urlHash,
        createdAt,
        keyPrefix,
        attemptId: "at_OLD_FAILED",
        attemptStartedAt: "2026-04-26T19:00:00.000Z",
        trigger: "submit",
      },
      env as unknown as Env,
      services,
      founderTenant(),
    );

    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id,
      status: "pending",
      active_attempt: { id: "at_NEW_FAILED" },
    });
    await expect(reader.readListIndex()).resolves.toMatchObject({
      items: [{ id, status: "pending", active_attempt: { id: "at_NEW_FAILED" } }],
    });
    expect(consoleErr).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("marks a claimed submit retryable when setup fails before queueing", async () => {
    const idCounter = { n: 0 };
    const fixedId = "rd_0123456781";
    const services = makeServices(makeStubFetch(), idCounter);
    services.newId = () => fixedId;
    const app = createApp({ services });
    const reader = rowStore();
    const url = "https://example.com/setup-fails-after-claim";
    const urlHash = await sha256Hex(url);
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(fixedId, createdAt);
    const byIdKey = founderObjectKey(`index/by-id/${fixedId}`);
    const originalPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let failedByIdWrite = false;
    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put").mockImplementation(
      (async (key: string, value: unknown, options?: R2PutOptions) => {
        if (key === byIdKey && !failedByIdWrite) {
          failedByIdWrite = true;
          throw new Error("simulated setup failure");
        }
        return originalPut(key, value as Parameters<R2Bucket["put"]>[1], options);
      }) as R2Bucket["put"],
    );
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      },
      env,
    );
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "reading setup failed", id: fixedId });
    expect(queuedJobs).toHaveLength(0);
    await expect(reader.readByUrlPointer(urlHash)).resolves.toEqual({
      id: fixedId,
      key_prefix: keyPrefix,
    });
    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id: fixedId,
      status: "failed",
      error: { retryable: true },
    });

    putSpy.mockRestore();
    consoleErr.mockRestore();
    const retry = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      },
      env,
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: fixedId, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: fixedId, trigger: "reprocess" });
  });

  it("imports Markdown without fetching the source URL", async () => {
    const sourceUrl = "https://x.com/example/status/2047312986696454584";
    const markdown = "# Imported Markdown\n\nThis is already captured local content.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Markdown",
        tldr: "A local Markdown article was imported.",
        tags: ["markdown"],
        keywords: ["local markdown", "manual import", "captured content"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Imported summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Imported Markdown",
          markdown,
        }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    expect(queuedJobs[0]).toMatchObject({
      url: sourceUrl,
      trigger: "import",
      email: false,
      source: { kind: "markdown", title: "Imported Markdown", markdown },
    });

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const { id } = (await submit.clone().json()) as { id: string };
    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as {
      status: string;
      source_type?: string;
      content_type: string;
      title?: string;
      last_attempt?: { trigger: string };
    };
    expect(manifest).toMatchObject({
      status: "ready",
      source_type: "markdown",
      content_type: "text/markdown; charset=utf-8",
      title: "Imported Markdown",
      last_attempt: { trigger: "import" },
    });

    const content = await app.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(markdown);

    const diagnostics = await app.request(
      `/api/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diagnosticBody = (await diagnostics.json()) as {
      attempts: Array<{ events: Array<{ stage: string }> }>;
    };
    const stages = diagnosticBody.attempts[0]!.events.map((event) => event.stage);
    expect(stages).toContain("prepare_markdown");
    expect(stages).not.toContain("fetch_source");

    const calledUrls = fetchFn.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    expect(calledUrls).not.toContain(sourceUrl);
    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("marks a claimed Markdown import retryable when setup fails before queueing", async () => {
    const idCounter = { n: 0 };
    const fixedId = "rd_0123456782";
    const services = makeServices(makeStubFetch(), idCounter);
    services.newId = () => fixedId;
    const app = createApp({ services });
    const reader = rowStore();
    const sourceUrl = "https://example.com/import-setup-fails-after-claim";
    const markdown = "# Setup Failure\n\nRetry me immediately.";
    const urlHash = await sha256Hex(sourceUrl);
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(fixedId, createdAt);
    const rawKey = founderObjectKey(`${keyPrefix}/raw.md`);
    const originalPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let failedRawWrite = false;
    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put").mockImplementation(
      (async (key: string, value: unknown, options?: R2PutOptions) => {
        if (key === rawKey && !failedRawWrite) {
          failedRawWrite = true;
          throw new Error("simulated markdown setup failure");
        }
        return originalPut(key, value as Parameters<R2Bucket["put"]>[1], options);
      }) as R2Bucket["put"],
    );
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await app.request(
      "/api/readings/import-markdown",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Setup Failure",
          markdown,
        }),
      },
      env,
    );
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "reading setup failed", id: fixedId });
    expect(queuedJobs).toHaveLength(0);
    await expect(reader.readByUrlPointer(urlHash)).resolves.toEqual({ id: fixedId, key_prefix: keyPrefix });
    await expect(reader.readManifest(keyPrefix)).resolves.toMatchObject({
      id: fixedId,
      status: "failed",
      source_type: "markdown",
      error: { retryable: true },
    });

    putSpy.mockRestore();
    consoleErr.mockRestore();
    const retry = await app.request(
      "/api/readings/import-markdown",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Setup Failure",
          markdown,
        }),
      },
      env,
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: fixedId, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: fixedId,
      trigger: "import",
      source: { kind: "markdown", markdown, title: "Setup Failure" },
    });
  });

  it("deduplicates Markdown imports for the same source URL while pending", async () => {
    const sourceUrl = "https://example.com/import-markdown-pending-dedupe";
    const markdown = "# Pending Import\n\nThis import has not been processed yet.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    const first = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Pending Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );
    const firstBody = (await first.json()) as { id: string; status: string };

    const second = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Pending Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );
    const secondBody = (await second.json()) as { id: string; status: string };

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ id: firstBody.id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id: firstBody.id, trigger: "import" });
  });

  it("imports Markdown over a failed URL reading for the same source URL", async () => {
    const sourceUrl = "https://example.com/failed-then-imported-markdown";
    const markdown = "# Imported Recovery\n\nThe user supplied the captured text.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Recovery",
        tldr: "A failed URL was recovered with markdown.",
        tags: ["markdown"],
        keywords: ["markdown recovery", "failed reading", "manual import"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Recovered summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const reader = rowStore();
    const urlHash = await sha256Hex(sourceUrl);
    const failed: Manifest = {
      id: "rd_0123456783",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(failed.id, failed.created_at);
    await reader.writeManifest(keyPrefix, failed);
    await reader.writeByIdPointer(failed.id, { id: failed.id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id: failed.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(failed, keyPrefix));

    const submit = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Imported Recovery",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.clone().json()).toMatchObject({
      id: failed.id,
      status: "pending",
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: failed.id,
      trigger: "import",
      source: { kind: "markdown", title: "Imported Recovery", markdown },
    });

    await drainQueue(services);

    const get = await app.request(
      `/api/readings/${failed.id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      id: failed.id,
      status: "ready",
      source_type: "markdown",
      title: "Imported Recovery",
      last_attempt: { trigger: "import" },
    });

    const content = await app.request(
      `/api/readings/${failed.id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(markdown);
  });

  it("keeps markdown import retryable when queue send fails", async () => {
    const sourceUrl = "https://example.com/import-queue-send-fails";
    const markdown = "# Retryable Import\n\nThe markdown body should survive queue failure.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const urlHash = await sha256Hex(sourceUrl);
    const failed: Manifest = {
      id: "rd_IMPORT_QUEUE_FAIL",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(failed.id, failed.created_at);
    await reader.writeManifest(keyPrefix, failed);
    await reader.writeByIdPointer(failed.id, { id: failed.id, key_prefix: keyPrefix });
    await reader.writeByUrlPointer(urlHash, { id: failed.id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(failed, keyPrefix));
    installRejectingQueueStub();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const importAttempt = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Retryable Import",
          markdown,
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(importAttempt.status).toBe(503);
    const extracted = await reader.readExtracted(keyPrefix);
    expect(await extracted?.text()).toBe(markdown);

    installQueueStub();
    const retry = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: failed.id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: failed.id,
      trigger: "reprocess",
      source: { kind: "markdown", title: "Retryable Import", markdown },
    });
    consoleErr.mockRestore();
  });

  it("imports Markdown over a stale pending URL reading for the same source URL", async () => {
    const sourceUrl = "https://example.com/stale-pending-then-imported-markdown";
    const markdown = "# Imported Stale Pending\n\nThe user supplied the captured text.";
    const fetchFn = makeStubFetch({
      toolInput: {
        title: "Imported Stale Pending",
        tldr: "A stale pending URL was recovered with markdown.",
        tags: ["markdown"],
        keywords: ["markdown recovery", "failed reading", "manual import"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "Recovered summary",
      },
    });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const reader = rowStore();
    const urlHash = await sha256Hex(sourceUrl);
    const stalePending: Manifest = {
      id: "rd_STALE_IMPORT",
      url: sourceUrl,
      url_hash: urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_STALE",
        trigger: "submit",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T18:00:00.000Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T18:00:00.000Z",
      updated_at: "2026-04-26T18:00:00.000Z",
    };
    const keyPrefix = buildKeyPrefix(stalePending.id, stalePending.created_at);
    await reader.writeManifest(keyPrefix, stalePending);
    await reader.writeByIdPointer(stalePending.id, {
      id: stalePending.id,
      key_prefix: keyPrefix,
    });
    await reader.writeByUrlPointer(urlHash, {
      id: stalePending.id,
      key_prefix: keyPrefix,
    });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(stalePending, keyPrefix));

    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const submit = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source_url: sourceUrl,
          title: "Imported Stale Pending",
          markdown,
        }),
      }),
      customEnv,
      createExecutionContext(),
    );

    expect(submit.status).toBe(202);
    expect(await submit.json()).toMatchObject({
      id: stalePending.id,
      status: "pending",
    });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id: stalePending.id,
      trigger: "import",
      source: { kind: "markdown", title: "Imported Stale Pending", markdown },
    });
  });

  it("failure path: source returns 404 -> manifest ends failed with by-url ownership, error logged", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/missing" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(get.status).toBe(200);
    const manifest = (await get.json()) as Record<string, unknown>;
    expect(manifest.status).toBe("failed");
    expect(manifest.error).toMatchObject({ code: "BadStatusError" });

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent("https://example.com/missing")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id });

    // The background failure should be logged for the operator (wrangler tail),
    // not silently swallowed.
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("rejects an invalid url body", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "not a url" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("writes one attempt object per stage (not one per started/succeeded event) on a successful run", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put");

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/attempt-writes" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const attemptPuts = putSpy.mock.calls.filter(([key]) =>
      typeof key === "string" && key.includes("/attempts/"),
    ).length;
    // Initial queued + 10 stages (write_extracted included for HTML) + final
    // post-success write = 12. Pre-fix this was ~22 (started + finished per
    // stage). The exact upper bound below guards against regressing back to
    // started+finished writes for every stage.
    expect(attemptPuts).toBeLessThanOrEqual(13);

    // Diagnostic visibility must survive the de-amplification: the persisted
    // attempt's events list still has both started and succeeded entries per
    // stage so we can reason about timings during failure post-mortems.
    const diag = await app.request(
      `/api/readings/${((await submit.json()) as { id: string }).id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(diag.status).toBe(200);
    const body = (await diag.json()) as {
      attempts: Array<{ events: Array<{ stage: string; status: string }> }>;
    };
    const events = body.attempts[0]!.events;
    expect(events.some((e) => e.stage === "summarize" && e.status === "started")).toBe(true);
    expect(events.some((e) => e.stage === "summarize" && e.status === "succeeded")).toBe(true);

    putSpy.mockRestore();
  });

  it("returns 503 from POST /api/readings when the queue binding is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    (env as unknown as { READING_JOBS?: Queue<ProcessReadingEnvelopeV1> }).READING_JOBS =
      undefined;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/no-queue" }),
      }),
      env,
      createExecutionContext(),
    );
    expect(submit.status).toBe(503);
    const body = (await submit.json()) as { error: string };
    expect(body.error).toMatch(/queue/i);
    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent("https://example.com/no-queue")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(404);
    consoleErr.mockRestore();
  });

  it("marks a submit as retryable failed when queue send rejects after the pending write", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const url = "https://example.com/queue-send-reject";
    installRejectingQueueStub();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );

    expect(submit.status).toBe(503);
    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(200);
    const { id } = (await lookup.json()) as { id: string };
    const failed = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      id,
      status: "failed",
      error: { code: "QueueSendError", retryable: true },
    });

    installQueueStub();
    const retry = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id, status: "pending" });
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "reprocess" });
    consoleErr.mockRestore();
  });

  it("marks a failed reading retryable failed when reprocess queue send rejects", async () => {
    const idCounter = { n: 0 };
    const failingServices = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const failingApp = createApp({ services: failingServices });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await failingApp.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/reprocess-send-reject-failed" }),
      }),
      env,
      createExecutionContext(),
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(failingServices);

    installRejectingQueueStub();
    const retryingServices = makeServices(makeStubFetch(), idCounter);
    const retryingApp = createApp({ services: retryingServices });
    const retry = await retryingApp.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(503);
    const get = await retryingApp.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const failed = (await get.json()) as Record<string, unknown>;
    expect(failed.active_attempt).toBeUndefined();
    expect(failed).toMatchObject({
      id,
      status: "failed",
      last_attempt: { status: "failed", error: { code: "QueueSendError", retryable: true } },
      error: { code: "QueueSendError", retryable: true },
    });
    consoleErr.mockRestore();
  });

  it("keeps a ready reading ready when reprocess queue send rejects", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/reprocess-send-reject-ready" }),
      }),
      env,
      createExecutionContext(),
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);

    installRejectingQueueStub();
    const retry = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(503);
    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const ready = (await get.json()) as Record<string, unknown>;
    expect(ready.active_attempt).toBeUndefined();
    expect(ready).toMatchObject({
      id,
      status: "ready",
      title: "Test Article",
      last_attempt: { status: "failed", error: { code: "QueueSendError", retryable: true } },
    });
    consoleErr.mockRestore();
  });

  it("returns 503 from reprocess when the queue binding is missing", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/will-reprocess" }),
      }),
      env,
      createExecutionContext(),
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);

    (env as unknown as { READING_JOBS?: Queue<ProcessReadingEnvelopeV1> }).READING_JOBS =
      undefined;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const retry = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(503);
    const body = (await retry.json()) as { error: string };
    expect(body.error).toMatch(/queue/i);
    consoleErr.mockRestore();
  });

  it("diagnostics returns attempt history and object inventory for a failure", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/missing" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const res = await app.request(
      `/api/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const diagnostics = (await res.json()) as {
      attempts: Array<{ status: string; error?: { stage?: string } }>;
      pointers: { by_url: { exists: boolean } };
      objects: Array<{ key: string }>;
    };
    expect(diagnostics.attempts[0]!.status).toBe("failed");
    expect(diagnostics.attempts[0]!.error?.stage).toBe("fetch_source");
    expect(diagnostics.pointers.by_url.exists).toBe(true);
    expect(diagnostics.objects.some((o) => o.key.includes("/attempts/at_"))).toBe(true);
    consoleErr.mockRestore();
  });

  it("reprocesses a failed reading in-place and updates it to ready", async () => {
    const idCounter = { n: 0 };
    const failingServices = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const failingApp = createApp({ services: failingServices });
    const ctx1 = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await failingApp.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/retry-me" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(failingServices);
    await waitOnExecutionContext(ctx1);

    const succeedingServices = makeServices(makeStubFetch(), idCounter);
    const succeedingApp = createApp({ services: succeedingServices });
    const ctx2 = createExecutionContext();
    const retry = await succeedingApp.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    const retryJson = (await retry.json()) as { id: string; attempt_id: string };
    expect(retryJson.id).toBe(id);
    expect(retryJson.attempt_id).toMatch(/^at_/);
    await drainQueue(succeedingServices);
    await waitOnExecutionContext(ctx2);

    const get = await succeedingApp.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { id: string; status: string; title?: string; last_attempt?: { trigger: string; status: string } };
    expect(manifest.id).toBe(id);
    expect(manifest.status).toBe("ready");
    expect(manifest.title).toBe("Test Article");
    expect(manifest.last_attempt).toMatchObject({ trigger: "reprocess", status: "succeeded" });
    consoleErr.mockRestore();
  });

  it("preserves a ready manifest when reprocess fails", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter);
    const app = createApp({ services });
    const ctx1 = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/stays-ready" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    const failingServices = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const failingApp = createApp({ services: failingServices });
    const ctx2 = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = await failingApp.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    await drainQueue(failingServices);
    await waitOnExecutionContext(ctx2);

    const get = await failingApp.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { status: string; title?: string; last_attempt?: { status: string; error?: { stage?: string } } };
    expect(manifest.status).toBe("ready");
    expect(manifest.title).toBe("Test Article");
    expect(manifest.last_attempt?.status).toBe("failed");
    expect(manifest.last_attempt?.error?.stage).toBe("fetch_source");
    consoleErr.mockRestore();
  });

  it("rejects malformed and null reprocess bodies before enqueueing work", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });

    const malformed = await app.request(
      "/api/readings/rd_missing/reprocess",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(malformed.status).toBe(400);

    const nullBody = await app.request(
      "/api/readings/rd_missing/reprocess",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "null",
      },
      env,
    );
    expect(nullBody.status).toBe(400);
  });

  it("allows reprocess when a running active attempt is stale", async () => {
    const reader = rowStore();
    const createdAt = "2026-04-26T18:00:00.000Z";
    const prefix = buildKeyPrefix("rd_STALE_ACTIVE", createdAt);
    const staleReady: Manifest = {
      id: "rd_STALE_ACTIVE",
      url: "https://example.com/stale-active",
      url_hash: "c".repeat(64),
      status: "ready",
      title: "Existing Ready",
      tldr: "Existing summary.",
      tags: ["ops"],
      keywords: ["existing summary", "ready reading", "reprocess flow"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "Existing summary.",
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "d".repeat(64),
      fetched_at: "2026-04-26T18:00:01.000Z",
      created_at: createdAt,
      updated_at: "2026-04-26T18:00:02.000Z",
      active_attempt: {
        id: "at_stale",
        trigger: "reprocess",
        status: "running",
        stage: "summarize",
        started_at: "2026-04-26T19:00:00.000Z",
      },
    };
    await reader.writeManifest(prefix, staleReady);
    await reader.writeByIdPointer(staleReady.id, { id: staleReady.id, key_prefix: prefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(staleReady, prefix));

    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter, "2026-04-26T20:00:00.000Z");
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/api/readings/${staleReady.id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx,
    );

    expect(retry.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
  });

  it("a burst of 5 simultaneous submits all enqueue and drain to ready", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.fetch(
          new Request("http://t/api/readings", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ url: `https://example.com/burst-${i}` }),
          }),
          env,
          ctx,
        ),
      ),
    );
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(queuedJobs.length).toBe(5);

    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const list = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ status: string; url: string }> };
    expect(body.readings).toHaveLength(5);
    expect(body.readings.every((r) => r.status === "ready")).toBe(true);
  });
});

// A legacy failed reading (one written before by-url ownership) is recovered
// the same way whichever write path finds it: the request lands on the legacy
// id, the by-url pointer is rewritten to it, and one job is queued. Only the
// request shape and the queued trigger differ between the two routes.
const LEGACY_MARKDOWN = "# Legacy Import\n\nThe user supplied text for an old failed URL.";

describe("submit-time safe-url guard", () => {
  const CREDS_URL = "https://user:secretpass@example.com/creds";

  it("returns 400 unsupported_url for a userinfo url without claiming the slot", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: CREDS_URL }),
      }),
      env,
      ctx,
    );

    expect(submit.status).toBe(400);
    expect(await submit.json()).toMatchObject({
      error: expect.stringContaining("userinfo"),
      code: "unsupported_url",
    });
    expect(queuedJobs).toHaveLength(0);

    const lookup = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(CREDS_URL)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(lookup.status).toBe(404);
    await waitOnExecutionContext(ctx);
  });

  it("returns 400 unsupported_url for a loopback literal host", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1/admin" }),
      }),
      env,
      ctx,
    );

    expect(submit.status).toBe(400);
    expect(await submit.json()).toMatchObject({ code: "unsupported_url" });
    expect(queuedJobs).toHaveLength(0);
    await waitOnExecutionContext(ctx);
  });

  it("returns 400 for a URL-backed reprocess of a ready userinfo reading and leaves it ready", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const urlHash = await sha256Hex(CREDS_URL);
    const createdAt = "2026-04-26T19:00:00.000Z";
    const id = "rd_CREDS_READY";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const ready: Manifest = {
      id,
      url: CREDS_URL,
      url_hash: urlHash,
      source_type: "url",
      status: "ready",
      content_type: "text/html; charset=utf-8",
      content_status: "captured",
      content_bytes: 10,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await reader.writeManifest(keyPrefix, ready);
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(ready, keyPrefix));

    const retry = await app.request(
      `/api/readings/${id}/reprocess`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
      createExecutionContext(),
    );

    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ code: "unsupported_url" });
    expect(queuedJobs).toHaveLength(0);

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ id, status: "ready" });
  });

  it("still accepts import-markdown with a userinfo source_url because it is identity only", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const imported = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source_url: CREDS_URL, markdown: "# Imported\n\nbody" }),
      }),
      env,
      ctx,
    );

    expect(imported.status).toBe(202);
    expect(queuedJobs).toHaveLength(1);
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const { id } = (await imported.json()) as { id: string };
    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ url: CREDS_URL, status: "ready" });

    // The import owns the by-url slot; resubmitting the same userinfo URL
    // returns the existing manifest (200), not a 400.
    const resubmit = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: CREDS_URL }),
      },
      env,
      createExecutionContext(),
    );
    expect(resubmit.status).toBe(200);
    expect(await resubmit.json()).toMatchObject({ id, url: CREDS_URL, status: "ready" });
    expect(queuedJobs).toHaveLength(0);
  });
});

describe("POST /api/readings/:id/reprocess — markdown source", () => {
  const AGENT_MARKDOWN = "# Agent Extraction\n\nThe local agent captured the full article text.";

  it("reprocesses a ready url reading with supplied markdown and flips it to a markdown source", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx1 = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/agent-upgrade" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);
    await expect(
      rowStore().loadReadingById(id).then((f) => f!.manifest.source_type),
    ).resolves.toBe("url");

    const ctx2 = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source: { kind: "markdown", markdown: AGENT_MARKDOWN, title: "Agent Extraction" },
        }),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);

    // Asserted before the drain: the queued job carries the supplied text, and
    // the ready manifest is still preserved across the attempt.
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      id,
      trigger: "reprocess",
      source: { kind: "markdown", markdown: AGENT_MARKDOWN, title: "Agent Extraction" },
    });
    expect(queuedJobs[0]!.preserveReadyManifest).toMatchObject({ id, status: "ready" });

    await drainQueue(services);
    await waitOnExecutionContext(ctx2);

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ id, status: "ready", source_type: "markdown" });

    const content = await app.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(AGENT_MARKDOWN);

    // Deliberate consequence of the flip: a later reprocess with no source
    // reuses the stored markdown instead of re-fetching the degraded URL.
    const ctx3 = createExecutionContext();
    const again = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx3,
    );
    expect(again.status).toBe(202);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]!.source).toMatchObject({ kind: "markdown", markdown: AGENT_MARKDOWN });

    await drainQueue(services);
    await waitOnExecutionContext(ctx3);
  });

  it("recovers a failed reading from supplied markdown without disturbing by-url ownership", async () => {
    const url = "https://example.com/agent-recovers-failed";
    const idCounter = { n: 0 };
    // The same fetch stub stays 404 on the source for the whole test: a supplied
    // markdown source must never re-fetch the URL that failed.
    const services = makeServices(
      makeStubFetch({ source: { status: 404, body: "not found" } }),
      idCounter,
    );
    const app = createApp({ services });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx1 = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "markdown", markdown: AGENT_MARKDOWN } }),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    await drainQueue(services);
    await waitOnExecutionContext(ctx2);
    consoleErr.mockRestore();

    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({ id, status: "ready", source_type: "markdown" });

    // by-url ownership is untouched: resubmitting the URL resolves to the same
    // reading rather than minting a duplicate.
    const resubmit = await app.request(
      "/api/readings",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      },
      env,
    );
    expect(resubmit.status).toBe(200);
    expect(await resubmit.json()).toMatchObject({ id, status: "ready" });
    expect(queuedJobs).toHaveLength(0);
  });

  it("rejects a markdown-source reprocess while another attempt is active", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/agent-active-attempt" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };

    // Deliberately not drained: the submit attempt is still running, so the
    // guard must fire before the supplied source is considered.
    const retry = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "markdown", markdown: AGENT_MARKDOWN } }),
      }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(409);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ id, trigger: "submit" });

    // force is orthogonal to source: it bypasses the same guard and still
    // carries the supplied markdown.
    const forced = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          force: true,
          source: { kind: "markdown", markdown: AGENT_MARKDOWN },
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(forced.status).toBe(202);
    expect(queuedJobs).toHaveLength(2);
    expect(queuedJobs[1]).toMatchObject({
      id,
      trigger: "reprocess",
      source: { kind: "markdown", markdown: AGENT_MARKDOWN },
    });

    await drainQueue(services);
    await waitOnExecutionContext(ctx);
  });

  it("reprocesses from a supplied source without reading the stored markdown", async () => {
    const url = "https://example.com/agent-supplies-missing-markdown";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const ctx1 = createExecutionContext();
    const imported = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source_url: url, title: "Imported", markdown: "# Imported\n\nOld." }),
      }),
      env,
      ctx1,
    );
    const { id } = (await imported.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    // Strip the stored markdown out from under the reading. A no-source
    // reprocess now has nothing to synthesize from and must 409...
    const { keyPrefix } = (await reader.loadReadingById(id))!;
    await env.READINGS_BUCKET.delete(founderObjectKey(`${keyPrefix}/extracted.md`));
    const withoutSource = await app.request(
      `/api/readings/${id}/reprocess`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(withoutSource.status).toBe(409);
    expect(await withoutSource.json()).toEqual({ error: "markdown content not available" });
    expect(queuedJobs).toHaveLength(0);

    // ...while a supplied source never consults extracted.md at all, which is
    // also the escape hatch out of that 409.
    const ctx2 = createExecutionContext();
    const withSource = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "markdown", markdown: AGENT_MARKDOWN } }),
      }),
      env,
      ctx2,
    );
    expect(withSource.status).toBe(202);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]!.source).toMatchObject({ kind: "markdown", markdown: AGENT_MARKDOWN });

    await drainQueue(services);
    await waitOnExecutionContext(ctx2);
    const content = await app.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(AGENT_MARKDOWN);
  });

  it("keeps the preserved ready manifest, and its source_type, when a markdown reprocess fails", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter);
    const app = createApp({ services });
    const ctx1 = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/agent-upgrade-fails" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    // Summarization fails on the reprocess attempt. A markdown source never
    // fetches the URL, so the failure has to come from the summarizer.
    const base = makeStubFetch();
    const failingFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.openai.com/v1/responses")) {
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return base(input, init);
    });
    const failingServices = makeServices(failingFetch, idCounter);
    const failingApp = createApp({ services: failingServices });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx2 = createExecutionContext();
    const retry = await failingApp.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "markdown", markdown: AGENT_MARKDOWN } }),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    expect(queuedJobs[0]).toMatchObject({
      source: { kind: "markdown", markdown: AGENT_MARKDOWN },
      preserveReadyManifest: { id, status: "ready" },
    });
    await drainQueue(failingServices);
    await waitOnExecutionContext(ctx2);
    consoleErr.mockRestore();

    // The preserve-ready rollback wins: the flip to markdown only lands on a
    // successful terminal write, so this reading is still url-sourced.
    const get = await failingApp.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await get.json()).toMatchObject({
      id,
      status: "ready",
      source_type: "url",
      title: "Test Article",
      last_attempt: { trigger: "reprocess", status: "failed" },
    });

    // KNOWN DIVERGENCE (reading-lite-psu): write_extracted already replaced
    // extracted.md before summarization failed, and the preserve-ready rollback
    // restores only the manifest. So /content serves the failed attempt's
    // markdown under a manifest whose hash and byte counts describe the old
    // text. Characterized here so the divergence is visible rather than silent;
    // this assertion flips when psu is fixed in process-reading.ts.
    const content = await failingApp.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(AGENT_MARKDOWN);
  });

  it("retains the url source after a supplied-source attempt dies before write_extracted", async () => {
    const idCounter = { n: 0 };
    const base = makeStubFetch();
    const noSummaryFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.openai.com/v1/responses")) {
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return base(input, init);
    });
    const services = makeServices(noSummaryFetch, idCounter);
    const app = createApp({ services });
    const reader = rowStore();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    // 1. A url reading that extracts fine but fails to summarize: it lands
    //    failed, still source_type "url", with url-derived extracted.md stored.
    const ctx1 = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/agent-stale-extracted" }),
      }),
      env,
      ctx1,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);
    const { keyPrefix } = (await reader.loadReadingById(id))!;
    const urlDerived = await (await reader.readExtracted(keyPrefix))!.text();
    expect(urlDerived).toContain("picked up by readability");
    // 2. A supplied-markdown reprocess whose raw write fails, i.e. it dies
    //    before write_extracted ever runs.
    const originalPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    let failedRawWrite = false;
    const putSpy = vi.spyOn(env.READINGS_BUCKET, "put").mockImplementation(
      (async (key: string, value: unknown, options?: R2PutOptions) => {
        if (key === founderObjectKey(`${keyPrefix}/raw.md`) && !failedRawWrite) {
          failedRawWrite = true;
          throw new Error("simulated raw write failure");
        }
        return originalPut(key, value as Parameters<R2Bucket["put"]>[1], options);
      }) as R2Bucket["put"],
    );
    const ctx2 = createExecutionContext();
    const supplied = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "markdown", markdown: AGENT_MARKDOWN } }),
      }),
      env,
      ctx2,
    );
    expect(supplied.status).toBe(202);
    // Simulate a message enqueued before sourceTypeOnFailure was deployed. The
    // consumer must recover the prior type from this attempt's pending manifest.
    delete queuedJobs[0]!.sourceTypeOnFailure;
    await drainQueue(services);
    await waitOnExecutionContext(ctx2);
    putSpy.mockRestore();
    consoleErr.mockRestore();

    // The supplied markdown was never written, so the failed attempt must not
    // claim that it became the reading's durable source.
    const manifest = (await reader.loadReadingById(id))!.manifest;
    expect(manifest).toMatchObject({ status: "failed", source_type: "url" });
    await expect((await reader.readExtracted(keyPrefix))!.text()).resolves.toBe(urlDerived);

    // A later no-source reprocess therefore fetches the URL again instead of
    // silently synthesizing from the stale extracted.md artifact.
    const again = await app.request(
      `/api/readings/${id}/reprocess`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(again.status).toBe(202);
    expect(queuedJobs[0]!.source).toBeUndefined();
    queuedJobs.length = 0;
  });

  it("treats a legacy missing source_type as url when snapshotting reprocess failure state", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const reader = rowStore();
    const id = "rd_LEGACY_SOURCE_TYPE";
    const url = "https://example.com/legacy-source-type";
    const createdAt = "2026-08-07T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const manifest: Manifest = {
      id,
      url,
      url_hash: await sha256Hex(url),
      status: "failed",
      error: { code: "LegacyError", message: "legacy failure" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await reader.writeManifest(keyPrefix, manifest);
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });

    const response = await app.request(
      `/api/readings/${id}/reprocess`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "markdown", markdown: AGENT_MARKDOWN } }),
      },
      env,
    );

    expect(response.status).toBe(202);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({
      source: { kind: "markdown", markdown: AGENT_MARKDOWN },
      sourceTypeOnFailure: "url",
    });
  });

  it("prefers the supplied markdown over the stored markdown of an imported reading", async () => {
    const url = "https://example.com/agent-replaces-imported-markdown";
    const stored = "# Imported\n\nThe first, thinner capture of this article.";
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const ctx1 = createExecutionContext();
    const imported = await app.fetch(
      new Request("http://t/api/readings/import-markdown", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ source_url: url, title: "Imported", markdown: stored }),
      }),
      env,
      ctx1,
    );
    const { id } = (await imported.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const retry = await app.fetch(
      new Request(`http://t/api/readings/${id}/reprocess`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          source: { kind: "markdown", markdown: AGENT_MARKDOWN, title: "Agent Extraction" },
        }),
      }),
      env,
      ctx2,
    );
    expect(retry.status).toBe(202);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]!.source).toMatchObject({
      kind: "markdown",
      markdown: AGENT_MARKDOWN,
      title: "Agent Extraction",
    });

    await drainQueue(services);
    await waitOnExecutionContext(ctx2);

    const content = await app.request(
      `/api/readings/${id}/content`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(await content.text()).toBe(AGENT_MARKDOWN);
  });
});

describe("POST /api/readings — email notifications", () => {
  it("fires one Resend email by default after a successful submit", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/email-me" }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    const calls = resendCalls(fetchFn);
    expect(calls).toHaveLength(1);
    const init = calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-resend-key");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe("reading-lite@test.example");
    expect(body.to).toBe("founder@test.example");
    expect(body.subject).toBe("Test Article");
    expect(body.html).toContain(`https://reading.test.example/readings/${id}`);
    expect(body.text).toContain("https://example.com/email-me");
    expect(body.text).toContain("A short summary.");

    const diagnostics = await app.request(
      `/api/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      manifest: { status: string };
      attempts: Array<{ events: Array<{ stage: string; status: string }> }>;
    };
    expect(diag.manifest.status).toBe("ready");
    const events = diag.attempts[0]!.events;
    const sendEmail = events.find((e) => e.stage === "send_email");
    expect(sendEmail).toBeDefined();
    expect(sendEmail!.status).toBe("succeeded");
  });

  it("does not fire an email when the submit body sets email:false", async () => {
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();

    await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/silent", email: false }),
      }),
      env,
      ctx,
    );
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("keeps the manifest ready when Resend returns 500 and logs a failed send_email event", async () => {
    const fetchFn = makeStubFetch({ resendStatus: 500, resendBody: { message: "boom" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/resend-down" }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);

    // processReading must NOT throw on email failure; the manifest must remain ready.
    const get = await app.request(
      `/api/readings/${id}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const manifest = (await get.json()) as { status: string };
    expect(manifest.status).toBe("ready");

    const diagnostics = await app.request(
      `/api/readings/${id}/diagnostics`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const diag = (await diagnostics.json()) as {
      attempts: Array<{ status: string; events: Array<{ stage: string; status: string; error?: { code: string } }> }>;
    };
    const attempt = diag.attempts[0]!;
    expect(attempt.status).toBe("succeeded");
    const sendEmail = attempt.events.find((e) => e.stage === "send_email");
    expect(sendEmail).toBeDefined();
    expect(sendEmail!.status).toBe("failed");
    expect(sendEmail!.error?.code).toBe("ResendError");
    consoleErr.mockRestore();
  });
});

describe("POST /api/readings/:id/reprocess — email opt-in", () => {
  async function seedReady(
    services: Services,
    url: string,
    fetchFn: ReturnType<typeof makeStubFetch>,
  ): Promise<string> {
    const app = createApp({ services });
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url, email: false }),
      }),
      env,
      ctx,
    );
    const { id } = (await submit.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    expect(resendCalls(fetchFn)).toHaveLength(0);
    return id;
  }

  it("does not email by default on reprocess (force present, force absent)", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const id = await seedReady(services, "https://example.com/silent-reprocess", fetchFn);

    const app = createApp({ services });
    for (const body of [{}, { force: true }]) {
      const ctx = createExecutionContext();
      const retry = await app.fetch(
        new Request(`http://t/api/readings/${id}/reprocess`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      expect(retry.status).toBe(202);
      await drainQueue(services);
      await waitOnExecutionContext(ctx);
    }
    expect(resendCalls(fetchFn)).toHaveLength(0);
  });

  it("emails on reprocess when body sets email:true, with or without force", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const id = await seedReady(services, "https://example.com/loud-reprocess", fetchFn);

    const app = createApp({ services });
    let sent = 0;
    for (const body of [{ email: true }, { force: true, email: true }]) {
      const ctx = createExecutionContext();
      const retry = await app.fetch(
        new Request(`http://t/api/readings/${id}/reprocess`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      expect(retry.status).toBe(202);
      await drainQueue(services);
      await waitOnExecutionContext(ctx);

      const calls = resendCalls(fetchFn);
      expect(calls).toHaveLength(++sent);
      const mail = JSON.parse(calls[sent - 1]![1]!.body as string) as { subject: string };
      expect(mail.subject).toBe("Test Article");
    }
  });
});

describe("processReading — backwards-compat for in-flight queue messages without `email`", () => {
  it("undefined email + trigger='submit' → fires email", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const reader = rowStore();
    const id = "rd_PRE01";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const prefix = buildKeyPrefix(id, createdAt);
    // Synthesize a pre-deploy queue message: email field absent.
    const args: ProcessReadingArgs = {
      id,
      url: "https://example.com/pre-deploy-submit",
      urlHash: "e".repeat(64),
      createdAt,
      keyPrefix: prefix,
      attemptId: "at_pre01",
      attemptStartedAt: createdAt,
      trigger: "submit",
    };
    await reader.writeManifest(prefix, {
      id,
      url: args.url,
      url_hash: args.urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: prefix });
    await reserveReadingSlot(env, founderTenant(), args);

    await processReading(args, env as unknown as Env, services, founderTenant());

    expect(resendCalls(fetchFn)).toHaveLength(1);
  });

  it("undefined email + trigger='reprocess' → no email", async () => {
    const idCounter = { n: 0 };
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn, idCounter);
    const reader = rowStore();
    const id = "rd_PRE02";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const prefix = buildKeyPrefix(id, createdAt);
    const args: ProcessReadingArgs = {
      id,
      url: "https://example.com/pre-deploy-reprocess",
      urlHash: "f".repeat(64),
      createdAt,
      keyPrefix: prefix,
      attemptId: "at_pre02",
      attemptStartedAt: createdAt,
      trigger: "reprocess",
    };
    await reader.writeManifest(prefix, {
      id,
      url: args.url,
      url_hash: args.urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: prefix });

    await processReading(args, env as unknown as Env, services, founderTenant());

    expect(resendCalls(fetchFn)).toHaveLength(0);
  });
});

describe("GET /api/readings/lookup", () => {
  it("does not repair a stale lookup owner (read-only); leaves the deep scan + repair to the next write", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const reader = rowStore();
    const url = "https://example.com/lookup-legacy-stale-index";
    const urlHash = await sha256Hex(url);
    const indexedUrl = "https://example.com/lookup-other-index-row";
    const legacy: Manifest = {
      id: "rd_LOOKUP_LEGACY",
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const indexed: Manifest = {
      ...legacy,
      id: "rd_LOOKUP_INDEXED_OTHER",
      url: indexedUrl,
      url_hash: await sha256Hex(indexedUrl),
    };
    const legacyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    const indexedPrefix = buildKeyPrefix(indexed.id, indexed.created_at);
    await reader.writeManifest(legacyPrefix, legacy);
    await reader.writeManifest(indexedPrefix, indexed);
    await reader.writeByIdPointer(legacy.id, { id: legacy.id, key_prefix: legacyPrefix });
    await reader.writeByIdPointer(indexed.id, { id: indexed.id, key_prefix: indexedPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(indexed, indexedPrefix));
    const orphan = {
      id: "rd_LOOKUP_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_LOOKUP_ORPHAN",
    };
    await reader.writeByUrlPointer(urlHash, orphan);

    // Even though a recoverable legacy exists, the read-only lookup must not
    // deep-scan the bucket to find it nor rewrite the pointer — that repair is
    // deferred to the next write path (covered by the submit/import repair tests).
    const listSpy = vi.spyOn(env.READINGS_BUCKET, "list");

    const res = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );

    expect(res.status).toBe(404);
    expect(listSpy).not.toHaveBeenCalled(); // no full-bucket deep scan on a GET
    expect(await reader.readByUrlPointer(urlHash)).toEqual(orphan); // pointer untouched
    listSpy.mockRestore();
  });

  it("returns 404 without writing a pointer for a legacy reading that has none", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const reader = rowStore();
    const url = "https://example.com/lookup-legacy-no-pointer";
    const urlHash = await sha256Hex(url);
    const legacy: Manifest = {
      id: "rd_LOOKUP_LEGACY_NP",
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "ready",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T19:00:00.000Z",
      updated_at: "2026-04-26T19:00:00.000Z",
    };
    const legacyPrefix = buildKeyPrefix(legacy.id, legacy.created_at);
    await reader.writeManifest(legacyPrefix, legacy);
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(legacy, legacyPrefix));

    const res = await app.request(
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );

    // A lookup never claims a cold legacy — no live pointer means "not found",
    // and the GET must not write a by-url pointer as a side effect.
    expect(res.status).toBe(404);
    expect(await reader.readByUrlPointer(urlHash)).toBeNull();
  });
});

describe("POST /api/readings/similar", () => {
  it("returns only the caller's neighbours when two tenants store identical vectors", async () => {
    await insertSecondTenant(env as unknown as Env);
    const stub = installVectorizeStub();
    const embedding = new Array(1536).fill(0.1);
    for (const [tenant, id] of [[FOUNDER_TENANT_ID, "rd_founder"], [OTHER_TENANT_ID, "rd_other"]]) {
      stub.vectors.set(tenantVectorId(tenant!, id!), {
        values: embedding, namespace: tenant,
        metadata: { url: `https://example.com/${id}`, title: id!, created_at: "2026-04-25T00:00:00.000Z" },
      });
    }
    const before = structuredClone([...stub.vectors]);
    const app = createApp({ services: makeServices(makeStubFetch()) });
    for (const [token, id] of [[TOKEN, "rd_founder"], [OTHER_TOKEN_SECRET, "rd_other"]]) {
      const response = await apiRequest(app, token!, "/api/readings/similar", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query_embedding: embedding, k: 20 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { items: { id: string; url: string }[] };
      expect(body.items.map(item => [item.id, item.url])).toEqual([[id, `https://example.com/${id}`]]);
    }
    expect([...stub.vectors]).toEqual(before);
    expect(stub.upsert).not.toHaveBeenCalled();
    expect(stub.deleteByIds).not.toHaveBeenCalled();
    expect(queuedEnvelopes).toEqual([]);
  });

  it("returns an empty result set when the Vectorize binding is absent (local dev)", async () => {
    // `wrangler dev` runs without a READINGS_INDEX binding (no local emulator).
    // The route must degrade to empty results, not throw a 500.
    delete (env as unknown as { READINGS_INDEX?: VectorizeIndex }).READINGS_INDEX;
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings/similar",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ query_embedding: new Array(1536).fill(0.1), k: 5 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: unknown[] };
    expect(json.items).toEqual([]);
  });
});

describe("GET /api/readings — list with q, tag, offset, limit", () => {
  async function postOne(
    app: ReturnType<typeof createApp>,
    url: string,
    services: Services,
  ): Promise<string> {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string };
    await drainQueue(services);
    await waitOnExecutionContext(ctx);
    return json.id;
  }

  it("returns the new response shape {readings, limit, offset, has_more}", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ readings: [], limit: 20, offset: 0, has_more: false });
  });

  it("failure path: index entry ends up failed", async () => {
    const fetchFn = makeStubFetch({ source: { status: 404, body: "not found" } });
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    await postOne(app, "https://example.com/missing", services);

    const list = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("failed");
    expect(body.readings[0]!.error?.code).toBe("BadStatusError");
  });

  it("Reddit URLs fail with RedditManualImportError (worker can't fetch; use the local skill)", async () => {
    // The default source stub is never hit: the extractor throws on the Reddit
    // URL before any fetch, so the reading lands failed with a guiding error
    // rather than capturing a bot-challenge page.
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    const app = createApp({ services });
    await postOne(app, "https://www.reddit.com/r/golang/comments/d0zpsh/title/", services);

    const list = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await list.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("failed");
    expect(body.readings[0]!.error?.code).toBe("RedditManualImportError");
  });

  it("?q= filters across title, tldr, url (case-insensitive substring)", async () => {
    const idCounter = { n: 0 };
    const services = makeServices(
      makeStubFetch({
        toolInput: {
          title: "Rust async story",
          tldr: "How async works in Rust",
          tags: ["rust", "async"],
          keywords: ["rust async", "async programming", "systems language"],
          people: [],
          orgs: [],
          novelty_verdict: "novel",
          connections: [],
          summary_markdown: "summary body",
        },
      }),
      idCounter,
    );
    const app = createApp({ services });
    await postOne(app, "https://example.com/rust", services);

    // Submit a second reading with different content via a fresh stub.
    const services2 = makeServices(
      makeStubFetch({
        toolInput: {
          title: "Go concurrency",
          tldr: "Goroutines",
          tags: ["go"],
          keywords: ["go concurrency", "goroutines", "systems language"],
          people: [],
          orgs: [],
          novelty_verdict: "novel",
          connections: [],
          summary_markdown: "summary body",
        },
      }),
      idCounter,
    );
    const app2 = createApp({ services: services2 });
    await postOne(app2, "https://example.com/go", services2);

    const services3 = makeServices(
      makeStubFetch({
        toolInput: {
          title: "Do Not Sell the Whole Ticket at Once",
          tldr: "Small commitments rather than one attempt to win the whole project.",
          tags: ["sales", "career"],
          keywords: ["micro-sales", "soft skills", "stakeholder buy-in"],
          people: [],
          orgs: [],
          novelty_verdict: "novel",
          connections: [],
          summary_markdown: "summary body",
        },
      }),
      idCounter,
    );
    const app3 = createApp({ services: services3 });
    await postOne(app3, "https://example.com/ticket", services3);

    const res = await app.request(
      "/api/readings?q=rust",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await res.json()) as { readings: Array<{ url: string }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.url).toBe("https://example.com/rust");

    const byKeyword = await app.request(
      "/api/readings?q=soft+skills",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const keywordBody = (await byKeyword.json()) as { readings: Array<{ url: string }> };
    expect(keywordBody.readings.map((r) => r.url)).toEqual(["https://example.com/ticket"]);
  });

  it("?tag= filters by exact tag match (case-insensitive)", async () => {
    const idCounter = { n: 0 };
    const mkServices = (toolInput: Record<string, unknown>) =>
      makeServices(makeStubFetch({ toolInput }), idCounter);

    const services1 = mkServices({
      title: "AI piece",
      tldr: "About AI",
      tags: ["AI", "infra"],
      keywords: ["artificial intelligence", "infrastructure", "AI systems"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "summary body",
    });
    const app1 = createApp({ services: services1 });
    await postOne(app1, "https://example.com/ai", services1);

    const services2 = mkServices({
      title: "ML piece",
      tldr: "About ML",
      tags: ["ml"],
      keywords: ["machine learning", "ML systems", "model training"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "summary body",
    });
    const app2 = createApp({ services: services2 });
    await postOne(app2, "https://example.com/ml", services2);

    const res = await app1.request(
      "/api/readings?tag=ai",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await res.json()) as { readings: Array<{ url: string }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.url).toBe("https://example.com/ai");
  });

  it("?q= and ?tag= AND together", async () => {
    const idCounter = { n: 0 };
    const mkServices = (toolInput: Record<string, unknown>) =>
      makeServices(makeStubFetch({ toolInput }), idCounter);

    const apps = [
      { url: "https://example.com/rust-ai", title: "Rust AI", tags: ["rust", "ai"] },
      { url: "https://example.com/rust-web", title: "Rust web", tags: ["rust"] },
      { url: "https://example.com/go-ai", title: "Go AI", tags: ["ai"] },
    ];
    for (const a of apps) {
      const services = mkServices({
        title: a.title,
        tldr: "x",
        tags: a.tags,
        keywords: ["language topic", "software systems", "tag filtering"],
        people: [],
        orgs: [],
        novelty_verdict: "novel",
        connections: [],
        summary_markdown: "summary body",
      });
      const app = createApp({ services });
      await postOne(app, a.url, services);
    }

    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings?q=rust&tag=ai",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body = (await res.json()) as { readings: Array<{ url: string }> };
    expect(body.readings.map((r) => r.url)).toEqual(["https://example.com/rust-ai"]);
  });

  it("offset+limit slices results and toggles has_more correctly", async () => {
    const idCounter = { n: 0 };
    for (let i = 0; i < 3; i++) {
      const services = makeServices(makeStubFetch(), idCounter);
      const app = createApp({ services });
      await postOne(app, `https://example.com/p${i}`, services);
    }
    const app = createApp({ services: makeServices(makeStubFetch()) });

    const page1 = await app.request(
      "/api/readings?offset=0&limit=2",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body1 = (await page1.json()) as {
      readings: unknown[];
      offset: number;
      limit: number;
      has_more: boolean;
    };
    expect(body1.readings).toHaveLength(2);
    expect(body1.offset).toBe(0);
    expect(body1.limit).toBe(2);
    expect(body1.has_more).toBe(true);

    const page2 = await app.request(
      "/api/readings?offset=2&limit=2",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const body2 = (await page2.json()) as { readings: unknown[]; has_more: boolean };
    expect(body2.readings).toHaveLength(1);
    expect(body2.has_more).toBe(false);
  });

  it("rejects negative offset with 400", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings?offset=-1",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("staleness uses updated_at, not created_at", async () => {
    // Seed an index entry whose created_at is ancient but updated_at is fresh.
    // The staleness annotator must trust updated_at and leave it as pending
    // (matches the manifest-level annotateStale semantics).
    const reader = rowStore();
    await reader.writeListIndex({
      version: 1,
      items: [
        {
          id: "rd_fresh",
          key_prefix: "readings/2020/01/01T000000Z-rd_fresh",
          url: "https://example.com/fresh",
          status: "pending",
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2026-04-26T20:00:00.000Z",
        },
      ],
    });
    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const res = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      customEnv,
    );
    const body = (await res.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("pending");
  });

  it("staleness flips a long-stale pending to failed via updated_at", async () => {
    // updated_at older than TTL → annotator must mark it failed in the
    // response (the underlying manifest stays pending; this is presentation
    // only, same contract as the manifest-level annotateStale).
    const reader = rowStore();
    await reader.writeListIndex({
      version: 1,
      items: [
        {
          id: "rd_stale",
          key_prefix: "readings/2020/01/01T000000Z-rd_stale",
          url: "https://example.com/stale",
          status: "pending",
          created_at: "2026-04-26T20:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
    const customEnv = { ...env, PENDING_TTL_SECONDS: "300" } as unknown as typeof env;
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const res = await app.request(
      "/api/readings",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      customEnv,
    );
    const body = (await res.json()) as { readings: Array<{ status: string; error?: { code: string } }> };
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0]!.status).toBe("failed");
    expect(body.readings[0]!.error?.code).toBe("stale_pending");
  });
});

// Phase 3 (#367): GET /api/readings/:id resolves connection and tension
// targets against the same tenant's list index at read time.
describe("GET /api/readings/:id — relationship_targets", () => {
  const T0 = "2026-04-26T20:00:00.000Z";

  function seededManifest(id: string, over: Partial<Manifest> = {}): Manifest {
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
      created_at: T0,
      updated_at: T0,
      ...over,
    } as Manifest;
  }

  async function seed(tenant: ReturnType<typeof founderTenant>, m: Manifest, opts: { indexed?: boolean } = {}) {
    const reader = rowStore(tenant);
    const keyPrefix = buildKeyPrefix(m.id, m.created_at);
    await reader.writeManifest(keyPrefix, m);
    await reader.writeByIdPointer(m.id, { id: m.id, key_prefix: keyPrefix });
    if (opts.indexed ?? true) {
      await reader.appendOrReplaceListIndexItem(manifestToIndexItem(m, keyPrefix));
    }
    return keyPrefix;
  }

  function getDetail(id: string, token = TOKEN) {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    return app.request(`/api/readings/${id}`, { headers: { authorization: `Bearer ${token}` } }, env);
  }

  it("maps every indexed connection and tension target and omits removed ones", async () => {
    await seed(founderTenant(), seededManifest("rd_TGTREADY1"));
    await seed(founderTenant(), seededManifest("rd_TGTPEND01", { status: "pending", title: undefined }));
    await seed(founderTenant(), seededManifest("rd_TGTFAIL01", { status: "failed" }));
    const source = seededManifest("rd_SOURCE001", {
      connections: [
        { id: "rd_TGTREADY1", reason: "same topic" },
        { id: "rd_TGTPEND01", reason: "follow-up" },
        { id: "rd_VANISHED1", reason: "was deleted" },
      ],
      tensions: [
        { id: "rd_TGTFAIL01", kind: "contradicts", reason: "disagrees", computed_at: T0 },
      ],
    });
    const keyPrefix = await seed(founderTenant(), source);
    const storedBefore = await (await env.READINGS_BUCKET.get(founderObjectKey(`${keyPrefix}/manifest.json`)))!.text();

    const res = await getDetail(source.id);
    expect(res.status).toBe(200);
    const body = GetReadingResponseSchema.parse(await res.json());
    expect(body.relationship_targets).toEqual({
      rd_TGTREADY1: { url: "https://example.com/rd_TGTREADY1", title: "Title rd_TGTREADY1", status: "ready" },
      rd_TGTPEND01: { url: "https://example.com/rd_TGTPEND01", status: "pending" },
      rd_TGTFAIL01: { url: "https://example.com/rd_TGTFAIL01", title: "Title rd_TGTFAIL01", status: "failed" },
    });

    // Computed on read: the stored manifest is untouched and never carries the map.
    const storedAfter = await (await env.READINGS_BUCKET.get(founderObjectKey(`${keyPrefix}/manifest.json`)))!.text();
    expect(storedAfter).toBe(storedBefore);
    expect(storedAfter).not.toContain("relationship_targets");
  });

  it("reports a stale pending target as failed, like the list view", async () => {
    // An hour older than makeServices' clock, well past the default 300s TTL.
    const hourAgo = "2026-04-26T19:00:00.000Z";
    await seed(founderTenant(), seededManifest("rd_TGTSTALE1", {
      status: "pending",
      created_at: hourAgo,
      updated_at: hourAgo,
    }));
    await seed(founderTenant(), seededManifest("rd_SOURCE001", {
      connections: [{ id: "rd_TGTSTALE1", reason: "a" }],
    }));
    const body = (await (await getDetail("rd_SOURCE001")).json()) as {
      relationship_targets: Record<string, { status: string }>;
    };
    expect(body.relationship_targets.rd_TGTSTALE1?.status).toBe("failed");
  });

  it("never resolves a target from another tenant's list index", async () => {
    await insertSecondTenant(env as unknown as Env);
    // The other tenant owns a row whose id matches the founder's target, and
    // the founder's own index lacks it: the founder must see it as removed.
    await seed(otherTenant(), seededManifest("rd_SHAREDID1", { title: "Other tenant's row" }));
    await seed(founderTenant(), seededManifest("rd_SOURCE001", {
      connections: [{ id: "rd_SHAREDID1", reason: "a" }],
    }));
    // And the other tenant's own reading does not resolve the founder's rows.
    await seed(founderTenant(), seededManifest("rd_FOUNDERT1"));
    await seed(otherTenant(), seededManifest("rd_OTHERSRC1", {
      connections: [
        { id: "rd_FOUNDERT1", reason: "a" },
        { id: "rd_SHAREDID1", reason: "b" },
      ],
    }));

    const founder = (await (await getDetail("rd_SOURCE001")).json()) as { relationship_targets: object };
    expect(founder.relationship_targets).toEqual({});

    const other = (await (await getDetail("rd_OTHERSRC1", OTHER_TOKEN_SECRET)).json()) as {
      relationship_targets: object;
    };
    expect(other.relationship_targets).toEqual({
      rd_SHAREDID1: { url: "https://example.com/rd_SHAREDID1", title: "Other tenant's row", status: "ready" },
    });
  });
});

describe("error handling", () => {
  it("returns a generic 500 (no internals leaked) when a route handler throws", async () => {
    const faultyBucket = {
      get: vi.fn(async () => {
        throw new Error("simulated R2 outage with internal stack info");
      }),
      put: vi.fn(),
      head: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket;
    const customEnv = { ...env, READINGS_BUCKET: faultyBucket } as unknown as typeof env;
    const app = createApp({ services: makeServices(makeStubFetch()) });

    // Route reaches into the bucket to look up the id pointer; the throw
    // should be caught by the router's onError and surfaced as a generic 500.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "/api/readings/rd_DOES_NOT_EXIST",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      customEnv,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "internal" });
    // The underlying error message must NOT appear in the response body.
    const text = JSON.stringify(body);
    expect(text).not.toContain("simulated R2 outage");
    expect(text).not.toContain("stack");
    // But it should be logged for the operator to see.
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

describe("CORS", () => {
  it("allows preflight from an allowed origin", async () => {
    const allowedEnv = { ...env, CORS_ALLOWED_ORIGINS: "https://allowed.example" } as unknown as typeof env;
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      { method: "OPTIONS", headers: { origin: "https://allowed.example" } },
      allowedEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  });

  it("rejects preflight from a non-allowed origin", async () => {
    const allowedEnv = { ...env, CORS_ALLOWED_ORIGINS: "https://allowed.example" } as unknown as typeof env;
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const res = await app.request(
      "/api/readings",
      { method: "OPTIONS", headers: { origin: "https://attacker.example" } },
      allowedEnv,
    );
    expect(res.status).toBe(403);
  });
});

// Shared fixture + assertion helpers for the cross-tenant matrices
// (s1k.4.1 read paths, s1k.4.2 mutation paths): the founder owns one ready
// reading at `url`; the second tenant is inserted and owns nothing.
const UNKNOWN_ID = "rd_0000000000";

async function seedFounderReading(url: string) {
  await insertSecondTenant(env as unknown as Env);
  const idCounter = { n: 0 };
  const services = makeServices(makeStubFetch(), idCounter);
  const app = createApp({ services });
  const ctx = createExecutionContext();
  const submit = await app.fetch(
    new Request("http://t/api/readings", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ url, email: false }),
    }),
    env,
    ctx,
  );
  expect(submit.status).toBe(202);
  const { id } = (await submit.json()) as { id: string };
  await drainQueue(services);
  await waitOnExecutionContext(ctx);
  return { app, services, idCounter, id };
}

function apiRequest(
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return app.request(
    path,
    { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } },
    env,
  );
}

// The isolation contract, stated as an equality: for the other tenant the
// cross-tenant request and the unknown-resource request are the same response.
async function expectSameAsUnknown(
  app: ReturnType<typeof createApp>,
  crossPath: string,
  unknownPath: string,
  init: RequestInit = {},
) {
  const cross = await apiRequest(app, OTHER_TOKEN_SECRET, crossPath, init);
  const unknown = await apiRequest(app, OTHER_TOKEN_SECRET, unknownPath, init);
  expect(unknown.status).toBe(404);
  expect([cross.status, await cross.text()]).toEqual([unknown.status, await unknown.text()]);
}

// reading-lite-s1k.4.1: the cross-tenant read matrix. Every hosted read path
// must make another tenant's reading indistinguishable from one that never
// existed — same status, byte-identical body — while the owner still sees it.
// A route that 404s for everyone would pass the cross checks vacuously, so
// each case first proves the owner-visible positive before comparing the
// cross-tenant response against the unknown-resource response.
describe("cross-tenant read-path matrix", () => {
  const OWNED_URL = "https://example.com/matrix-owned";
  const NEVER_SUBMITTED_URL = "https://example.com/matrix-never-submitted";

  it("lookup resolves an owned URL for its owner only", async () => {
    const { app, id } = await seedFounderReading(OWNED_URL);
    const owner = await apiRequest(app, TOKEN, `/api/readings/lookup?url=${encodeURIComponent(OWNED_URL)}`);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ id });
    await expectSameAsUnknown(
      app,
      `/api/readings/lookup?url=${encodeURIComponent(OWNED_URL)}`,
      `/api/readings/lookup?url=${encodeURIComponent(NEVER_SUBMITTED_URL)}`,
    );
  });

  it.each([
    ["detail", ""],
    ["content", "/content"],
    ["content raw", "/content/raw"],
    ["diagnostics", "/diagnostics"],
  ])("%s answers a cross-tenant id exactly like an unknown id", async (_route, suffix) => {
    const { app, id } = await seedFounderReading(OWNED_URL);
    const owner = await apiRequest(app, TOKEN, `/api/readings/${id}${suffix}`);
    expect(owner.status).toBe(200);
    await owner.text();
    await expectSameAsUnknown(
      app,
      `/api/readings/${id}${suffix}`,
      `/api/readings/${UNKNOWN_ID}${suffix}`,
    );
  });

  it("list and q-search never surface another tenant's readings", async () => {
    const { app, id } = await seedFounderReading(OWNED_URL);
    const ownerSearch = (await (
      await apiRequest(app, TOKEN, "/api/readings?q=Test%20Article")
    ).json()) as { readings: { id: string }[] };
    expect(ownerSearch.readings.map((r) => r.id)).toEqual([id]);

    const otherList = (await (await apiRequest(app, OTHER_TOKEN_SECRET, "/api/readings")).json()) as {
      readings: unknown[];
      has_more: boolean;
    };
    expect(otherList.readings).toEqual([]);
    expect(otherList.has_more).toBe(false);

    const otherSearch = (await (
      await apiRequest(app, OTHER_TOKEN_SECRET, "/api/readings?q=Test%20Article")
    ).json()) as { readings: unknown[] };
    expect(otherSearch.readings).toEqual([]);
  });

  it("stale-attempt annotation stays tenant-local", async () => {
    const { app, idCounter } = await seedFounderReading(OWNED_URL);
    // A second founder submission that is never drained stays pending; jumping
    // the injected clock past PENDING_TTL_SECONDS makes it stale at read time.
    const ctx = createExecutionContext();
    const submit = await app.fetch(
      new Request("http://t/api/readings", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/matrix-stale", email: false }),
      }),
      env,
      ctx,
    );
    expect(submit.status).toBe(202);
    const { id: staleId } = (await submit.json()) as { id: string };
    await waitOnExecutionContext(ctx);
    idCounter.n += 400; // now() advances 1s per tick; TTL defaults to 300s

    const owner = (await (await apiRequest(app, TOKEN, `/api/readings/${staleId}`)).json()) as {
      status: string;
      error?: { code: string };
    };
    expect(owner.status).toBe("failed");
    // Submit leaves a running active attempt on the pending manifest, so the
    // read-time verdict is the expired-attempt annotation.
    expect(owner.error?.code).toBe("stale_active_attempt");

    await expectSameAsUnknown(app, `/api/readings/${staleId}`, `/api/readings/${UNKNOWN_ID}`);
  });
});

// reading-lite-s1k.4.2: the cross-tenant mutation matrix. Hosted mutation and
// recovery paths must not let one tenant claim, read, or mutate another
// tenant's ownership slot or artifacts.
describe("cross-tenant mutation matrix", () => {
  it("reprocess answers a cross-tenant id like an unknown id and mutates nothing", async () => {
    const { app, id } = await seedFounderReading("https://example.com/mutation-reprocess");
    await expectSameAsUnknown(
      app,
      `/api/readings/${id}/reprocess`,
      `/api/readings/${UNKNOWN_ID}/reprocess`,
      { method: "POST" },
    );
    // The cross-tenant attempt changed nothing: the owner's reading is still
    // ready, and the owner can still activate a reprocess on it.
    const detail = await apiRequest(app, TOKEN, `/api/readings/${id}`);
    expect(((await detail.json()) as { status: string }).status).toBe("ready");
    const owner = await apiRequest(app, TOKEN, `/api/readings/${id}/reprocess`, { method: "POST" });
    expect(owner.status).toBe(202);
    await owner.text();
  });

  it("import-markdown lands in the importer's own slot, never the other owner's", async () => {
    const url = "https://example.com/mutation-import";
    const { app, id: founderId } = await seedFounderReading(url);
    const founderBefore = (await (
      await apiRequest(app, TOKEN, `/api/readings/${founderId}`)
    ).json()) as { status: string; updated_at: string };
    expect(founderBefore.status).toBe("ready");

    // The other tenant imports the same URL: a fresh claim in its own
    // namespace, not a hit on the founder's existing ownership slot.
    const imported = await apiRequest(app, OTHER_TOKEN_SECRET, "/api/readings/import-markdown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_url: url, markdown: "# Other tenant copy" }),
    });
    expect(imported.status).toBe(202);
    const { id: otherId } = (await imported.json()) as { id: string };
    expect(otherId).not.toBe(founderId);

    // The founder's reading and by-url ownership are untouched.
    const founderAfter = (await (
      await apiRequest(app, TOKEN, `/api/readings/${founderId}`)
    ).json()) as { status: string; updated_at: string };
    expect(founderAfter).toEqual(founderBefore);
    const founderLookup = await apiRequest(
      app,
      TOKEN,
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
    );
    expect(await founderLookup.json()).toEqual({ id: founderId });

    // And the other tenant's own lookup resolves its own copy.
    const otherLookup = await apiRequest(
      app,
      OTHER_TOKEN_SECRET,
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
    );
    expect(otherLookup.status).toBe(200);
    expect(await otherLookup.json()).toEqual({ id: otherId });
  });

  it("activation rollback after a queue failure stays inside the failing tenant", async () => {
    const url = "https://example.com/mutation-rollback";
    const { app, id: founderId } = await seedFounderReading(url);
    const founderBefore = await (
      await apiRequest(app, TOKEN, `/api/readings/${founderId}`)
    ).text();

    // The other tenant's submit claims its own slot, then the queue send fails
    // and the rollback-to-failed funnel runs — entirely in its namespace.
    installRejectingQueueStub();
    const submit = await apiRequest(app, OTHER_TOKEN_SECRET, "/api/readings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, email: false }),
    });
    expect(submit.status).toBe(503);
    const { id: otherId } = (await submit.json()) as { id: string };
    expect(otherId).toBeDefined();
    expect(otherId).not.toBe(founderId);

    // The rolled-back failed manifest is visible to its own tenant…
    const rolled = (await (
      await apiRequest(app, OTHER_TOKEN_SECRET, `/api/readings/${otherId}`)
    ).json()) as { status: string };
    expect(rolled.status).toBe("failed");

    // …and the founder's reading is byte-identical to before the failure.
    const founderAfter = await (
      await apiRequest(app, TOKEN, `/api/readings/${founderId}`)
    ).text();
    expect(founderAfter).toBe(founderBefore);

    // The founder's by-url ownership slot is intact: the failing tenant's
    // claim landed in its own namespace, not over the founder's.
    const founderLookup = await apiRequest(
      app,
      TOKEN,
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
    );
    expect(await founderLookup.json()).toEqual({ id: founderId });

    // The rolled-back reading is invisible from the founder's side.
    const founderCross = await apiRequest(app, TOKEN, `/api/readings/${otherId}`);
    expect(founderCross.status).toBe(404);
    expect(await founderCross.json()).toEqual({ error: "not found" });
  });

  it("a dead-lettered job admitted under another tenant cannot mutate the owner's reading", async () => {
    const url = "https://example.com/mutation-dlq";
    const { app, services, id } = await seedFounderReading(url);
    const founderBefore = await (await apiRequest(app, TOKEN, `/api/readings/${id}`)).text();

    // An envelope whose tenant context does not match the job it carries: the
    // job describes the founder's reading, but the envelope authenticates the
    // OTHER tenant's token. Drive it through the production dead-letter
    // boundary — parse, admission against D1, then the mark — wired exactly
    // like the worker's queue() handler.
    const founderStore = rowStore(founderTenant());
    const found = await founderStore.loadReadingById(id);
    expect(found).not.toBeNull();
    const envelope: ProcessReadingEnvelopeV1 = {
      version: 1,
      tenant: { tenantId: otherTenant().tenantId },
      actor: { kind: "api_token", credentialId: OTHER_TOKEN_ID },
      job: {
        id,
        url,
        urlHash: await sha256Hex(url),
        createdAt: found!.manifest.created_at,
        keyPrefix: found!.keyPrefix,
        trigger: "reprocess",
      },
    };
    const ack = vi.fn();
    await handleDeadLetter(
      { body: envelope, ack, retry: vi.fn() } as unknown as Message<unknown>,
      {
        db: fromD1((env as unknown as Env).CONTROL_PLANE),
        nowMs: Date.now(),
        mark: (body, tenant) => markDeadLettered(body, env as unknown as Env, services, tenant),
      },
    );
    expect(ack).toHaveBeenCalled();

    // The founder's reading, list, and by-url ownership are byte-identical to
    // before: nothing the admitted tenant did reached the owner's namespace.
    const founderAfter = await (await apiRequest(app, TOKEN, `/api/readings/${id}`)).text();
    expect(founderAfter).toBe(founderBefore);
    const founderList = (await (await apiRequest(app, TOKEN, "/api/readings")).json()) as {
      readings: { id: string; status: string }[];
    };
    expect(founderList.readings.map((r) => [r.id, r.status])).toEqual([[id, "ready"]]);
    const founderLookup = await apiRequest(
      app,
      TOKEN,
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
    );
    expect(await founderLookup.json()).toEqual({ id });

    // And the admitted tenant gains nothing either: a DLQ job whose manifest
    // does not exist in the admitted tenant's namespace was never owned by
    // that tenant, so the mark must not materialize the envelope's metadata
    // (the owner's URL and reading id) as a visible row in that tenant's list.
    const otherList = (await (
      await apiRequest(app, OTHER_TOKEN_SECRET, "/api/readings")
    ).json()) as { readings: unknown[] };
    expect(otherList.readings).toEqual([]);
    expect(
      await env.READINGS_BUCKET.head(`u/${OTHER_TENANT_ID}/${found!.keyPrefix}/manifest.json`),
    ).toBeNull();
  });

  it("concurrent two-tenant terminal commits keep list CAS and vectors per tenant", async () => {
    await insertSecondTenant(env as unknown as Env);
    const stub = installVectorizeStub();
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });

    async function submit(token: string, url: string) {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request("http://t/api/readings", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ url, email: false }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      await waitOnExecutionContext(ctx);
      return id;
    }

    const founderId = await submit(TOKEN, "https://example.com/concurrent-founder");
    const otherId = await submit(OTHER_TOKEN_SECRET, "https://example.com/concurrent-other");

    // Drain the two envelopes CONCURRENTLY: the tenants' terminal commits (list
    // CAS + vector upsert) interleave, and each must land only in its own
    // tenant's list.json and namespace.
    const envelopes = queuedEnvelopes.splice(0);
    queuedJobs.splice(0);
    await Promise.all(
      envelopes.map((envelope) =>
        consumeProcessReadingMessage(
          { body: envelope, ack() {} },
          {
            db: fromD1((env as unknown as Env).CONTROL_PLANE),
            nowMs: Date.now(),
            process: (job, tenant) => processReading(job, env as unknown as Env, services, tenant),
          },
        ),
      ),
    );

    const founderList = (await (await apiRequest(app, TOKEN, "/api/readings")).json()) as {
      readings: { id: string; status: string }[];
    };
    const otherList = (await (
      await apiRequest(app, OTHER_TOKEN_SECRET, "/api/readings")
    ).json()) as { readings: { id: string; status: string }[] };
    expect(founderList.readings.map((r) => [r.id, r.status])).toEqual([[founderId, "ready"]]);
    expect(otherList.readings.map((r) => [r.id, r.status])).toEqual([[otherId, "ready"]]);
    expect(stub.vectors.get(tenantVectorId(FOUNDER_TENANT_ID, founderId))?.namespace).toBe(FOUNDER_TENANT_ID);
    expect(stub.vectors.get(tenantVectorId(OTHER_TENANT_ID, otherId))?.namespace).toBe(OTHER_TENANT_ID);
  });
});

// DELETE /api/readings/:id — the purge endpoint (reading-lite-qmy). The
// contract under test: after a successful delete nothing about the reading is
// visible (list, detail, lookup, vector) or resurrectable (resubmitting the
// URL mints a fresh reading), a by-url pointer owned by a DIFFERENT reading
// survives, and a partially-purged reading can be re-deleted to completion.
describe("DELETE /api/readings/:id (purge)", () => {
  it("purges a ready reading everywhere and frees the URL for a fresh submit", async () => {
    const stub = installVectorizeStub();
    const url = "https://example.com/delete-ready";
    const { app, id } = await seedFounderReading(url);
    const urlHash = await sha256Hex(url);

    expect(stub.vectors.has(tenantVectorId(FOUNDER_TENANT_ID, id))).toBe(true);
    const diag = (await (
      await apiRequest(app, TOKEN, `/api/readings/${id}/diagnostics`)
    ).json()) as { key_prefix: string };

    const del = await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({
      id,
      vector_delete_requested: true,
      list_row_removed: true,
      by_url_released: true,
      objects_deleted: expect.any(Number),
    });

    expect(stub.vectors.has(tenantVectorId(FOUNDER_TENANT_ID, id))).toBe(false);
    const list = (await (await apiRequest(app, TOKEN, "/api/readings")).json()) as {
      readings: unknown[];
    };
    expect(list.readings).toEqual([]);
    expect((await apiRequest(app, TOKEN, `/api/readings/${id}`)).status).toBe(404);
    expect(
      (await apiRequest(app, TOKEN, `/api/readings/lookup?url=${encodeURIComponent(url)}`)).status,
    ).toBe(404);
    const leftover = await env.READINGS_BUCKET.list({
      prefix: founderObjectKey(`${diag.key_prefix}/`),
    });
    expect(leftover.objects).toEqual([]);
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-url/${urlHash}`))).toBeNull();
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-id/${id}`))).toBeNull();
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/deleted/${id}`))).not.toBeNull();

    // Idempotent target: once purged, the id answers like it never existed.
    expect(
      (await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" })).status,
    ).toBe(404);

    // The by-url slot is free again: a resubmit mints a fresh reading.
    const resubmit = await apiRequest(app, TOKEN, "/api/readings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, email: false }),
    });
    expect(resubmit.status).toBe(202);
    const { id: freshId } = (await resubmit.json()) as { id: string };
    expect(freshId).not.toBe(id);
  });

  it("refuses to purge while an attempt is running and leaves the reading intact", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const submit = await apiRequest(app, TOKEN, "/api/readings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/delete-pending", email: false }),
    });
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };

    const del = await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(await del.json()).toEqual({ error: "reading already has an active attempt" });

    const detail = await apiRequest(app, TOKEN, `/api/readings/${id}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { status: string }).status).toBe("pending");

    // Once the attempt finishes, the purge goes through.
    await drainQueue(services);
    expect(
      (await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("never deletes a by-url pointer owned by a different reading", async () => {
    const url = "https://example.com/delete-orphan-dup";
    const { app, id: survivorId } = await seedFounderReading(url);
    const urlHash = await sha256Hex(url);
    const reader = rowStore();

    // An orphan-duplicate failed copy of the same URL: manifest, by-id pointer,
    // and list row of its own, but the by-url slot belongs to the survivor.
    const orphanId = "rd_ORPHANDUP";
    const createdAt = "2026-04-26T19:00:00.000Z";
    const orphanPrefix = buildKeyPrefix(orphanId, createdAt);
    const orphan: Manifest = {
      id: orphanId,
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404" },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    };
    await reader.writeManifest(orphanPrefix, orphan);
    await reader.writeByIdPointer(orphanId, { id: orphanId, key_prefix: orphanPrefix });
    await reader.appendOrReplaceListIndexItem(manifestToIndexItem(orphan, orphanPrefix));

    const del = await apiRequest(app, TOKEN, `/api/readings/${orphanId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { by_url_released: boolean }).by_url_released).toBe(false);

    // The survivor still owns its URL and stays fully visible; the orphan is gone.
    const lookup = await apiRequest(
      app,
      TOKEN,
      `/api/readings/lookup?url=${encodeURIComponent(url)}`,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ id: survivorId });
    expect((await apiRequest(app, TOKEN, `/api/readings/${survivorId}`)).status).toBe(200);
    expect((await apiRequest(app, TOKEN, `/api/readings/${orphanId}`)).status).toBe(404);
  });

  it("completes a partial purge whose manifest is already gone", async () => {
    const stub = installVectorizeStub();
    const url = "https://example.com/delete-partial";
    const { app, id } = await seedFounderReading(url);
    const urlHash = await sha256Hex(url);
    const diag = (await (
      await apiRequest(app, TOKEN, `/api/readings/${id}/diagnostics`)
    ).json()) as { key_prefix: string };

    // Simulate a crashed earlier purge: the manifest object is gone but the
    // vector, list row, pointers, and other objects remain.
    await env.READINGS_BUCKET.delete(founderObjectKey(`${diag.key_prefix}/manifest.json`));

    const del = await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    // The URL comes from the surviving list row, so the pointer still releases.
    expect(((await del.json()) as { by_url_released: boolean }).by_url_released).toBe(true);

    expect(stub.vectors.has(tenantVectorId(FOUNDER_TENANT_ID, id))).toBe(false);
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-url/${urlHash}`))).toBeNull();
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-id/${id}`))).toBeNull();
    const leftover = await env.READINGS_BUCKET.list({
      prefix: founderObjectKey(`${diag.key_prefix}/`),
    });
    expect(leftover.objects).toEqual([]);
    const list = (await (await apiRequest(app, TOKEN, "/api/readings")).json()) as {
      readings: unknown[];
    };
    expect(list.readings).toEqual([]);
  });

  it("drops a stale queued attempt for a purged reading without recreating any object", async () => {
    const stub = installVectorizeStub();
    const idCounter = { n: 0 };
    const services = makeServices(makeStubFetch(), idCounter);
    const app = createApp({ services });
    const submit = await apiRequest(app, TOKEN, "/api/readings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/delete-stale-queued", email: false }),
    });
    expect(submit.status).toBe(202);
    const { id } = (await submit.json()) as { id: string };
    const diag = (await (
      await apiRequest(app, TOKEN, `/api/readings/${id}/diagnostics`)
    ).json()) as { key_prefix: string };

    // The message stays queued while the clock passes PENDING_TTL_SECONDS, so
    // the attempt reads stale and the purge is allowed through the 409 gate.
    idCounter.n += 400;
    const del = await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // The stale message now lands: the consumer must drop it whole — no
    // attempt log, no artifacts, no manifest, no vector, no list row.
    await drainQueue(services);
    const leftover = await env.READINGS_BUCKET.list({
      prefix: founderObjectKey(`${diag.key_prefix}/`),
    });
    expect(leftover.objects).toEqual([]);
    expect(stub.vectors.size).toBe(0);
    const list = (await (await apiRequest(app, TOKEN, "/api/readings")).json()) as {
      readings: unknown[];
    };
    expect(list.readings).toEqual([]);
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-id/${id}`))).toBeNull();
  });

  it("purges a reading whose manifest is corrupt", async () => {
    const url = "https://example.com/delete-corrupt";
    const { app, id } = await seedFounderReading(url);
    const urlHash = await sha256Hex(url);
    const diag = (await (
      await apiRequest(app, TOKEN, `/api/readings/${id}/diagnostics`)
    ).json()) as { key_prefix: string };
    await env.READINGS_BUCKET.put(
      founderObjectKey(`${diag.key_prefix}/manifest.json`),
      "definitely not json",
    );

    const del = await apiRequest(app, TOKEN, `/api/readings/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    // The URL falls back to the list row, so the owned pointer still releases.
    expect(((await del.json()) as { by_url_released: boolean }).by_url_released).toBe(true);
    const leftover = await env.READINGS_BUCKET.list({
      prefix: founderObjectKey(`${diag.key_prefix}/`),
    });
    expect(leftover.objects).toEqual([]);
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-url/${urlHash}`))).toBeNull();
    expect(await env.READINGS_BUCKET.head(founderObjectKey(`index/by-id/${id}`))).toBeNull();
  });

  it("answers a cross-tenant id like an unknown id and purges nothing", async () => {
    const stub = installVectorizeStub();
    const { app, id } = await seedFounderReading("https://example.com/delete-cross-tenant");
    await expectSameAsUnknown(app, `/api/readings/${id}`, `/api/readings/${UNKNOWN_ID}`, {
      method: "DELETE",
    });
    expect(stub.vectors.has(tenantVectorId(FOUNDER_TENANT_ID, id))).toBe(true);
    const detail = await apiRequest(app, TOKEN, `/api/readings/${id}`);
    expect(((await detail.json()) as { status: string }).status).toBe("ready");
  });
});
