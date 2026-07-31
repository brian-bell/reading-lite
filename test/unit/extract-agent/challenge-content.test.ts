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

  it("does not turn article or comment-form verification copy into a page-level challenge", () => {
    const prompt = "Please verify you are human to continue.";
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification in online discussion</title></head><body>",
        `<article><h1>Human verification in online discussion</h1><p>${prompt}</p>`,
        "<p>The instruction above is an interface-copy example.</p></article>",
        `<form class="comment-form"><p>${prompt}</p></form>`,
        "</body></html>",
      ].join(""),
      title: "Human verification in online discussion",
      markdown: [
        "# Human verification in online discussion",
        "",
        prompt,
        "",
        "The instruction above is an interface-copy example.",
        "",
        prompt,
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

  it("flags reader-directed human verification when title and body evidence agree", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<p>Please verify you are human to continue.</p>",
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown: "Please verify you are human to continue.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("uses a challenge document title when the extracted title is benign", () => {
    const body = "Please verify you are human to continue.";
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        `<main><p>${body}</p></main>`,
        "</body></html>",
      ].join(""),
      title: "Requested article",
      markdown: body,
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it.each([
    "Please verify you are human to continue.",
    "Please verify <strong>you are human</strong> to continue.",
  ])("flags a text-only challenge whose article UI says: %s", (htmlBody) => {
    const body = "Please verify you are human to continue.";
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<article><h1>Human verification</h1>",
        `<p>${htmlBody}</p>`,
        "<p>Enable JavaScript and cookies to continue.</p></article>",
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown: [
        "# Human verification",
        "",
        body,
        "",
        "Enable JavaScript and cookies to continue.",
      ].join("\n"),
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("keeps challenge form copy visible inside an admitted article shell", () => {
    const body = "Please verify you are human to continue.";
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<article><h1>Human verification</h1>",
        `<form><p>${body}</p></form></article>`,
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown: body,
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("ignores invisible quotation markup inside an article challenge shell", () => {
    const body = "Please verify you are human to continue.";
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<article><h1>Human verification</h1>",
        `<p>${body}</p>`,
        '<q style="visibility:hidden">Example verification copy.</q>',
        "</article></body></html>",
      ].join(""),
      title: "Human verification",
      markdown: body,
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("does not treat explanatory prose beginning with verification copy as challenge UI", () => {
    for (const articleBody of [
      "<p>Please verify you are human to continue is the copy shown to customers.</p>",
      [
        "<p>Please verify you are human to continue.</p>",
        "<div>This is the copy displayed by the service to its customers.</div>",
      ].join(""),
      [
        "<p>Please verify you are human to continue.</p>",
        "<p>Human verification is used by publishers to limit automated traffic.</p>",
      ].join(""),
      "<p><q>Please verify you are human to continue.</q></p>",
    ]) {
      const verdict = classifyChallengeContent({
        html: [
          "<html><head><title>Human verification</title></head><body>",
          `<article><h1>Human verification</h1>${articleBody}</article>`,
          "</body></html>",
        ].join(""),
        title: "Human verification",
        markdown: "Please verify you are human to continue.",
        rendered: true,
      });

      expect(verdict).toEqual({ challenge: false });
    }
  });

  it("accepts verification after a challenge-specific introductory clause", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<p>To protect this site from automated requests, please verify you are human to continue.</p>",
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown:
        "To protect this site from automated requests, please verify you are human to continue.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("preserves HTML line-break boundaries in reader-directed copy", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<p>Please verify you are human<br>to continue.</p>",
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown: "Please verify you are human\nto continue.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it.each([
    {
      title: "Checking your browser",
      body: "Enable JavaScript and cookies to continue.",
      evidence: "body:enable-browser",
    },
    {
      title: "Human verification",
      body: "Complete the security check.",
      evidence: "body:verify-human",
    },
  ])("flags established reader-directed copy: $body", ({ title, body, evidence }) => {
    const verdict = classifyChallengeContent({
      html: `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`,
      title,
      markdown: body,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([evidence]),
    });
  });

  it("flags a bare human-verification imperative only when it is a standalone block", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Are you a robot?</title></head><body>",
        "<p>Verify you are human.</p>",
        "</body></html>",
      ].join(""),
      title: "Are you a robot?",
      markdown: "Verify you are human.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:standalone-verify-human"]),
    });
    expect(
      classifyChallengeContent({
        html: "<html><head><title>Are you a robot?</title></head><body></body></html>",
        title: "Are you a robot?",
        markdown: 'This article examines why sites say "verify you are human" to their readers.',
      }),
    ).toEqual({ challenge: false });
  });

  it("preserves heading structure before normalizing bare verification copy", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<h2>Verify you are human</h2>",
        "<p>Please wait while we validate your connection.</p>",
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown: "## Verify you are human\nPlease wait while we validate your connection.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:standalone-verify-human"]),
    });
  });

  it("flags reader-directed unusual-traffic copy when title and body agree", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Unusual traffic</title></head><body>",
        "<p>Our systems have detected unusual traffic from your computer network.</p>",
        "</body></html>",
      ].join(""),
      title: "Unusual traffic",
      markdown:
        "Our systems have detected unusual traffic from your computer network. This page checks whether the requests came from you.",
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:unusual-traffic", "body:automated-traffic"]),
    });
  });

  it("classifies a text-only interstitial when Readability yields no article", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<main><h1>Human verification</h1>",
        "<button>Please verify you are human to continue.</button></main>",
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("classifies no-article fallback copy in generic visible elements", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<div class=\"verification\"><span>Please verify you are human to continue.</span></div>",
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("keeps no-article body evidence inside the Markdown scan bound", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        `<div>${"x".repeat(MARKDOWN_SCAN_MAX_CHARS)}</div>`,
        "<div>Please verify you are human to continue.</div>",
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("counts visible input values toward the no-article scan bound", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        `<input type="text" value="${"x".repeat(MARKDOWN_SCAN_MAX_CHARS)}">`,
        '<input type="submit" value="Please verify you are human to continue.">',
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it.each(["checkbox", "radio", "password", "color", "file", "range"])(
    "does not treat a %s input value as visible verification copy",
    (type) => {
      const verdict = classifyChallengeContent({
        html: [
          "<html><head><title>Human verification</title></head><body>",
          `<input type="${type}" value="Please verify you are human to continue.">`,
          "</body></html>",
        ].join(""),
        rendered: true,
      });

      expect(verdict).toEqual({ challenge: false });
    },
  );

  it("does not treat hidden input state as visible verification copy", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        '<input type="hidden" value="Please verify you are human to continue.">',
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("does not leak no-article quote or code text through ancestor blocks", () => {
    for (const content of [
      "<blockquote>Please verify you are human to continue.</blockquote>",
      "<pre><code>Please verify you are human to continue.</code></pre>",
    ]) {
      expect(
        classifyChallengeContent({
          html: `<html><head><title>Human verification examples</title></head><body>${content}</body></html>`,
          rendered: true,
        }),
      ).toEqual({ challenge: false });
    }
  });

  it("does not treat hidden no-article containers as visible verification copy", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<div hidden>Please verify you are human to continue.</div>",
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("still treats aria-hidden text as visually present", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        '<div aria-hidden="true">Please verify you are human to continue.</div>',
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("does not reintroduce closed disclosure content through extracted Markdown", () => {
    const closed = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification examples</title></head><body>",
        "<details><summary>Example prompt</summary>",
        "<p>Please verify you are human to continue.</p></details>",
        "</body></html>",
      ].join(""),
      title: "Human verification examples",
      markdown: "Example prompt\n\nPlease verify you are human to continue.",
      rendered: true,
    });
    const open = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        "<details open><summary>Security check</summary>",
        "<p>Please verify you are human to continue.</p></details>",
        "</body></html>",
      ].join(""),
      title: "Human verification",
      markdown: "Security check\n\nPlease verify you are human to continue.",
      rendered: true,
    });

    expect(closed).toEqual({ challenge: false });
    expect(open).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it("does not treat a closed dialog as visible verification copy", () => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification examples</title></head><body>",
        "<dialog>Please verify you are human to continue.</dialog>",
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it.each([
    "display: none !important",
    "visibility:hidden!important",
    "visibility: collapse",
  ])("does not treat inline %s containers as visible verification copy", (style) => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        `<div style="${style}">Please verify you are human to continue.</div>`,
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it.each([
    "display:none; display:block",
    "display:none; display:block !important",
    "display:none !important; display:block !important",
    "visibility:hidden; visibility:visible",
    "visibility:hidden; visibility:visible !important",
  ])("honors an inline cascade that leaves verification copy visible: %s", (style) => {
    const body = "Please verify you are human to continue.";
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        `<div style="${style}">${body}</div>`,
        "</body></html>",
      ].join(""),
      markdown: body,
      rendered: true,
    });

    expect(verdict).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
    });
  });

  it.each([
    "display:none !important; display:block",
    "visibility:hidden !important; visibility:visible",
  ])("honors an important inline declaration that keeps verification copy hidden: %s", (style) => {
    const verdict = classifyChallengeContent({
      html: [
        "<html><head><title>Human verification</title></head><body>",
        `<div style="${style}">Please verify you are human to continue.</div>`,
        "</body></html>",
      ].join(""),
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it.each(["hidden", "collapse"])(
    "allows a visible descendant to override inherited visibility:%s",
    (visibility) => {
      const body = "Please verify you are human to continue.";
      const verdict = classifyChallengeContent({
        html: [
          "<html><head><title>Human verification</title></head><body>",
          `<div style="visibility:${visibility}">Hidden introduction`,
          `<main style="visibility:visible">${body}</main></div>`,
          "</body></html>",
        ].join(""),
        markdown: body,
        rendered: true,
      });

      expect(verdict).toMatchObject({
        challenge: true,
        evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
      });
    },
  );

  it.each([
    { parent: "visible", child: "initial" },
    { parent: "visible", child: "inherit" },
    { parent: "visible", child: "unset" },
    { parent: "hidden", child: "inherit" },
    { parent: "hidden", child: "unset" },
  ])(
    "resolves visibility:$child against a $parent parent",
    ({ parent, child }) => {
      const body = "Please verify you are human to continue.";
      const verdict = classifyChallengeContent({
        html: [
          "<html><head><title>Human verification</title></head><body>",
          `<div style="visibility:${parent}">`,
          `<main style="visibility:${child}">${body}</main></div>`,
          "</body></html>",
        ].join(""),
        markdown: body,
        rendered: true,
      });

      if (parent === "hidden" && child !== "initial") {
        expect(verdict).toEqual({ challenge: false });
      } else {
        expect(verdict).toMatchObject({
          challenge: true,
          evidence: expect.arrayContaining(["title:human-check", "body:verify-human"]),
        });
      }
    },
  );

  it("does not overflow the stack on deeply nested challenge-shaped HTML", () => {
    const depth = 20_000;
    const html = [
      "<html><head><title>Human verification</title></head><body>",
      "<div>".repeat(depth),
      "Please verify you are human to continue.",
      "</div>".repeat(depth),
      "</body></html>",
    ].join("");

    expect(() => classifyChallengeContent({ html, rendered: true })).not.toThrow();
  });

  it("does not turn fenced verification examples into reader instructions", () => {
    const verdict = classifyChallengeContent({
      html: "<html><head><title>Human verification examples</title></head><body></body></html>",
      title: "Human verification examples",
      markdown: [
        "# Human verification examples",
        "",
        "A provider may render this heading:",
        "",
        "```text",
        "## Verify you are human",
        "```",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("keeps shorter same-character fences inside a longer code fence", () => {
    const verdict = classifyChallengeContent({
      html: "<html><head><title>Human verification examples</title></head><body></body></html>",
      title: "Human verification examples",
      markdown: [
        "# Human verification examples",
        "",
        "````text",
        "```",
        "Please verify you are human to continue.",
        "````",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("does not turn inline-code-only examples into reader instructions", () => {
    for (const example of [
      "`Please verify you are human to continue.`",
      "**`Please verify you are human to continue.`**",
      "*`Please verify you are human to continue.`*",
      "[`Please verify you are human to continue.`](https://example.com/prompt)",
      "[`Please verify you are human to continue.`](https://example.com/a\\(b\\))",
    ]) {
      const verdict = classifyChallengeContent({
        html: "<html><head><title>Human verification examples</title></head><body></body></html>",
        title: "Human verification examples",
        markdown: [
          "# Human verification examples",
          "",
          example,
        ].join("\n"),
      });

      expect(verdict).toEqual({ challenge: false });
    }
  });

  it("does not turn Markdown list examples into reader instructions", () => {
    const verdict = classifyChallengeContent({
      html: "<html><head><title>Human verification examples</title></head><body></body></html>",
      title: "Human verification examples",
      markdown: [
        "# Human verification examples",
        "",
        "A provider may render:",
        "",
        "- *Please verify you are human to continue.*",
      ].join("\n"),
    });

    expect(verdict).toEqual({ challenge: false });
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
