import { describe, expect, it, vi } from "vitest";
import {
  sendReadingEmail,
  ResendError,
  BadResendResponseError,
  RESEND_EMAILS_URL,
} from "../../../src/modules/email";
import { RateLimitedError } from "../../../src/modules/http-retry";
import type { Manifest } from "../../../src/schemas/manifest";
import type { ListIndex } from "../../../src/schemas/api";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fullManifest: Manifest = {
  id: "rd_TEST01",
  url: "https://example.com/article",
  url_hash: "a".repeat(64),
  status: "ready",
  title: "Sample Article",
  tldr: "A short summary of the article.",
  tags: ["tag-a", "tag-b"],
  keywords: ["kw1", "kw2"],
  people: ["Alice", "Bob"],
  orgs: ["Org Inc"],
  novelty_verdict: "novel",
  connections: [
    { id: "rd_KNOWN", reason: "shares topic A" },
    { id: "rd_UNKNOWN", reason: "tangential" },
  ],
  summary_markdown: "# Heading\n\nParagraph text with **bold**.",
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 100,
  content_sha256: "b".repeat(64),
  fetched_at: "2026-04-26T20:00:00.000Z",
  created_at: "2026-04-26T20:00:00.000Z",
  updated_at: "2026-04-26T20:00:00.000Z",
};

const listIndex: ListIndex = {
  version: 1,
  items: [
    {
      id: "rd_KNOWN",
      key_prefix: "readings/2026/04/01T000000Z-rd_KNOWN",
      url: "https://example.com/known",
      title: "Known Reading",
      status: "ready",
      created_at: "2026-04-01T00:00:00.000Z",
    },
  ],
};

const WEB_BASE = "https://reading.test.example";

describe("sendReadingEmail", () => {
  it("POSTs to Resend with bearer auth and the expected JSON body shape", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ id: "abc-123" }));
    const out = await sendReadingEmail(
      { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
      {
        fetch: fetchFn,
        apiKey: "re_secret",
        from: "reading-lite@from.example",
        to: "reader@to.example",
      },
    );
    expect(out.id).toBe("abc-123");
    expect(fetchFn).toHaveBeenCalledOnce();
    const call = fetchFn.mock.calls[0]!;
    const url = call[0];
    const init = call[1]!;
    expect(url).toBe(RESEND_EMAILS_URL);
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_secret");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("reading-lite@from.example");
    expect(body.to).toBe("reader@to.example");
    expect(body.subject).toBe("Sample Article");
    expect(typeof body.html).toBe("string");
    expect(typeof body.text).toBe("string");
  });

  it("renders the html body with source, detail link, tldr, all sections, connections, summary html", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ id: "ok" }));
    await sendReadingEmail(
      { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
      { fetch: fetchFn, apiKey: "k", from: "f@x", to: "t@x" },
    );
    const html = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string).html as string;

    // Source URL appears as a link.
    expect(html).toContain(`href="https://example.com/article"`);
    // Detail link uses the SPA base + reading id.
    expect(html).toContain(`href="${WEB_BASE}/readings/rd_TEST01"`);
    // TL;DR is present.
    expect(html).toContain("A short summary of the article.");
    // Each populated section renders.
    expect(html).toContain("Tags");
    expect(html).toContain("tag-a");
    expect(html).toContain("tag-b");
    expect(html).toContain("Keywords");
    expect(html).toContain("kw1");
    expect(html).toContain("People");
    expect(html).toContain("Alice");
    expect(html).toContain("Orgs");
    expect(html).toContain("Org Inc");
    // Connections: known id resolves to title; unknown id renders as "(unknown reading)".
    expect(html).toContain(`href="${WEB_BASE}/readings/rd_KNOWN"`);
    expect(html).toContain("Known Reading");
    expect(html).toContain("shares topic A");
    expect(html).toContain("(unknown reading)");
    expect(html).toContain("tangential");
    // The summary markdown is rendered to HTML — `# Heading` becomes an <h*> tag,
    // `**bold**` becomes <strong>.
    expect(html).toMatch(/<h[1-6][^>]*>Heading<\/h[1-6]>/);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders the text body with sections + summary markdown verbatim", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ id: "ok" }));
    await sendReadingEmail(
      { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
      { fetch: fetchFn, apiKey: "k", from: "f@x", to: "t@x" },
    );
    const text = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string).text as string;

    expect(text).toContain("https://example.com/article");
    expect(text).toContain(`${WEB_BASE}/readings/rd_TEST01`);
    expect(text).toContain("A short summary of the article.");
    expect(text).toContain("tag-a");
    expect(text).toContain("Alice");
    // Connection: known reading shows title + URL; unknown shows "(unknown reading)".
    expect(text).toContain("Known Reading");
    expect(text).toContain(`${WEB_BASE}/readings/rd_KNOWN`);
    expect(text).toContain("(unknown reading)");
    // Summary markdown is verbatim — no HTML rendering.
    expect(text).toContain("# Heading");
    expect(text).toContain("**bold**");
  });

  it("omits empty section rows in both html and text", async () => {
    const sparseManifest: Manifest = {
      ...fullManifest,
      tags: [],
      keywords: [],
      people: [],
      orgs: [],
      connections: [],
    };
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ id: "ok" }));
    await sendReadingEmail(
      { manifest: sparseManifest, webBaseUrl: WEB_BASE, listIndex: null },
      { fetch: fetchFn, apiKey: "k", from: "f@x", to: "t@x" },
    );
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as {
      html: string;
      text: string;
    };
    // No section labels appear when the array is empty.
    expect(body.html).not.toMatch(/Tags\s*:/);
    expect(body.html).not.toMatch(/Keywords\s*:/);
    expect(body.html).not.toMatch(/People\s*:/);
    expect(body.html).not.toMatch(/Orgs\s*:/);
    expect(body.text).not.toMatch(/Tags\s*:/);
    expect(body.text).not.toMatch(/Keywords\s*:/);
    expect(body.text).not.toMatch(/People\s*:/);
    expect(body.text).not.toMatch(/Orgs\s*:/);
    // Source + detail + tldr + summary still render even with no sections / connections.
    expect(body.html).toContain("https://example.com/article");
    expect(body.html).toContain("A short summary of the article.");
  });

  it("escapes HTML-significant characters in user-controlled fields", async () => {
    const evilManifest: Manifest = {
      ...fullManifest,
      title: "Sample <script>alert(1)</script>",
      tldr: 'tldr with "quotes" & ampersand',
      tags: ["<b>tag</b>"],
      connections: [{ id: "rd_KNOWN", reason: "<img onerror=x>" }],
    };
    const evilListIndex: ListIndex = {
      version: 1,
      items: [
        {
          id: "rd_KNOWN",
          key_prefix: "readings/x",
          url: "https://example.com/k",
          title: "<i>Known</i>",
          status: "ready",
          created_at: "2026-04-01T00:00:00.000Z",
        },
      ],
    };
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ id: "ok" }));
    await sendReadingEmail(
      { manifest: evilManifest, webBaseUrl: WEB_BASE, listIndex: evilListIndex },
      { fetch: fetchFn, apiKey: "k", from: "f@x", to: "t@x" },
    );
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as {
      html: string;
      subject: string;
    };
    // No raw script/img tag from user content survives in the html body.
    expect(body.html).not.toContain("<img onerror=x>");
    expect(body.html).not.toContain("<b>tag</b>");
    expect(body.html).not.toContain("<i>Known</i>");
    // Escaped forms are present (tag value, ampersand from tldr, connection reason).
    expect(body.html).toContain("&lt;b&gt;tag&lt;/b&gt;");
    expect(body.html).toContain("&amp;");
    expect(body.html).toContain("&lt;img onerror=x&gt;");
    expect(body.html).toContain("&lt;i&gt;Known&lt;/i&gt;");
    // Subject is the raw title (passed through to Resend, not HTML).
    expect(body.subject).toBe("Sample <script>alert(1)</script>");
  });

  it("throws ResendError on non-2xx response", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      err(500, { message: "internal" }),
    );
    const e = await sendReadingEmail(
      { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
      { fetch: fetchFn, apiKey: "k", from: "f@x", to: "t@x" },
    ).catch((err) => err);
    expect(e).toBeInstanceOf(ResendError);
    expect((e as ResendError).status).toBe(500);
  });

  it("throws BadResendResponseError when response is missing id", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ not_id: "x" }));
    await expect(
      sendReadingEmail(
        { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
        { fetch: fetchFn, apiKey: "k", from: "f@x", to: "t@x" },
      ),
    ).rejects.toBeInstanceOf(BadResendResponseError);
  });

  it("retries 5xx with backoff when retry deps are supplied (flaky → success)", async () => {
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) return err(503, { message: "try again" });
      return ok({ id: "ok-after-retry" });
    });
    const sleeps: number[] = [];
    const out = await sendReadingEmail(
      { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
      {
        fetch: fetchFn,
        apiKey: "k",
        from: "f@x",
        to: "t@x",
        retry: {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 1,
        },
      },
    );
    expect(out.id).toBe("ok-after-retry");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleeps.length).toBe(1);
  });

  it("propagates RateLimitedError on 429 (no in-process retry)", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ message: "slow" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    );
    const sleeps: number[] = [];
    const e = await sendReadingEmail(
      { manifest: fullManifest, webBaseUrl: WEB_BASE, listIndex },
      {
        fetch: fetchFn as unknown as typeof fetch,
        apiKey: "k",
        from: "f@x",
        to: "t@x",
        retry: {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 1,
        },
      },
    ).catch((err) => err);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect((e as RateLimitedError).retryAfterMs).toBe(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});
