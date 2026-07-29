import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  challengeContentDetail,
  classifyChallengeContent,
  HTML_SCAN_MAX_CHARS,
  MAX_CHALLENGE_EVIDENCE,
  MARKDOWN_SCAN_MAX_CHARS,
} from "../../../scripts/extract-agent-lib/challenge-content";

const FIXTURES = join(__dirname, "../../fixtures/extract-agent/challenge-content");

describe("classifyChallengeContent", () => {
  it("flags a provider-backed challenge when structural and body evidence agree", () => {
    const html = readFileSync(join(FIXTURES, "structural-challenge.html"), "utf-8");
    const verdict = classifyChallengeContent({
      html,
      title: "Just a moment...",
      markdown: [
        "# Checking your browser",
        "",
        "Please verify you are human to continue.",
        "",
        "Enable JavaScript and cookies to continue while we review the security of your connection.",
      ].join("\n"),
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["structural:cloudflare", "body:verify-human"]),
    });
  });

  it("leaves a real article with an embedded comment-form CAPTCHA extractable", () => {
    const html = readFileSync(join(FIXTURES, "captcha-comment-widget.html"), "utf-8");
    const verdict = classifyChallengeContent({
      html,
      title: "Are you a robot? The CAPTCHA arms race",
      markdown: [
        "# Are you a robot? The CAPTCHA arms race",
        "",
        "Publishers increasingly use risk engines to distinguish readers from automated clients.",
        "",
        "This article examines accessibility, privacy, and the economics of modern bot protection.",
        "",
        "One familiar instruction tells readers to complete the CAPTCHA before continuing.",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("does not combine a structural marker and challenge-themed title without body corroboration", () => {
    const verdict = classifyChallengeContent({
      html: '<script src="/cdn-cgi/challenge-platform/widget.js"></script><article>Readable story</article>',
      title: "Just a moment: how bot checks changed publishing",
      markdown: [
        "# Just a moment: how bot checks changed publishing",
        "",
        "Publishers are changing their infrastructure as automated traffic grows.",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("does not treat an article mention of automated queries as reader-directed evidence", () => {
    const verdict = classifyChallengeContent({
      html: [
        '<script src="/cdn-cgi/challenge-platform/widget.js"></script>',
        "<article><h1>Query automation at scale</h1></article>",
      ].join(""),
      title: "Query automation at scale",
      markdown: [
        "# Query automation at scale",
        "",
        "This article compares automated queries with event-driven data ingestion.",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("accepts contextual automated-query copy directed at the current reader", () => {
    const verdict = classifyChallengeContent({
      html: '<script src="/cdn-cgi/challenge-platform/widget.js"></script>',
      markdown: "Your computer or network may be sending automated queries.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["body:automated-traffic"]),
    });
  });

  it("does not treat provider markup shown in an article code sample as live structure", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<article>",
        "<h1>Inside Cloudflare challenge pages</h1>",
        "<p>Readers may see the prompt &quot;Please verify you are human to continue.&quot;</p>",
        "<pre><code>&lt;form id=&quot;challenge-form&quot; action=&quot;/cdn-cgi/challenge-platform/x&quot;&gt;&lt;/form&gt;</code></pre>",
        "</article>",
      ].join(""),
      title: "Inside Cloudflare challenge pages",
      markdown: [
        "# Inside Cloudflare challenge pages",
        "",
        'Readers may see the prompt "Please verify you are human to continue."',
        "",
        '```html\n<form id="challenge-form" action="/cdn-cgi/challenge-platform/x"></form>\n```',
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("does not treat provider text in JSON-LD metadata as live structure", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<article>",
        "<h1>Inside Cloudflare challenge pages</h1>",
        "<p>Readers may see the prompt: Please verify you are human to continue.</p>",
        "</article>",
        '<script type="application/ld+json">',
        '{"description":"The /cdn-cgi/challenge-platform endpoint powers the check."}',
        "</script>",
      ].join(""),
      title: "Inside Cloudflare challenge pages",
      markdown: [
        "# Inside Cloudflare challenge pages",
        "",
        "Readers may see the prompt: Please verify you are human to continue.",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it.each([
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
  ])("treats the standard JavaScript MIME type %s as executable structure", (type) => {
    const verdict = classifyChallengeContent({
      html: `<script type="${type}">window.cf_chl_opt = {};</script>`,
      markdown: "Please verify you are human to continue.",
    });

    expect(verdict.challenge).toBe(true);
  });

  it.each([
    "application/ld+json",
    "application/json",
    "text/plain",
    "text/javascript; charset=utf-8",
  ])("does not treat the data-block script type %s as executable structure", (type) => {
    const verdict = classifyChallengeContent({
      html: [
        `<script type="${type}" id="cf_chl_opt"`,
        ' src="/cdn-cgi/challenge-platform/x">',
        "window.cf_chl_opt = {};",
        "</script>",
      ].join(""),
      markdown: "Please verify you are human to continue.",
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("keeps every deciding family in bounded stable diagnostics", () => {
    const verdict = classifyChallengeContent({
      html: [
        '<form action="/cdn-cgi/challenge-platform/x"></form>',
        '<div class="g-recaptcha"></div>',
        '<div class="h-captcha"></div>',
        '<div id="px-captcha"></div>',
        '<div class="_incapsula_resource"></div>',
        "<script>datadome</script>",
      ].join(""),
      title: "Just a moment...",
      markdown:
        "Please verify you are human to continue. Enable JavaScript and cookies to continue. We detected unusual traffic from your computer network.",
    });

    expect(verdict.challenge).toBe(true);
    if (!verdict.challenge) throw new Error("unreachable");
    expect(verdict.evidence).toHaveLength(MAX_CHALLENGE_EVIDENCE);
    expect(verdict.evidence.some((code) => code.startsWith("structural:"))).toBe(true);
    expect(verdict.evidence.some((code) => code.startsWith("body:"))).toBe(true);
    for (const code of verdict.evidence) expect(code).toMatch(/^(structural|body|title):[a-z-]+$/);

    const detail = challengeContentDetail(verdict, "https://public.example/challenge");
    expect(detail).not.toContain("Please verify");
    expect(detail).not.toContain("challenge-platform");
    expect(detail.length).toBeLessThan(300);
  });

  it("ignores structural and body matches beyond the explicit scan bounds", () => {
    expect(
      classifyChallengeContent({
        html: `<div>${"x".repeat(HTML_SCAN_MAX_CHARS)}</div><form action="/cdn-cgi/challenge-platform/x"></form>`,
        markdown: "Please verify you are human to continue.",
      }),
    ).toEqual({ challenge: false });
    expect(
      classifyChallengeContent({
        html: '<form action="/cdn-cgi/challenge-platform/x"></form>',
        markdown: `${"x".repeat(MARKDOWN_SCAN_MAX_CHARS)} Please verify you are human to continue.`,
      }),
    ).toEqual({ challenge: false });
  });
});
