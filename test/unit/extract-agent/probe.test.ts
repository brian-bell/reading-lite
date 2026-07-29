import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseProbeArgs,
  PROBE_TITLE_MAX_CHARS,
  readBoundedUtf8,
  runProbe,
  type ProbeDeps,
} from "../../../scripts/extract-agent-lib/probe";

const FIXTURES = join(__dirname, "../../fixtures/extract-agent/challenge-content");

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    readFile: vi.fn(async (path: string) => readFileSync(path, "utf-8")),
    fetch: vi.fn() as unknown as typeof fetch,
    lookup: vi.fn(),
    renderPage: vi.fn(async (url: string, options: { offlineHtml?: string }) => {
      if (options.offlineHtml === undefined) throw new Error("test renderer requires offlineHtml");
      return { html: options.offlineHtml, finalUrl: url };
    }) as ProbeDeps["renderPage"],
    maxBytes: 20 * 1024 * 1024,
    ...overrides,
  };
}

describe("runProbe", () => {
  it("runs an offline fixture through both real tiers without network or state dependencies", async () => {
    const html = readFileSync(join(FIXTURES, "structural-challenge.html"), "utf-8");
    const renderPage = vi.fn(async (
      url: string,
      options: { offlineHtml?: string },
    ) => ({
      html: options.offlineHtml!,
      finalUrl: url,
    }));
    const probeDeps = deps({
      renderPage: renderPage as ProbeDeps["renderPage"],
    });
    const results = await runProbe(
      {
        htmlPath: join(FIXTURES, "structural-challenge.html"),
        sourceUrl: "https://fixture.invalid/structural-challenge",
        tier: "both",
        json: true,
      },
      probeDeps,
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.tier)).toEqual(["static", "headless"]);
    for (const result of results) {
      expect(result).toMatchObject({
        outcome: "challenge",
        title: "Just a moment...",
        normalized_character_count: expect.any(Number),
        evidence_codes: expect.arrayContaining(["structural:cloudflare", "body:verify-human"]),
      });
      expect(result.normalized_character_count).toBeGreaterThan(0);
    }
    expect(probeDeps.readFile).toHaveBeenCalledOnce();
    expect(probeDeps.fetch).not.toHaveBeenCalled();
    expect(probeDeps.lookup).not.toHaveBeenCalled();
    expect(renderPage).toHaveBeenCalledWith(
      "https://fixture.invalid/structural-challenge",
      expect.objectContaining({ offlineHtml: html, readOnly: true }),
    );
    expect(JSON.stringify(results)).not.toContain("Please verify you are human");
  });

  it("renders offline fixture HTML before classifying the headless tier", async () => {
    const sourceHtml = [
      "<html><body>",
      "<script>document.body.innerHTML = '<form action=\"/cdn-cgi/challenge-platform/x\"></form><button>Please verify you are human to continue.</button>';</script>",
      "</body></html>",
    ].join("");
    const renderedHtml = [
      "<html><body>",
      '<form action="/cdn-cgi/challenge-platform/x"></form>',
      "<button>Please verify you are human to continue.</button>",
      "</body></html>",
    ].join("");
    const renderPage = vi.fn(async (
      url: string,
      options: { offlineHtml?: string },
    ) => {
      expect(url).toBe("https://fixture.invalid/dynamic-challenge");
      expect(options.offlineHtml).toBe(sourceHtml);
      return {
        html: renderedHtml,
        finalUrl: "https://fixture.invalid/dynamic-challenge",
      };
    });
    const results = await runProbe(
      {
        htmlPath: "/tmp/dynamic-challenge.html",
        sourceUrl: "https://fixture.invalid/dynamic-challenge",
        tier: "both",
        json: true,
      },
      deps({
        readFile: vi.fn(async () => sourceHtml),
        renderPage: renderPage as ProbeDeps["renderPage"],
      }),
    );

    expect(results.map((result) => result.outcome)).toEqual(["no_article", "challenge"]);
    expect(renderPage).toHaveBeenCalledOnce();
  });

  it("uses only page GET and render dependencies for a live URL", async () => {
    const html = readFileSync(join(FIXTURES, "structural-challenge.html"), "utf-8");
    const pageFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const renderPage = vi.fn(async () => ({
      html,
      finalUrl: "https://public.example/challenge",
    }));
    const lookup = vi.fn(async () => [{ address: "93.184.216.34" }]);
    const probeDeps = deps({
      fetch: pageFetch as unknown as typeof fetch,
      renderPage,
      lookup,
    });

    const results = await runProbe(
      {
        url: "https://public.example/challenge",
        tier: "both",
        json: true,
      },
      probeDeps,
    );

    expect(results.map((result) => result.outcome)).toEqual(["challenge", "challenge"]);
    expect(probeDeps.readFile).not.toHaveBeenCalled();
    expect(pageFetch).toHaveBeenCalledOnce();
    for (const [, init] of pageFetch.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
    expect(renderPage).toHaveBeenCalledOnce();
    expect(renderPage).toHaveBeenCalledWith(
      "https://public.example/challenge",
      expect.objectContaining({ readOnly: true }),
    );
    expect(JSON.stringify(results)).not.toContain("Please verify you are human");
  });

  it("bounds extracted titles in probe results", async () => {
    const title = "T".repeat(PROBE_TITLE_MAX_CHARS + 500);
    const html = [
      `<html><head><title>${title}</title></head><body><article>`,
      "<h1>Reference</h1>",
      ...Array.from(
        { length: 8 },
        (_, i) => `<p>Paragraph ${i} has enough useful article prose for a stable readability result.</p>`,
      ),
      "</article></body></html>",
    ].join("");
    const results = await runProbe(
      {
        htmlPath: "/tmp/long-title.html",
        sourceUrl: "https://fixture.invalid/article",
        tier: "both",
        json: true,
      },
      deps({ readFile: vi.fn(async () => html) }),
    );

    expect(results.map((result) => result.outcome)).toEqual(["extracted", "extracted"]);
    for (const result of results) {
      expect(result.title).toHaveLength(PROBE_TITLE_MAX_CHARS);
    }
  });

  it("bounds challenge titles in probe results", async () => {
    const title = "Challenge ".repeat(PROBE_TITLE_MAX_CHARS);
    const html = readFileSync(
      join(FIXTURES, "structural-challenge.html"),
      "utf-8",
    ).replace("Just a moment...", title);
    const results = await runProbe(
      {
        htmlPath: "/tmp/long-challenge-title.html",
        sourceUrl: "https://fixture.invalid/challenge",
        tier: "both",
        json: true,
      },
      deps({ readFile: vi.fn(async () => html) }),
    );

    expect(results.map((result) => result.outcome)).toEqual(["challenge", "challenge"]);
    for (const result of results) {
      expect(result.title).toHaveLength(PROBE_TITLE_MAX_CHARS);
    }
  });
});

describe("readBoundedUtf8", () => {
  it("rejects an offline fixture before reading beyond the configured byte cap", async () => {
    const path = join(FIXTURES, "structural-challenge.html");

    await expect(readBoundedUtf8(path, 32)).rejects.toThrow(/over the 32 byte cap/i);
    await expect(readBoundedUtf8(path, 20 * 1024 * 1024)).resolves.toContain(
      "cdn-cgi/challenge-platform",
    );
  });
});

describe("parseProbeArgs", () => {
  it("accepts exactly one offline or live source and validates tier requirements", () => {
    expect(
      parseProbeArgs([
        "--html",
        "/tmp/challenge.html",
        "--source-url",
        "https://fixture.invalid/challenge",
        "--tier",
        "both",
        "--json",
      ]),
    ).toEqual({
      htmlPath: "/tmp/challenge.html",
      sourceUrl: "https://fixture.invalid/challenge",
      tier: "both",
      json: true,
    });
    expect(parseProbeArgs(["--url", "https://public.example/a", "--tier", "static", "--json"])).toEqual({
      url: "https://public.example/a",
      tier: "static",
      json: true,
    });
    expect(() => parseProbeArgs(["--html", "/tmp/a.html", "--url", "https://public.example/a"])).toThrow(
      /exactly one/i,
    );
    expect(() => parseProbeArgs(["--html", "/tmp/a.html"])).toThrow(/source-url/i);
    expect(() => parseProbeArgs(["--url", "https://public.example/a", "--tier", "wat"])).toThrow(/tier/i);
  });
});
