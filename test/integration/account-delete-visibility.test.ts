import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "../../src/modules/http-retry";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import type { Env } from "../../src/index";
import { sha256Hex, type Services } from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";
import { founderTenant, testReadingStore } from "../helpers/tenant-fixtures";

const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function installVectorizeStub() {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, {
        values: v.values as number[],
        metadata: (v.metadata ?? {}) as Record<string, unknown>,
      });
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const query = vi.fn(async () => ({ count: 0, matches: [] }) as unknown as VectorizeMatches);
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert,
    deleteByIds,
    query,
  } as unknown as VectorizeIndex;
  return { upsert, deleteByIds, query, vectors };
}

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
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

function makeServices(fetchFn: typeof fetch): Services {
  return {
    fetch: fetchFn,
    now: () => "2026-04-26T20:00:00.000Z",
    newId: () => "rd_VIS",
  };
}

function statusLookupPlane(inner: D1Database, succeed: number): D1Database {
  let remaining = succeed;
  return {
    prepare(sql: string) {
      const stmt = inner.prepare(sql);
      if (!/SELECT\s+status\s+FROM\s+users\s+WHERE\s+id\s*=\s*\?/i.test(sql)) return stmt;
      return {
        bind(...params: unknown[]) {
          const bound = stmt.bind(...params);
          return {
            first: async () => {
              if (remaining <= 0) throw new Error("D1 hiccup");
              remaining -= 1;
              return bound.first();
            },
            run: () => bound.run(),
            all: () => bound.all(),
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) await env.READINGS_BUCKET.delete(obj.key);
}

beforeEach(clearBucket);

describe("processReading — tenant status lookup at publish", () => {
  it("retries a pre-publish D1 throw instead of markFailed", async () => {
    installVectorizeStub();
    const fetchFn = makeStubFetch();
    const reader = testReadingStore(env);
    const url = "https://example.com/pre-publish-lookup";
    const urlHash = await sha256Hex(url);
    const id = "rd_PREPUB";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash,
      createdAt,
      keyPrefix,
      attemptId: "at_PREPUB",
      attemptStartedAt: createdAt,
      trigger: "submit",
      email: false,
    };
    await reader.writeManifest(keyPrefix, {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });

    const workerEnv = env as unknown as Env;
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: statusLookupPlane(workerEnv.CONTROL_PLANE, 1),
    };

    try {
      await processReading(job, wrapped, makeServices(fetchFn), founderTenant());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).status).toBe(503);
      expect((error as RateLimitedError).url).toBe("d1://control-plane/users.status");
      expect((error as RateLimitedError).retryAfterMs).toBeNull();
    }

    expect(fetchFn).toHaveBeenCalled();
    const manifest = await reader.readManifest(keyPrefix);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.error).toBeUndefined();
    expect(await reader.findListIndexItem(id)).toBeNull();
  });
});
