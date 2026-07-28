import { describe, expect, it, vi } from "vitest";
import { extractStatic } from "../../../scripts/extract-agent-lib/static-tier";
import type { LookupFn } from "../../../scripts/extract-agent-lib/safe-fetch";

const lookup: LookupFn = async () => [{ address: "93.184.216.34" }];

const ARTICLE_HTML = `<!doctype html><html><head><title>How Queues Drain</title></head><body>
<article><h1>How Queues Drain</h1>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}: a queue consumer drains messages in waves, and producer pacing keeps the in-flight backlog bounded so retries do not dead-letter under upstream rate limits.</p>`).join("\n")}
</article></body></html>`;

// A sign-in wall with more prose than the 350-char floor, served with HTTP 200:
// the shape that used to be extracted, submitted, and summarized as an article.
const WALL_COPY = [
  "You have reached your free article limit for this month.",
  "Sign in to continue reading this article and the rest of today's edition.",
  "Already a subscriber? Log in with the email address on your account and we will restore your session.",
  "Subscribe for unlimited access to every story, every newsletter, and the full archive. Cancel anytime.",
  "Members get the daily briefing, the weekend long read, and every market table we publish each morning.",
];
const WALL_HTML = `<!doctype html><html><head><title>Sign in to continue reading | The Ledger</title></head><body>
<article><h1>Sign in to continue reading</h1>
${WALL_COPY.map((p) => `<p>${p}</p>`).join("\n")}
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
    expect(outcome).toMatchObject({ kind: "extracted", tier: "static", salvaged: false, title: "How Queues Drain" });
    if (outcome.kind !== "extracted") throw new Error("unreachable");
    expect(outcome.markdown).toContain("queue consumer drains messages");
  });

  it("reports a raw-DOM salvage as salvaged (it is what earns a headless render)", async () => {
    // No <body> wrapper: Readability crashes and the salvage recovers the text.
    // Tier 1 has to say so, or the orchestrator cannot tell a real extraction
    // from boilerplate soup worth re-rendering.
    const crash = `<div id="content"><article><h1>Reference</h1>${"<p>property value property value property value property value</p>".repeat(8)}</article></div><script>var x=1;</script>`;
    const outcome = await extractStatic("https://public.example/shell", deps(() => htmlResponse(crash)));

    expect(outcome).toMatchObject({ kind: "extracted", tier: "static", salvaged: true });
  });

  it("does not mark a non-HTML capture as salvaged (there is no readability verdict)", async () => {
    const outcome = await extractStatic(
      "https://public.example/notes.txt",
      deps(() => new Response("Plain notes, captured as-is.", { headers: { "content-type": "text/plain" } })),
    );

    expect(outcome).toMatchObject({ kind: "extracted", tier: "static", salvaged: false });
  });

  it("classifies a success-status login wall as a challenge instead of an article", async () => {
    const outcome = await extractStatic("https://public.example/story", deps(() => htmlResponse(WALL_HTML)));

    expect(outcome.kind).toBe("challenge");
    if (outcome.kind !== "challenge") throw new Error("unreachable");
    expect(outcome.detail).toContain("success-status challenge content detected");
    expect(outcome.detail).toContain("https://public.example/story");
  });

  it("does not classify non-HTML content from its words alone", async () => {
    // text/plain, JSON, and YouTube-built markdown never came from a document
    // Readability judged, so challenge copy in them proves nothing.
    const outcome = await extractStatic(
      "https://public.example/notes.txt",
      deps(() => new Response(WALL_COPY.join("\n\n"), { headers: { "content-type": "text/plain" } })),
    );

    expect(outcome.kind).toBe("extracted");
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
