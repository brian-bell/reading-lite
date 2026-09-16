import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromD1 } from "../../src/control-plane/db";
import { consumeProcessReadingMessage, type ProcessReadingEnvelopeV1 } from "../../src/control-plane/envelope";
import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import type { ApiScope } from "../../src/control-plane/principal";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import {
  buildKeyPrefix,
  manifestToIndexItem,
} from "../../src/modules/stores/reading-store";
import type { Manifest } from "../../src/schemas/manifest";
import { CONTENT_CHUNK_BYTES } from "../../src/mcp/format";
import {
  founderTenant,
  otherTenant,
  insertSecondTenant,
  OTHER_TOKEN_SECRET,
  PUBLIC_LOOKUP,
  testReadingStore,
} from "../helpers/tenant-fixtures";

const TOKEN = "test-token";
const WEB_BASE = "https://reading.test.example";

type AnyMock = ReturnType<typeof vi.fn>;
function installVectorizeStub(): {
  upsert: AnyMock;
  query: AnyMock;
  deleteByIds: AnyMock;
} {
  const vectors = new Map<string, { values: number[]; namespace?: string }>();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, {
        values: v.values as number[],
        ...(v.namespace === undefined ? {} : { namespace: v.namespace }),
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
      .map(([id, v]) => ({ id, score: 0.9, values: v.values, metadata: {} }));
    return { count: matches.length, matches } as unknown as VectorizeMatches;
  });
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert,
    deleteByIds,
    query,
  } as unknown as VectorizeIndex;
  return { upsert, query, deleteByIds };
}

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

function makeStubFetch() {
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
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
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

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(() => {
  installVectorizeStub();
  installQueueStub();
});
afterEach(clearBucket);

async function founderUserId(): Promise<string> {
  const row = await (env as unknown as Env).CONTROL_PLANE.prepare(
    "SELECT id FROM users WHERE email_canonical = ?",
  )
    .bind("founder@test.example")
    .first<{ id: string }>();
  if (!row) throw new Error("founder user missing");
  return row.id;
}

async function insertScopedToken(secret: string, scopes: readonly ApiScope[]): Promise<string> {
  const workerEnv = env as unknown as Env;
  const userId = await founderUserId();
  const tokenId = `tok_${crypto.randomUUID()}`;
  const secretHmac = await hmacHex(
    await deriveHmacKey({ secret: parseAuthRootSecret(workerEnv.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
    secret,
  );
  await workerEnv.CONTROL_PLANE.prepare(
    `INSERT INTO api_tokens (
       id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
     ) VALUES (?, ?, 'scoped', 'legacy', ?, 1, ?, ?)`,
  )
    .bind(tokenId, userId, secretHmac, Date.now(), Date.now() + 60_000)
    .run();
  for (const scope of scopes) {
    await workerEnv.CONTROL_PLANE.prepare(
      "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, ?)",
    )
      .bind(tokenId, scope)
      .run();
  }
  return secret;
}

type JsonRpc = {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; inputSchema?: unknown; description?: string }>;
    protocolVersion?: string;
    serverInfo?: { name: string };
    capabilities?: unknown;
  };
  error?: { code: number; message: string };
};

function assertNoTokenLeak(value: unknown): void {
  const dumped = JSON.stringify(value);
  expect(dumped).not.toContain(TOKEN);
  expect(dumped).not.toContain("Bearer ");
}

async function mcpRpc(
  app: ReturnType<typeof createApp>,
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; envOverride?: typeof env } = {},
): Promise<{ res: Response; rpc: JsonRpc }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
    ...(opts.headers ?? {}),
  });
  if (opts.token !== null) {
    headers.set("authorization", `Bearer ${opts.token ?? TOKEN}`);
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://t/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
    opts.envOverride ?? env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const rpc = (await res.json()) as JsonRpc;
  assertNoTokenLeak(rpc);
  return { res, rpc };
}

function toolText(rpc: JsonRpc): string {
  const text = rpc.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool text");
  return text;
}

function toolPayload(rpc: JsonRpc): Record<string, unknown> {
  return JSON.parse(toolText(rpc)) as Record<string, unknown>;
}

async function callTool(
  app: ReturnType<typeof createApp>,
  name: string,
  args: Record<string, unknown> = {},
  opts?: { token?: string | null; headers?: Record<string, string> },
): Promise<{ res: Response; rpc: JsonRpc; payload: Record<string, unknown> }> {
  const { res, rpc } = await mcpRpc(
    app,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    opts,
  );
  const payload = rpc.result ? toolPayload(rpc) : {};
  return { res, rpc, payload };
}

async function seedReady(opts: {
  id: string;
  url: string;
  title: string;
  tldr: string;
  tags?: string[];
  markdown: string;
  createdAt?: string;
  tenant?: ReturnType<typeof founderTenant>;
  connections?: Manifest["connections"];
}): Promise<void> {
  const store = testReadingStore(env, opts.tenant ?? founderTenant());
  const created_at = opts.createdAt ?? "2026-04-26T20:00:00.000Z";
  const prefix = buildKeyPrefix(opts.id, created_at);
  const url_hash = await sha256Hex(opts.url);
  const markdownBytes = new TextEncoder().encode(opts.markdown).byteLength;
  const manifest: Manifest = {
    id: opts.id,
    url: opts.url,
    url_hash,
    status: "ready",
    title: opts.title,
    tldr: opts.tldr,
    tags: opts.tags ?? ["test"],
    keywords: [opts.title.toLowerCase()],
    summary_markdown: `Summary of ${opts.title}.`,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: markdownBytes,
    extracted_bytes: markdownBytes,
    content_sha256: await sha256Hex(opts.markdown),
    created_at,
    updated_at: created_at,
    fetched_at: created_at,
    ...(opts.connections ? { connections: opts.connections } : {}),
  };
  await store.writeManifest(prefix, manifest);
  await store.writeByIdPointer(opts.id, { id: opts.id, key_prefix: prefix });
  await store.writeByUrlPointer(url_hash, { id: opts.id, key_prefix: prefix });
  await store.writeExtracted(prefix, opts.markdown);
  await store.appendOrReplaceListIndexItem(manifestToIndexItem(manifest, prefix));
}

describe("POST /mcp", () => {
  it("rejects a missing or wrong bearer with 401 before the handshake", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const missing = await mcpRpc(
      app,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      { token: null },
    );
    expect(missing.res.status).toBe(401);
    expect((missing.rpc as unknown as { error: string }).error).toBe("unauthorized");

    const wrong = await mcpRpc(
      app,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      { token: "wrong" },
    );
    expect(wrong.res.status).toBe(401);
  });

  it("rejects a disallowed Origin with 403 and allows a missing Origin", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const blocked = await mcpRpc(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { headers: { origin: "https://attacker.example" } },
    );
    expect(blocked.res.status).toBe(403);
    expect((blocked.rpc as unknown as { error: string }).error).toBe("forbidden origin");

    const ok = await mcpRpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(ok.res.status).toBe(200);
    expect(ok.rpc.result?.tools).toBeDefined();
  });

  it("also serves the same MCP endpoint at /api/mcp", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://t/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const rpc = (await res.json()) as JsonRpc;
    assertNoTokenLeak(rpc);
    expect((rpc.result?.tools ?? []).map((t) => t.name)).toContain("list_readings");
  });

  it("returns 405 for GET /mcp in stateless mode", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://t/mcp", { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
    assertNoTokenLeak(await res.json());
  });

  it("initialize then tools/list returns exactly the eight required tools", async () => {
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const init = await mcpRpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(init.res.status).toBe(200);
    expect(init.rpc.result?.serverInfo?.name).toBe("reading-lite");

    const listed = await mcpRpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.res.status).toBe(200);
    const names = (listed.rpc.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_diagnostics",
        "get_reading",
        "get_reading_content",
        "import_markdown",
        "list_readings",
        "reprocess_reading",
        "search_readings",
        "submit_url",
      ].sort(),
    );
    for (const tool of listed.rpc.result?.tools ?? []) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.description).toBe("string");
    }
    const writes = (listed.rpc.result?.tools ?? []).filter((t) =>
      ["submit_url", "import_markdown", "reprocess_reading"].includes(t.name),
    );
    for (const tool of writes) {
      expect(tool.description?.toLowerCase()).toContain("mutate");
    }
  });

  it("list_readings pages and has_more, and q filters to a smaller relevant set", async () => {
    await seedReady({
      id: "rd_KARPATHY1",
      url: "https://example.com/karpathy",
      title: "Karpathy on agents",
      tldr: "A Karpathy essay",
      tags: ["ai"],
      markdown: "# Karpathy\n\nbody",
      createdAt: "2026-04-26T20:00:02.000Z",
    });
    await seedReady({
      id: "rd_OTHER0001",
      url: "https://example.com/other",
      title: "Unrelated gardening",
      tldr: "Tomatoes",
      tags: ["garden"],
      markdown: "# Garden\n\nbody",
      createdAt: "2026-04-26T20:00:01.000Z",
    });
    await seedReady({
      id: "rd_OTHER0002",
      url: "https://example.com/other-2",
      title: "More gardening",
      tldr: "Peppers",
      tags: ["garden"],
      markdown: "# Peppers\n\nbody",
      createdAt: "2026-04-26T20:00:00.000Z",
    });

    const app = createApp({ services: makeServices(makeStubFetch()) });
    const page = await callTool(app, "list_readings", { limit: 2, offset: 0 });
    expect(page.res.status).toBe(200);
    expect(page.rpc.result?.isError).not.toBe(true);
    expect(page.payload.limit).toBe(2);
    expect(page.payload.offset).toBe(0);
    expect(page.payload.has_more).toBe(true);
    expect(page.payload.readings).toHaveLength(2);

    const next = await callTool(app, "list_readings", { limit: 2, offset: 2 });
    expect(next.payload.has_more).toBe(false);
    expect(next.payload.readings).toHaveLength(1);

    const search = await callTool(app, "search_readings", { q: "karpathy" });
    expect(search.rpc.result?.isError).not.toBe(true);
    const readings = search.payload.readings as Array<{ id: string; title?: string }>;
    expect(readings.length).toBe(1);
    expect(readings[0]?.id).toBe("rd_KARPATHY1");
    expect(JSON.stringify(search.payload)).not.toMatch(/# Karpathy/);
  });

  it("get_reading leaves out the HTTP-only relationship_targets map", async () => {
    await seedReady({
      id: "rd_TARGET001",
      url: "https://example.com/target",
      title: "Target",
      tldr: "t",
      markdown: "# Target",
    });
    await seedReady({
      id: "rd_SOURCE001",
      url: "https://example.com/source",
      title: "Source",
      tldr: "s",
      markdown: "# Source",
      connections: [{ id: "rd_TARGET001", reason: "related" }],
    });

    const app = createApp({ services: makeServices(makeStubFetch()) });
    const http = await app.request(
      "/api/readings/rd_SOURCE001",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const httpBody = (await http.json()) as { relationship_targets?: Record<string, unknown> };
    expect(Object.keys(httpBody.relationship_targets ?? {})).toEqual(["rd_TARGET001"]);

    const meta = await callTool(app, "get_reading", { id: "rd_SOURCE001" });
    expect(meta.rpc.result?.isError).not.toBe(true);
    expect(meta.payload.connections).toEqual([{ id: "rd_TARGET001", reason: "related" }]);
    expect(meta.payload).not.toHaveProperty("relationship_targets");
  });

  it("get_reading and get_reading_content return summary plus markdown, and truncate huge bodies", async () => {
    const markdown = "# Karpathy\n\n" + "full body ".repeat(20);
    await seedReady({
      id: "rd_READY0001",
      url: "https://example.com/ready",
      title: "Karpathy notes",
      tldr: "Short tldr",
      markdown,
    });
    const huge = "x".repeat(CONTENT_CHUNK_BYTES + 80);
    await seedReady({
      id: "rd_HUGE00001",
      url: "https://example.com/huge",
      title: "Huge extract",
      tldr: "big",
      markdown: huge,
      createdAt: "2026-04-26T19:00:00.000Z",
    });

    const app = createApp({ services: makeServices(makeStubFetch()) });
    const meta = await callTool(app, "get_reading", { id: "rd_READY0001" });
    expect(meta.payload.title).toBe("Karpathy notes");
    expect(meta.payload.tldr).toBe("Short tldr");
    expect(meta.payload.summary_markdown).toBe("Summary of Karpathy notes.");
    expect(meta.payload.public_url).toBe(`${WEB_BASE}/readings/rd_READY0001`);
    expect(meta.payload.public_markdown_link).toBe(
      `[Karpathy notes](${WEB_BASE}/readings/rd_READY0001)`,
    );

    const body = await callTool(app, "get_reading_content", { id: "rd_READY0001" });
    expect(body.payload.markdown).toBe(markdown);
    expect(body.payload.truncated).toBe(false);
    expect(body.payload.bytes_total).toBe(new TextEncoder().encode(markdown).byteLength);

    const truncated = await callTool(app, "get_reading_content", { id: "rd_HUGE00001" });
    expect(truncated.payload.truncated).toBe(true);
    expect(truncated.payload.bytes_returned).toBe(CONTENT_CHUNK_BYTES);
    expect(truncated.payload.next_offset).toBe(CONTENT_CHUNK_BYTES);

    const missing = await callTool(app, "get_reading", { id: "rd_MISSING01" });
    expect(missing.rpc.result?.isError).toBe(true);
    expect(missing.payload.http_status).toBe(404);
    expect(missing.payload.error).toBe("unknown id");
  });

  it("submit_url returns a new pending id, and an already-owned URL returns the existing id", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({ services });
    const created = await callTool(app, "submit_url", { url: "https://example.com/new-article" });
    expect(created.res.status).toBe(200);
    expect(created.rpc.result?.isError).not.toBe(true);
    expect(created.payload.existing).toBe(false);
    expect(created.payload.status).toBe("pending");
    expect(typeof created.payload.id).toBe("string");
    expect(String(created.payload.note)).toMatch(/not ready until polled/i);

    const again = await callTool(app, "submit_url", { url: "https://example.com/new-article" });
    expect(again.payload.existing).toBe(true);
    expect(again.payload.id).toBe(created.payload.id);
    expect(String(again.payload.note)).toMatch(/existing reading returned/i);
  });

  it("import_markdown creates a stub, optionally polls until ready, and reprocess mutates the same id", async () => {
    const services = makeServices(makeStubFetch());
    const app = createApp({
      services,
      sleep: async () => {
        await drainQueue(services);
      },
    });

    const imported = await callTool(app, "import_markdown", {
      source_url: "https://example.com/imported",
      markdown: "# Imported\n\nhello",
      title: "Imported title",
    });
    expect(imported.rpc.result?.isError).not.toBe(true);
    expect(imported.payload.existing).toBe(false);
    expect(imported.payload.status).toBe("pending");
    const id = imported.payload.id as string;
    expect(imported.payload.public_markdown_link).toBe(`[Imported title](${WEB_BASE}/readings/${id})`);

    const polled = await callTool(app, "import_markdown", {
      source_url: "https://example.com/imported-poll",
      markdown: "# Poll me\n\nhello",
      title: "Poll title",
      poll_until_ready: true,
    });
    expect(polled.rpc.result?.isError).not.toBe(true);
    expect(polled.payload.status).toBe("ready");
    expect(polled.payload.polled).toBe(true);
    expect(String(polled.payload.public_markdown_link)).toContain("/readings/");

    const reprocessed = await callTool(app, "reprocess_reading", { id });
    expect(reprocessed.rpc.result?.isError).not.toBe(true);
    expect(reprocessed.payload.id).toBe(id);

    const diag = await callTool(app, "get_diagnostics", { id });
    expect(diag.rpc.result?.isError).not.toBe(true);
    expect(diag.payload.id).toBe(id);
    expect(diag.payload.manifest).toBeDefined();
  });

  it("a read-only token can connect and list every tool", async () => {
    const secret = await insertScopedToken("scope-read-only-mcp", ["readings:read"]);
    const app = createApp({ services: makeServices(makeStubFetch()) });
    const listed = await mcpRpc(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: secret },
    );
    expect(listed.res.status).toBe(200);
    expect((listed.rpc.result?.tools ?? []).length).toBe(8);
  });

});


// #198: exercise the MCP dispatch boundary itself, including content/diagnostic
// tools and polling; HTTP-only coverage cannot catch a lost dispatch principal.
describe("MCP adversarial tenant matrix", () => {
  const id = "rd_MCPPRIVATE";
  const unknownId = "rd_0000000000";
  const url = "https://example.com/mcp-private";

  async function fixture() {
    await insertSecondTenant(env as unknown as Env);
    await seedReady({ id, url, title: "Private founder", tldr: "private needle", markdown: "# Founder secret" });
    const services = makeServices(makeStubFetch());
    const app = createApp({ services, sleep: async () => { await drainQueue(services); } });
    return { app, services };
  }

  async function snapshot() {
    const listed = await env.READINGS_BUCKET.list();
    expect(listed.truncated).toBe(false);
    return Promise.all(listed.objects.map(async ({ key }) => [key, await (await env.READINGS_BUCKET.get(key))!.text()]));
  }

  it.each(["get_reading", "get_reading_content", "get_diagnostics", "reprocess_reading"])(
    "%s hides foreign ids and leaves both tenants' artifacts untouched", async (name) => {
      const { app } = await fixture();
      const before = await snapshot();
      const owner = await callTool(app, name === "reprocess_reading" ? "get_reading" : name, { id });
      expect(owner.rpc.result?.isError).not.toBe(true);
      expect(owner.payload.id).toBe(id);
      const args = name === "reprocess_reading"
        ? { body: { force: true, source: { kind: "markdown", markdown: "# Attacker replacement" } } }
        : {};
      const foreign = await callTool(app, name, { id, ...args }, { token: OTHER_TOKEN_SECRET });
      const unknown = await callTool(app, name, { id: unknownId, ...args }, { token: OTHER_TOKEN_SECRET });
      expect(unknown.payload.http_status).toBe(404);
      expect(foreign.rpc.result).toEqual(unknown.rpc.result);
      expect(await snapshot()).toEqual(before);
      expect(queuedEnvelopes).toEqual([]);
      if (name === "reprocess_reading") {
        const ownWrite = await callTool(app, name, { id, ...args });
        expect(ownWrite.rpc.result?.isError).not.toBe(true);
        expect(ownWrite.payload.id).toBe(id);
        expect(ownWrite.payload.existing).toBe(false);
        expect(queuedEnvelopes).toHaveLength(1);
      }
    },
  );

  it.each(["list_readings", "search_readings"])("%s searches and pages only the caller's corpus", async (name) => {
    const { app } = await fixture();
    const otherId = "rd_MCPOther01";
    await seedReady({ id: otherId, url: "https://example.com/other", title: "Other private needle", tldr: "other", markdown: "# Other", tenant: otherTenant() });
    const before = await snapshot();
    for (const [token, expectedId] of [[TOKEN, id], [OTHER_TOKEN_SECRET, otherId]]) {
      const result = await callTool(app, name, { q: "private", limit: 1 }, { token });
      expect(result.rpc.result?.isError).not.toBe(true);
      expect((result.payload.readings as { id: string }[]).map(r => r.id)).toEqual([expectedId]);
      expect(result.payload.has_more).toBe(false);
      const page = await callTool(app, name, { q: "private", limit: 1, offset: 1 }, { token });
      expect(page.payload.readings).toEqual([]);
    }
    const foreign = await callTool(app, name, { q: "founder" }, { token: OTHER_TOKEN_SECRET });
    const unknown = await callTool(app, name, { q: "never-stored" }, { token: OTHER_TOKEN_SECRET });
    expect(foreign.payload).toEqual(unknown.payload);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["submit_url", "import_markdown"])("%s claims the same URL independently and keeps polling tenant-local", async (name) => {
    const { app, services } = await fixture();
    const before = await callTool(app, "get_diagnostics", { id });
    const args = name === "submit_url" ? { url } : { source_url: url, markdown: "# Other tenant text", poll_until_ready: true };
    const own = await callTool(app, name, args);
    expect(own.payload.id).toBe(id);
    expect(own.payload.existing).toBe(true);
    const other = await callTool(app, name, args, { token: OTHER_TOKEN_SECRET });
    expect(other.rpc.result?.isError).not.toBe(true);
    expect(other.payload.existing).toBe(false);
    expect(other.payload.id).not.toBe(id);
    await drainQueue(services);
    const otherReady = await callTool(app, "get_reading", { id: other.payload.id }, { token: OTHER_TOKEN_SECRET });
    expect(otherReady.payload.status).toBe("ready");
    if (name === "import_markdown") {
      expect(other.payload.polled).toBe(true);
      expect(other.payload.status).toBe("ready");
      expect((other.payload.reading as { id: string }).id).toBe(other.payload.id);
    }
    expect((await callTool(app, "get_diagnostics", { id })).payload).toEqual(before.payload);
    const cross = await callTool(app, "get_reading", { id: other.payload.id });
    expect(cross.payload.http_status).toBe(404);
  });

  it.each([
    ["submit_url", { url }],
    ["import_markdown", { source_url: url, markdown: "# forbidden" }],
    ["reprocess_reading", { id, body: { force: true } }],
  ])("read-only scopes deny %s before ownership lookup or mutation", async (name, args) => {
    const { app } = await fixture();
    const secret = await insertScopedToken("mcp-matrix-read-only", ["readings:read"]);
    const before = await snapshot();
    for (const token of [secret, OTHER_TOKEN_SECRET]) {
      if (token === OTHER_TOKEN_SECRET) {
        await env.CONTROL_PLANE.prepare("DELETE FROM api_token_scopes WHERE token_id = ? AND scope != 'readings:read'")
          .bind("tok_11111111-1111-4111-8111-111111111111").run();
      }
      const denied = await callTool(app, name, args, { token });
      expect(denied.payload.http_status).toBe(403);
      expect(denied.rpc.result?.isError).toBe(true);
      expect(denied.payload.error).toBe("bad or missing token");
      assertNoTokenLeak(denied.rpc);
      const unknownArgs = name === "reprocess_reading" ? { ...args, id: unknownId }
        : name === "submit_url" ? { url: "https://example.com/unknown" }
        : { source_url: "https://example.com/unknown", markdown: "# forbidden" };
      expect((await callTool(app, name, unknownArgs, { token })).rpc.result).toEqual(denied.rpc.result);
    }
    expect(await snapshot()).toEqual(before);
    expect(queuedEnvelopes).toEqual([]);
  });
});
