import { describe, expect, it } from "vitest";
import { checkOpenAIProviderKey } from "../../../src/control-plane/provider-key-check";

const KEY = "sk-unit-check-key";
const SUMMARY = "gpt-5.6-terra";
const EMBEDDING = "text-embedding-3-small";

function page(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id, owned_by: "openai" })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function recording(reply: () => Response | Promise<Response> | never): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return reply();
  };
  return { fetch: fetchImpl, calls };
}

describe("checkOpenAIProviderKey", () => {
  it("asks OpenAI's model list for the summarization and embedding models", async () => {
    const { fetch, calls } = recording(() => page([SUMMARY, EMBEDDING, "gpt-other"]));
    expect(
      await checkOpenAIProviderKey({
        fetch,
        apiKey: KEY,
        summarizationModel: SUMMARY,
        embeddingModel: EMBEDDING,
      }),
    ).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it.each([
    ["an unauthorized key", () => new Response("nope", { status: 401 }), "invalid_key"],
    ["a key without permission to list models", () => new Response("nope", { status: 403 }), "model_access"],
    ["a provider 500", () => new Response("down", { status: 500 }), "provider_unavailable"],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }), "provider_unavailable"],
    ["a 200 body that is not a model list", () => new Response("[]", { status: 200 }), "provider_unavailable"],
  ] as const)("classifies %s", async (_name, reply, code) => {
    const { fetch, calls } = recording(reply);
    expect(
      await checkOpenAIProviderKey({
        fetch,
        apiKey: KEY,
        summarizationModel: SUMMARY,
        embeddingModel: EMBEDDING,
      }),
    ).toEqual({ ok: false, code });
    expect(calls).toHaveLength(1);
  });

  it("classifies a stalled model list as provider unavailable", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        const fail = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    expect(
      await checkOpenAIProviderKey({
        fetch: fetchImpl,
        apiKey: KEY,
        summarizationModel: SUMMARY,
        embeddingModel: EMBEDDING,
        timeoutMs: 20,
      }),
    ).toEqual({ ok: false, code: "provider_unavailable" });
  });

  it("classifies a stalled model-list body as provider unavailable", async () => {
    const fetchImpl: typeof fetch = (_input, init) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted", "AbortError"));
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    };
    expect(
      await checkOpenAIProviderKey({
        fetch: fetchImpl,
        apiKey: KEY,
        summarizationModel: SUMMARY,
        embeddingModel: EMBEDDING,
        timeoutMs: 20,
      }),
    ).toEqual({ ok: false, code: "provider_unavailable" });
  });

  it("classifies a network failure as provider unavailable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(
      await checkOpenAIProviderKey({
        fetch: fetchImpl,
        apiKey: KEY,
        summarizationModel: SUMMARY,
        embeddingModel: EMBEDDING,
      }),
    ).toEqual({ ok: false, code: "provider_unavailable" });
  });

  it("classifies a list that omits a required model as model access", async () => {
    const { fetch } = recording(() => page([EMBEDDING]));
    expect(
      await checkOpenAIProviderKey({
        fetch,
        apiKey: KEY,
        summarizationModel: SUMMARY,
        embeddingModel: EMBEDDING,
      }),
    ).toEqual({ ok: false, code: "model_access" });
  });
});
