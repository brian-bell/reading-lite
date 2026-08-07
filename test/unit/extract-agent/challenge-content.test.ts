import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  challengeContentDetail,
  classifyChallengeContent,
  HTML_SCAN_MAX_CHARS,
  MAX_CHALLENGE_EVIDENCE,
  MARKDOWN_SCAN_MAX_CHARS,
  normalizedMarkdownChars,
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

  it.each([
    ["JavaScript Detections", "/cdn-cgi/challenge-platform/scripts/jsd/main.js"],
    ["the historical invisible probe", "/cdn-cgi/challenge-platform/h/b/scripts/invisible.js"],
  ])("does not treat %s as challenge structure", (_label, src) => {
    // Both are injected into every HTML page on a zone and are force-enabled
    // under Bot Fight Mode, so on such a zone this article — which quotes a
    // block page's own wording, as an article about bot checks would — must stay
    // extractable. The orchestrate paths remain structural evidence.
    const verdict = classifyChallengeContent({
      html: `<script src="${src}"></script><article><h1>Inside the bot wars</h1></article>`,
      title: "Inside the bot wars",
      markdown: [
        "# Inside the bot wars",
        "",
        "Operators complain that this website is using a security service to protect itself, and readers see the result.",
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
      html: '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>',
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
        "<pre><code>&lt;form id=&quot;challenge-form&quot; action=&quot;/cdn-cgi/challenge-platform/h/b/orchestrate/x&quot;&gt;&lt;/form&gt;</code></pre>",
        "</article>",
      ].join(""),
      title: "Inside Cloudflare challenge pages",
      markdown: [
        "# Inside Cloudflare challenge pages",
        "",
        'Readers may see the prompt "Please verify you are human to continue."',
        "",
        '```html\n<form id="challenge-form" action="/cdn-cgi/challenge-platform/h/b/orchestrate/x"></form>\n```',
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
        '{"description":"The /cdn-cgi/challenge-platform/h/b/orchestrate endpoint powers the check."}',
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
        '<form action="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></form>',
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

  it("requires a score of six for wall content over 4,000 normalized characters", () => {
    const filler = "Membership access details and publication benefits. ".repeat(100);
    const html = [
      "<html><head><title>Why City Trees Are Moving North</title></head><body><main>",
      "<h1>Why City Trees Are Moving North</h1>",
      `<p>${filler}</p>`,
      "<p>Subscribe to continue reading this article.</p>",
      "<p>Already a subscriber? Sign in to your account.</p>",
      "<p>Get unlimited access to every climate story.</p>",
      "</main></body></html>",
    ].join("");
    const markdown = [
      "# Why City Trees Are Moving North",
      "",
      filler,
      "",
      "Subscribe to continue reading this article.",
      "",
      "Already a subscriber? Sign in to your account.",
      "",
      "Get unlimited access to every climate story.",
    ].join("\n");

    expect(normalizedMarkdownChars(markdown)).toBeGreaterThan(4_000);
    expect(classifyChallengeContent({ html, markdown })).toEqual({ challenge: false });
  });

  it("uses the full visible body for the long threshold when Markdown is truncated", () => {
    const filler = "Visible publication background and membership context. ".repeat(100);
    const strong = "Subscribe to continue reading this article.";
    const supports = [
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every climate story.",
    ];
    const html = [
      "<html><head><title>Why City Trees Are Moving North</title></head><body><main>",
      `<p>${filler}</p><p>${strong}</p>`,
      ...supports.map((support) => `<p>${support}</p>`),
      "</main></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: [strong, ...supports].join("\n\n"),
    })).toEqual({ challenge: false });
  });

  it("counts visually present aria-hidden text toward the long threshold", () => {
    const filler = "Visible publication background and membership context. ".repeat(100);
    const strong = "Subscribe to continue reading this article.";
    const supports = [
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every climate story.",
    ];
    const html = [
      "<html><head><title>Why City Trees Are Moving North</title></head><body><main>",
      `<div aria-hidden="true">${filler}</div><p>${strong}</p>`,
      ...supports.map((support) => `<p>${support}</p>`),
      "</main></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: [strong, ...supports].join("\n\n"),
    })).toEqual({ challenge: false });
  });

  it("does not count a closed dialog toward the long threshold", () => {
    const hidden = "Unavailable dialog text and plan detail. ".repeat(130);
    const instruction = "Subscribe to continue reading this article.";
    const html = [
      "<html><head><title>Subscribe to continue reading</title></head><body>",
      `<p>${instruction}</p><dialog>${hidden}</dialog>`,
      "</body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: `${instruction}\n\n${hidden}`,
    })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        "wall:continue-reading",
      ]),
    });
  });

  it("counts a visible descendant of a visibility-hidden ancestor", () => {
    const filler = "Visible descendant publication context and reporting detail. ".repeat(90);
    const strong = "Subscribe to continue reading this article.";
    const supports = [
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every climate story.",
    ];
    const html = [
      "<html><head><title>Why City Trees Are Moving North</title></head><body><main>",
      `<div style="visibility:hidden"><div style="visibility:visible">${filler}</div></div>`,
      `<p>${strong}</p>`,
      ...supports.map((support) => `<p>${support}</p>`),
      "</main></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: [strong, ...supports].join("\n\n"),
    })).toEqual({ challenge: false });
  });

  it("requires strong wall evidence even when title and support copy would reach the threshold", () => {
    const html = [
      "<html><head><title>Subscribe to continue reading</title></head><body><main>",
      "<p>Already a subscriber? Sign in to your account.</p>",
      "<p>Get unlimited access to every climate story.</p>",
      "</main></body></html>",
    ].join("");
    const markdown = [
      "Already a subscriber? Sign in to your account.",
      "",
      "Get unlimited access to every climate story.",
    ].join("\n");

    expect(classifyChallengeContent({ html, markdown })).toEqual({ challenge: false });
  });

  it.each([
    "Register to continue reading.",
    "Create a free account to continue.",
    "This article is for subscribers.",
    "Become a member to read the full story.",
    "Sign in to read the full article.",
    "To continue reading this article, subscribe now.",
  ])("recognizes reader-directed strong wall copy: %s", (instruction) => {
    const html = [
      "<html><head><title>Subscribe to continue reading</title></head><body>",
      `<main><p>${instruction}</p></main>`,
      "</body></html>",
    ].join("");

    expect(classifyChallengeContent({ html, markdown: instruction })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        expect.stringMatching(/^wall:[a-z-]+$/),
      ]),
    });
  });

  it("recognizes an explicit subscribers-only wall title", () => {
    const instruction = "This article is for subscribers only.";
    const html = [
      "<html><head><title>This article is for subscribers only</title></head><body>",
      `<main><p>${instruction}</p></main>`,
      "</body></html>",
    ].join("");

    expect(classifyChallengeContent({ html, markdown: instruction })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        "wall:subscriber-content",
      ]),
    });
  });

  it("counts a depleted free-article allowance as distinct wall support", () => {
    const html = [
      "<html><head><title>Using Online Database Sites</title></head><body><main>",
      "<p>This article is for subscribers only.</p>",
      "<p>0 free articles left this month.</p>",
      "<p>Get unlimited access to premium articles.</p>",
      "</main></body></html>",
    ].join("");
    const markdown = [
      "This article is for subscribers only.",
      "",
      "0 free articles left this month.",
      "",
      "Get unlimited access to premium articles.",
    ].join("\n");

    expect(classifyChallengeContent({ html, markdown })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "wall:subscriber-content",
        "wall_support:free-articles",
        "wall_support:unlimited-access",
      ]),
    });
  });

  it("counts free registration and an existing subscription as distinct wall support", () => {
    const html = [
      "<html><head><title>Register</title></head><body><main>",
      "<h2>Register to continue reading this premium article.</h2>",
      "<p>It's free!</p>",
      "<p>Already have a subscription? Sign in.</p>",
      "</main></body></html>",
    ].join("");
    const markdown = [
      "Register to continue reading this premium article.",
      "",
      "It's free!",
      "",
      "Already have a subscription? Sign in.",
    ].join("\n");

    expect(classifyChallengeContent({ html, markdown })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "wall:continue-reading",
        "wall_support:free-registration",
        "wall_support:existing-subscriber",
      ]),
    });
  });

  it.each([
    {
      title: "Premium Content",
      strong: "Please subscribe to continue reading.",
      supports: [
        "Get unlimited access to every edition.",
        "Already a member? Sign in.",
      ],
      evidence: [
        "wall_support:unlimited-access",
        "wall_support:existing-subscriber",
      ],
    },
    {
      title: "The Irish Field podcasts",
      strong: "This content is available to digital subscribers only.",
      supports: [
        "You have no more free articles this month.",
        "Get unlimited access to subscriber reporting.",
      ],
      evidence: [
        "wall_support:free-articles",
        "wall_support:unlimited-access",
      ],
    },
    {
      title: "Taking the lead",
      strong: "Subscribe to continue reading.",
      supports: [
        "Get unlimited access to The MJ.",
        "Full website content includes exclusive analysis.",
      ],
      evidence: [
        "wall_support:unlimited-access",
        "wall_support:full-access",
      ],
    },
    {
      title: "Vanity Fair Contributors",
      strong: "Subscribe to continue.",
      supports: [
        "Get unlimited access to exclusive newsletters.",
        "Your first month is free.",
        "Already a subscriber? Sign in.",
      ],
      evidence: [
        "wall_support:unlimited-access",
        "wall_support:free-trial",
        "wall_support:existing-subscriber",
      ],
    },
  ])("classifies current provider-neutral wall copy for $title", ({ title, strong, supports, evidence }) => {
    const html = [
      `<html><head><title>${title}</title></head><body><main>`,
      `<p>${strong}</p>`,
      ...supports.map((support) => `<p>${support}</p>`),
      "</main></body></html>",
    ].join("");
    const markdown = [strong, "", ...supports.flatMap((support) => [support, ""])].join("\n");

    expect(classifyChallengeContent({ html, markdown })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        expect.stringMatching(/^wall:[a-z-]+$/),
        ...evidence,
      ]),
    });
  });

  it("counts a hyphenated subscriber-only line as wall support", () => {
    const lines = [
      "Subscribe to continue reading this article",
      "Already a subscriber?",
      "Subscriber-only content",
    ];
    const html = [
      "<html><head><title>The council vote explained</title></head><body><main>",
      `<h2>${lines[0]}</h2>`,
      ...lines.slice(1).map((line) => `<p>${line}</p>`),
      "</main></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: lines.join("\n\n"),
    })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "wall:continue-reading",
        "wall_support:existing-subscriber",
        "wall_support:subscriber-only",
      ]),
    });
  });

  it("recognizes a wall inside an article wrapper without admitting article prose", () => {
    const html = [
      "<html><head><title>Welcome to My Story</title></head><body><article>",
      "<h1>Welcome to My Story</h1>",
      "<h2>Subscribe to continue reading</h2>",
      "<p>Subscribe to get access to the rest of this post and other subscriber-only content.</p>",
      "<time>September 28, 2025</time>",
      "<label>Type your email… <input type=\"email\"></label>",
      "<button>Subscribe</button>",
      "<p>Already a paid subscriber?</p>",
      "<span>Like</span>",
      "<p>Posted in Uncategorized</p>",
      "</article></body></html>",
    ].join("");
    const markdown = [
      "# Welcome to My Story",
      "",
      "## Subscribe to continue reading",
      "",
      "Subscribe to get access to the rest of this post and other subscriber-only content.",
      "",
      "September 28, 2025",
      "",
      "Type your email…",
      "",
      "Subscribe",
      "",
      "Already a paid subscriber?",
      "",
      "Like",
      "",
      "Posted in Uncategorized",
    ].join("\n");

    expect(classifyChallengeContent({ html, markdown })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "wall:continue-reading",
        "wall_support:subscriber-access",
        "wall_support:existing-subscriber",
      ]),
    });
  });

  it("recognizes an explicit-title wall inside an article wrapper without support copy", () => {
    const instruction = "Subscribe to continue reading this article.";
    const html = [
      "<html><head><title>Subscribe to continue reading</title></head><body><article>",
      "<h1>Subscribe to continue reading</h1>",
      `<p>${instruction}</p>`,
      "</article></body></html>",
    ].join("");

    expect(classifyChallengeContent({ html, markdown: instruction })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        "wall:continue-reading",
      ]),
    });
  });

  it("recognizes an article wall whose exact title only survives extraction", () => {
    // Publishers commonly leave the original story or the bare brand in
    // <title> while the visible wall heading carries the offer, and Readability
    // promotes that heading to the extracted title. The wall score already
    // reads both titles, so the article-shell gate has to as well.
    const instruction = "Subscribe to continue reading this article.";
    const html = [
      "<html><head><title>The Evening Standard</title></head><body><article>",
      "<h1>Subscribe to continue reading</h1>",
      `<p>${instruction}</p>`,
      "</article></body></html>",
    ].join("");
    const markdown = ["# Subscribe to continue reading", "", instruction].join("\n");

    expect(classifyChallengeContent({
      html,
      markdown,
      title: "Subscribe to continue reading",
    })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        "wall:continue-reading",
      ]),
    });
  });

  it("recognizes a text-heavy wall wrapped in an article landmark", () => {
    const fixture = readFileSync(
      join(FIXTURES, "wall-long-original-title.html"),
      "utf-8",
    );
    const html = fixture
      .replace("<main>", "<article>")
      .replace("</main>", "</article>");

    expect(classifyChallengeContent({ html })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "wall:continue-reading",
        "wall_support:existing-subscriber",
        "wall_support:unlimited-access",
      ]),
      normalizedChars: expect.any(Number),
    });
  });

  it("keeps an article with an inline subscription promotion extractable", () => {
    const opening = [
      "The first overnight passenger train in more than a decade left the valley station shortly after sunset, carrying commuters toward towns that lost late service during earlier budget cuts.",
      "Transit planners restored the route after a year-long trial showed that evening buses were routinely full and that weekend visitors were driving to trailheads before dawn.",
    ];
    const promotion = [
      "Subscribe to continue reading this article.",
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every local story.",
    ];
    const closing = [
      "The new timetable uses existing track and refurbished sleeper cars, but stations along the corridor received lighting and accessibility upgrades before service resumed.",
      "Officials will review ridership, reliability, and winter operating costs after six months, and local governments have committed bridge funding if ticket revenue stabilizes slowly.",
    ];
    const build = (promotionLeads: boolean) => [
      "<html><head><title>Night Trains Return to the Mountain Corridor</title></head><body><article>",
      "<h1>Night Trains Return to the Mountain Corridor</h1>",
      ...(promotionLeads ? [`<section>${promotion.map((line) => `<p>${line}</p>`).join("")}</section>`] : []),
      ...opening.map((paragraph) => `<p>${paragraph}</p>`),
      ...(promotionLeads ? [] : [`<section>${promotion.map((line) => `<p>${line}</p>`).join("")}</section>`]),
      ...closing.map((paragraph) => `<p>${paragraph}</p>`),
      "</article></body></html>",
    ].join("");
    const markdown = [...opening, ...promotion, ...closing].join("\n\n");

    // The promotion is a wall shape wherever it sits, so position alone must not
    // decide: a readable story stays extractable with the offer above or below it.
    expect(classifyChallengeContent({ html: build(false), markdown }))
      .toEqual({ challenge: false });
    expect(classifyChallengeContent({ html: build(true), markdown }))
      .toEqual({ challenge: false });
  });

  it("keeps a long article carrying a subscription promotion extractable", () => {
    // Four supports, so the offer alone reaches the long threshold of 6: the
    // wrapper rule is the only thing standing between this article and a wall
    // verdict, and the assertions below fail if it stops holding.
    const promotion = [
      "Subscribe to continue reading this article.",
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every local story.",
      "Start your free trial today.",
      "Cancel anytime.",
    ];
    const offer = `<section>${promotion.map((line) => `<p>${line}</p>`).join("")}</section>`;
    const sentence = "The corridor study collected ridership counts, weather delays, and maintenance windows across four seasons before the transit board voted on the restored timetable. ";
    const build = (story: string, extras: string, promotionLeads: boolean) => [
      "<html><head><title>Night Trains Return to the Mountain Corridor</title></head><body><article>",
      "<h1>Night Trains Return to the Mountain Corridor</h1>",
      ...(promotionLeads ? [offer] : []),
      `<p>${story}</p>`,
      ...(promotionLeads ? [] : [offer]),
      extras,
      "</article></body></html>",
    ].join("");

    // Body prose ahead of the offer disqualifies the wrapper: a wall replaces
    // the article, it does not follow it.
    const story = sentence.repeat(30);
    expect(normalizedMarkdownChars(story)).toBeGreaterThan(4_000);
    expect(classifyChallengeContent({
      html: build(story, "", false),
      markdown: [story, ...promotion].join("\n\n"),
    })).toEqual({ challenge: false });

    // An aside counts toward neither the evidence blocks nor the threshold, so
    // it must not push the wrapper onto the relaxed rule while the page is
    // still scored against the lower bar — the offer leads here, so nothing
    // else would stop the verdict.
    const shortStory = sentence.repeat(20);
    const related = `<aside>${"Related coverage of the valley line and the winter service review. ".repeat(20)}</aside>`;
    expect(normalizedMarkdownChars(shortStory)).toBeLessThan(4_000);
    expect(classifyChallengeContent({
      html: build(shortStory, related, true),
      markdown: [...promotion, shortStory].join("\n\n"),
    })).toEqual({ challenge: false });
  });

  it("orders a wrapper's own text where it reads, not at its start or end tag", () => {
    const story = "The corridor study collected ridership counts, weather delays, and maintenance windows across four seasons before the transit board voted on the restored timetable. "
      .repeat(15);
    const instruction = "Subscribe to continue reading this article.";
    const offers = [
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every local story.",
      "Start your free trial today.",
      "Cancel anytime.",
    ];
    const page = (entry: string) => [
      "<html><head><title>Night Trains Return to the Mountain Corridor</title></head><body><article>",
      "<h1>Night Trains Return to the Mountain Corridor</h1>",
      `<div class="entry">${entry}</div>`,
      "</article></body></html>",
    ].join("");
    const markdown = [story, story, instruction, ...offers].join("\n\n");

    // The offer trails the story as the wrapper's own inline text: filing the
    // wrapper at its start tag would read it as leading the article.
    expect(classifyChallengeContent({
      html: page([
        `<p>${story}</p><p>${story}</p>`,
        ...offers.map((offer) => `<p>${offer}</p>`),
        `<a href="/subscribe">${instruction}</a>`,
      ].join("")),
      markdown,
    })).toEqual({ challenge: false });

    // The mirror: the story is the wrapper's own inline text and the offer is
    // in child blocks, so filing the wrapper last would hide the prose.
    expect(classifyChallengeContent({
      html: page([
        story,
        story,
        `<p>${instruction}</p>`,
        ...offers.map((offer) => `<p>${offer}</p>`),
      ].join("")),
      markdown,
    })).toEqual({ challenge: false });

    // A hidden inline node is part of neither the wrapper's block text nor the
    // position that text is filed at, so it cannot pull the block forward.
    for (
      const concealed of [
        "<span hidden>Sponsored</span>",
        "<span style=\"display:none\">Sponsored</span>",
        "<span style=\"visibility:hidden\">Sponsored</span>",
        // Concealed, but re-showing a descendant: that text is visible, so it
        // does mark where the wrapper's own text starts.
        "<span style=\"visibility:hidden\"><em style=\"visibility:visible\">Note</em></span>",
        // Punctuation alone survives a trim but normalizes to nothing, so it
        // leaves no block text to mark a position with.
        "&mdash;",
      ]
    ) {
      expect(classifyChallengeContent({
        html: page([
          concealed,
          `<p>${story}</p><p>${story}</p>`,
          ...offers.map((offer) => `<p>${offer}</p>`),
          `<a href="/subscribe">${instruction}</a>`,
        ].join("")),
        markdown,
      })).toEqual({ challenge: false });
    }

    // An inline element holding both the wrapper's own text and blocks of its
    // own leaves the merged block no position to take, so the wrapper is not a
    // shell at all rather than one filed at a guessed spot.
    for (const inline of ["span", "em", "label"]) {
      expect(classifyChallengeContent({
        html: page([
          `<${inline}><p>${story}</p><p>${story}</p><a href="/subscribe">${instruction}</a></${inline}>`,
          ...offers.map((offer) => `<p>${offer}</p>`),
        ].join("")),
        markdown,
      })).toEqual({ challenge: false });
    }
  });

  it("allows an explicit wall title, strong wall, and two supports to reach the long threshold", () => {
    const filler = "Membership access details and publication benefits. ".repeat(100);
    const html = [
      "<html><head><title>Subscribe to continue reading</title></head><body><main>",
      `<p>${filler}</p>`,
      "<p>Subscribe to continue reading this article.</p>",
      "<p>Already a subscriber? Sign in to your account.</p>",
      "<p>Get unlimited access to every climate story.</p>",
      "</main></body></html>",
    ].join("");
    const markdown = [
      "# Subscribe to continue reading",
      "",
      filler,
      "",
      "Subscribe to continue reading this article.",
      "",
      "Already a subscriber? Sign in to your account.",
      "",
      "Get unlimited access to every climate story.",
    ].join("\n");

    expect(normalizedMarkdownChars(markdown)).toBeGreaterThan(4_000);
    expect(classifyChallengeContent({ html, markdown })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        "wall:continue-reading",
        "wall_support:existing-subscriber",
        "wall_support:unlimited-access",
      ]),
    });
  });

  it("requires visible wall evidence to agree between HTML and extracted Markdown", () => {
    const visible = "Subscribe to continue reading this article.";
    const support = "Already a subscriber? Sign in to your account.";
    const htmlOnly = classifyChallengeContent({
      html: `<html><head><title>Subscribe to continue reading</title></head><body><p>${visible}</p><p>${support}</p></body></html>`,
      markdown: "The complete requested article remains readable.",
    });
    const markdownOnly = classifyChallengeContent({
      html: "<html><head><title>Subscribe to continue reading</title></head><body><p>The complete requested article remains readable.</p></body></html>",
      markdown: `${visible}\n\n${support}`,
    });

    expect(htmlOnly).toEqual({ challenge: false });
    expect(markdownOnly).toEqual({ challenge: false });
  });

  it("ignores a subscription promotion in a footer after a complete non-article story", () => {
    const story = [
      "The city council approved the river restoration plan after months of public hearings.",
      "Engineers will begin surveying the banks next week, with construction scheduled for autumn.",
      "Residents can review the complete timetable and environmental report at the public library.",
    ].join(" ");
    const wall = [
      "Subscribe to continue reading this article.",
      "Already a subscriber? Sign in to your account.",
      "Get unlimited access to every local story.",
    ];
    const html = [
      "<html><head><title>River restoration plan approved</title></head><body>",
      `<main><section><h1>River restoration plan approved</h1><p>${story}</p></section></main>`,
      `<footer><aside>${wall.map((line) => `<p>${line}</p>`).join("")}</aside></footer>`,
      "</body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: [story, "", ...wall.flatMap((line) => [line, ""])].join("\n"),
    })).toEqual({ challenge: false });
  });

  it("distinguishes a requested membership destination from an article redirected there", () => {
    const html = readFileSync(join(FIXTURES, "membership-landing-page.html"), "utf-8");

    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/membership",
      resolvedUrl: "https://public.example/membership",
    })).toMatchObject({
      challenge: false,
      noArticle: true,
      evidence: ["page:membership-destination"],
    });
    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/news/membership-reform",
      resolvedUrl: "https://public.example/membership",
    })).toMatchObject({
      challenge: true,
      evidence: ["wall:membership-redirect"],
    });
    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/subscribe",
      resolvedUrl: "https://public.example/membership",
    })).toMatchObject({
      challenge: false,
      noArticle: true,
    });
    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/news/requested-story",
      resolvedUrl: "https://public.example/news/requested-story",
    })).toEqual({ challenge: false });
    expect(classifyChallengeContent({ html })).toEqual({ challenge: false });
  });

  it("recognizes a membership destination that uses an article landmark", () => {
    const fixture = readFileSync(
      join(FIXTURES, "membership-landing-page.html"),
      "utf-8",
    );
    const html = fixture
      .replace("<header>", "<article><header>")
      .replace("</nav>", "</nav></article>");

    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/membership",
      resolvedUrl: "https://public.example/membership",
    })).toMatchObject({
      challenge: false,
      noArticle: true,
      evidence: ["page:membership-destination"],
    });
  });

  it("keeps a requested membership destination no_article when it contains wall copy", () => {
    const html = [
      "<html><head><title>Membership</title></head><body>",
      "<h1>Choose your membership</h1>",
      "<nav aria-label=\"Membership plans\"><a href=\"/membership/checkout\">Join</a></nav>",
      "<p>Subscribe to continue reading.</p>",
      "<p>Already a subscriber? Sign in.</p>",
      "<p>Get unlimited access to every story.</p>",
      "</body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: [
        "Choose your membership",
        "Subscribe to continue reading.",
        "Already a subscriber? Sign in.",
        "Get unlimited access to every story.",
      ].join("\n\n"),
      requestedUrl: "https://public.example/membership",
      resolvedUrl: "https://public.example/membership",
    })).toMatchObject({
      challenge: false,
      noArticle: true,
      evidence: ["page:membership-destination"],
    });
  });

  it("uses requested and resolved membership routes even with generic landing copy", () => {
    const html = "<html><head><title>Choose your plan</title></head><body><h1>Choose your plan</h1></body></html>";

    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/plans",
      resolvedUrl: "https://public.example/plans",
    })).toMatchObject({
      challenge: false,
      noArticle: true,
    });
    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/news/requested-story",
      resolvedUrl: "https://public.example/membership",
    })).toMatchObject({
      challenge: true,
      evidence: ["wall:membership-redirect"],
    });
  });

  it("does not read a membership segment inside a deep article path as a destination", () => {
    const story = [
      "Retirement plans have changed more in the past decade than in the thirty years before it, and the paperwork has not kept pace with the choices savers are now asked to make.",
      "Advisers say the most common mistake is treating the default contribution rate as a recommendation rather than the starting point it was designed to be.",
      "Regulators have proposed clearer statements, but the disclosure rules still assume a reader who already understands the difference between a fund and a plan.",
    ];
    const html = [
      "<html><head><title>Retirement plans explained</title></head><body><main>",
      "<h1>Retirement plans explained</h1>",
      ...story.map((paragraph) => `<p>${paragraph}</p>`),
      "</main></body></html>",
    ].join("");
    const markdown = story.join("\n\n");

    for (
      const url of [
        "https://news.example/news/plans/retirement",
        "https://news.example/2026/01/join/a-union",
        "https://news.example/guides/subscription/basics",
        // A locale may take the lead segment's place, never add depth to it.
        "https://news.example/en/plans/retirement",
        "https://news.example/en-gb/join/a-union",
      ]
    ) {
      expect(classifyChallengeContent({
        html,
        markdown,
        requestedUrl: url,
        resolvedUrl: url,
      })).toEqual({ challenge: false });
    }
  });

  it("does not call a redirect into a deep article path a membership wall", () => {
    const html = "<html><head><title>Retirement plans explained</title></head><body><main><p>Ordinary reporting about retirement paperwork.</p></main></body></html>";

    expect(classifyChallengeContent({
      html,
      markdown: "Ordinary reporting about retirement paperwork.",
      requestedUrl: "https://news.example/news/requested-story",
      resolvedUrl: "https://news.example/news/plans/retirement",
    })).toEqual({ challenge: false });
  });

  it("reads a locale-prefixed membership route as a landing page", () => {
    const html = readFileSync(join(FIXTURES, "membership-landing-page.html"), "utf-8");

    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/en/membership",
      resolvedUrl: "https://public.example/en/membership",
    })).toMatchObject({
      challenge: false,
      noArticle: true,
      evidence: ["page:membership-destination"],
    });
    expect(classifyChallengeContent({
      html,
      requestedUrl: "https://public.example/news/requested-story",
      resolvedUrl: "https://public.example/en-gb/subscribe",
    })).toMatchObject({
      challenge: true,
      evidence: ["wall:membership-redirect"],
    });
  });

  it("does not let a closed disclosure change the wall body threshold", () => {
    const instruction = "Subscribe to continue reading this article.";
    const hidden = "Hidden plan details and legal language. ".repeat(130);
    const html = [
      "<html><head><title>Subscribe to continue reading</title></head><body>",
      `<p>${instruction}</p>`,
      `<details><summary>Plan terms</summary><p>${hidden}</p></details>`,
      "</body></html>",
    ].join("");
    const markdown = `${instruction}\n\nPlan terms\n\n${hidden}`;

    expect(normalizedMarkdownChars(markdown)).toBeGreaterThan(4_000);
    expect(classifyChallengeContent({ html, markdown })).toMatchObject({
      challenge: true,
      evidence: expect.arrayContaining([
        "title:subscription-wall",
        "wall:continue-reading",
      ]),
      normalizedChars: expect.any(Number),
    });
  });

  it("does not admit short article prose as a wall-only article shell", () => {
    const title = "How subscription prompts shape online reading";
    const paragraphs = [
      "Subscribe to continue reading is the bluntest prompt in a publisher's conversion toolkit.",
      "Already a subscriber is often placed next to the login link for returning readers.",
      "Get unlimited access is the benefit language most frequently tested by marketing teams.",
    ];
    const html = [
      `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>`,
      ...paragraphs.map((paragraph) => `<p>${paragraph}</p>`),
      "</article></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: [`# ${title}`, "", ...paragraphs.flatMap((line) => [line, ""])].join("\n"),
    })).toEqual({ challenge: false });
  });

  it("does not treat reader-directed phrase prefixes in main prose as a wall", () => {
    const paragraphs = [
      "Subscribe to continue the debate is a phrase the editorial board uses when inviting letters.",
      "Already a subscriber is how the next paragraph describes a returning customer.",
      "Get unlimited access is presented here as marketing language rather than an offer.",
    ];
    const html = [
      "<html><head><title>Subscription language in context</title></head><body><main>",
      ...paragraphs.map((paragraph) => `<p>${paragraph}</p>`),
      "</main></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: paragraphs.join("\n\n"),
    })).toEqual({ challenge: false });
  });

  it("does not treat question-mark wall phrases with prose continuations as UI", () => {
    const paragraphs = [
      "Subscribe to continue reading? That was the slogan considered by the product team.",
      "Already a subscriber? That was the next message evaluated in the study.",
      "Get unlimited access? The editors rejected that framing as too broad.",
    ];
    const html = [
      "<html><head><title>Subscription language in context</title></head><body><main>",
      ...paragraphs.map((paragraph) => `<p>${paragraph}</p>`),
      "</main></body></html>",
    ].join("");

    expect(classifyChallengeContent({
      html,
      markdown: paragraphs.join("\n\n"),
    })).toEqual({ challenge: false });
  });

  it.each([
    "<blockquote>Subscribe to continue reading this article.</blockquote>",
    "<q>Subscribe to continue reading this article.</q>",
    "<pre>Subscribe to continue reading this article.</pre>",
    "<code>Subscribe to continue reading this article.</code>",
    "<div hidden>Subscribe to continue reading this article.</div>",
    "<template>Subscribe to continue reading this article.</template>",
    "<details><summary>Offer details</summary><p>Subscribe to continue reading this article.</p></details>",
    "<details><summary>Subscribe to continue reading this article.</summary></details>",
  ])("ignores excluded wall copy in %s", (content) => {
    const verdict = classifyChallengeContent({
      html: `<html><head><title>Subscribe to continue reading</title></head><body>${content}</body></html>`,
      markdown: "Subscribe to continue reading this article.",
      rendered: true,
    });

    expect(verdict).toEqual({ challenge: false });
  });

  it("ignores structural and body matches beyond the explicit scan bounds", () => {
    expect(
      classifyChallengeContent({
        html: `<div>${"x".repeat(HTML_SCAN_MAX_CHARS)}</div><form action="/cdn-cgi/challenge-platform/h/b/orchestrate/x"></form>`,
        markdown: "Please verify you are human to continue.",
      }),
    ).toEqual({ challenge: false });
    expect(
      classifyChallengeContent({
        html: '<form action="/cdn-cgi/challenge-platform/h/b/orchestrate/x"></form>',
        markdown: `${"x".repeat(MARKDOWN_SCAN_MAX_CHARS)} Please verify you are human to continue.`,
      }),
    ).toEqual({ challenge: false });
  });
});
