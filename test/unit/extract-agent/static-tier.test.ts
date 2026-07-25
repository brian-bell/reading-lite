import { describe, expect, it, vi } from "vitest";
import { extractStatic } from "../../../scripts/extract-agent-lib/static-tier";
import type { LookupFn } from "../../../scripts/extract-agent-lib/safe-fetch";

const lookup: LookupFn = async () => [{ address: "93.184.216.34" }];

const ARTICLE_HTML = `<!doctype html><html><head><title>How Queues Drain</title></head><body>
<article><h1>How Queues Drain</h1>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}: a queue consumer drains messages in waves, and producer pacing keeps the in-flight backlog bounded so retries do not dead-letter under upstream rate limits.</p>`).join("\n")}
</article></body></html>`;

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function deps(fetchImpl: (url: string) => Promise<Response> | Response) {
  return {
    fetch: vi.fn(async (input: unknown) => fetchImpl(String(input))) as unknown as typeof fetch,
    lookup,
    maxBytes: 20 * 1024 * 1024,
  };
}

describe("extractStatic", () => {
  it("extracts an article via readability", async () => {
    const outcome = await extractStatic("https://public.example/article", deps(() => htmlResponse(ARTICLE_HTML)));
    expect(outcome).toMatchObject({ kind: "extracted", extractor: "readability", title: "How Queues Drain" });
    if (outcome.kind !== "extracted") throw new Error("unreachable");
    expect(outcome.markdown).toContain("queue consumer drains messages");
  });

  it("maps a 403 to a challenge outcome instead of throwing", async () => {
    const outcome = await extractStatic("https://public.example/blocked", deps(() => htmlResponse("denied", 403)));
    expect(outcome.kind).toBe("challenge");
  });

  it("maps a 429 to a challenge outcome (it surfaces as RateLimitedError, not BadStatusError)", async () => {
    const outcome = await extractStatic("https://public.example/limited", deps(() => htmlResponse("slow down", 429)));
    expect(outcome.kind).toBe("challenge");
  });

  it("maps 404 to a dead outcome", async () => {
    const outcome = await extractStatic("https://public.example/gone", deps(() => htmlResponse("nope", 404)));
    expect(outcome.kind).toBe("dead");
  });

  it("reports no_article when readability finds nothing to extract", async () => {
    const outcome = await extractStatic(
      "https://public.example/shell",
      deps(() => htmlResponse("<html><body><script>boot()</script></body></html>")),
    );
    expect(outcome.kind).toBe("no_article");
  });

  it("rejects a private-host URL with zero fetch invocations (belt and suspenders)", async () => {
    const fetch = vi.fn();
    const dnsLookup = vi.fn();
    const outcome = await extractStatic("http://192.168.1.24/internal", {
      fetch: fetch as unknown as typeof fetch,
      lookup: dnsLookup,
      maxBytes: 1024,
    });
    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});
