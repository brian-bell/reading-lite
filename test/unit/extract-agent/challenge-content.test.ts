import { describe, expect, it } from "vitest";
import {
  challengeContentDetail,
  classifyChallengeContent,
  type ChallengeContentInput,
} from "../../../scripts/extract-agent-lib/challenge-content";

function input(overrides: Partial<ChallengeContentInput>): ChallengeContentInput {
  return { html: "<html><body></body></html>", markdown: "", ...overrides };
}

// Long-form prose used where a fixture needs to be unambiguously an article.
const PROSE = Array.from(
  { length: 10 },
  (_, i) =>
    `Paragraph ${i}: a queue consumer drains messages in waves, and producer pacing keeps the in-flight backlog bounded so retries do not dead-letter under upstream rate limits.`,
).join("\n\n");

describe("classifyChallengeContent", () => {
  it("flags a provider bot check whose structural markers are corroborated by challenge copy", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Just a moment...",
        html: `<div id="cf-wrapper"><form id="challenge-form" action="/cdn-cgi/challenge-platform/h/b/orchestrate"></form></div>`,
        markdown:
          "# Checking your browser before accessing example.com\n\nEnable JavaScript and cookies to continue. This process is automatic. Your browser will redirect to your requested content shortly.",
      }),
    );

    expect(verdict.challenge).toBe(true);
    if (!verdict.challenge) throw new Error("unreachable");
    expect(verdict.evidence).toEqual(expect.arrayContaining(["structural:cloudflare", "title:just-a-moment"]));
  });

  it("flags a generic human-verification interstitial", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Are you a robot?",
        markdown:
          "Please verify you are human to continue to the site. Complete the security check below and you will be redirected automatically once the check passes.",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("flags a human-verification interstitial with bare imperative copy", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Are you a robot?",
        markdown: "Verify you are human.",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("flags bare verification copy in a punctuation-less markdown block", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Are you a robot?",
        markdown: "## Verify you are human\n\nPlease wait while we validate your connection",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("flags a bare verification heading without a following blank line", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Are you a robot?",
        markdown: "## Verify you are human\nPlease wait while we validate your connection",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("flags a text-heavy sign-in wall well above the article-length floor", () => {
    // The case the 350-char floor cannot catch: a wall with more prose than an
    // interstitial, served with HTTP 200, that would otherwise be summarized.
    const markdown = [
      "You have reached your free article limit for this month.",
      "Sign in to continue reading this article and the rest of today's edition.",
      "Already a subscriber? Log in with the email address on your account.",
      "Subscribe for unlimited access to every story, newsletter, and the full archive.",
      "Members get the daily briefing, the weekend long read, and every market table we publish.",
    ].join("\n\n");
    const verdict = classifyChallengeContent(
      input({ title: "Sign in to continue reading | The Ledger", markdown }),
    );

    expect(markdown.length).toBeGreaterThan(350);
    expect(verdict.challenge).toBe(true);
  });

  it("flags a subscription wall when multiple weak offer phrases corroborate it", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Markets rebound after a volatile week",
        markdown: [
          "Subscribe to continue reading this article.",
          "Get unlimited access and start your free trial today. Cancel anytime.",
        ].join("\n\n"),
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("flags an unusual-traffic interstitial served with a success status", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Access Denied",
        markdown:
          "Our systems have detected unusual traffic from your computer network. This page checks to see if it is really you sending the requests and not a robot.",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("leaves an ordinary long-form article alone", () => {
    expect(classifyChallengeContent(input({ title: "How Queues Drain", markdown: PROSE })).challenge).toBe(false);
  });

  it("leaves an article whose subject is CAPTCHAs and bot protection alone", () => {
    // The reason this is a family/threshold system and not a keyword blacklist:
    // an article about challenge pages quotes their copy verbatim.
    const markdown = [
      "# Are you a robot? The CAPTCHA arms race",
      "",
      'Every reader has clicked the box that says "I\'m not a robot" without thinking about what it measures.',
      "The modern check does not care whether you can read warped text; it cares about the shape of the mouse path that got you there.",
      "When a site asks you to verify you are human, the decision was usually made several hundred milliseconds earlier.",
      "Cloudflare, hCaptcha, and reCAPTCHA all sell the same promise to site operators: keep the scrapers out, let the readers in.",
      "Bot protection vendors describe their product as a login defense, a scraping defense, and a fraud defense, depending on the buyer in the room.",
      PROSE,
      PROSE,
    ].join("\n\n");

    expect(markdown.length).toBeGreaterThan(4_000);
    expect(classifyChallengeContent(input({ title: "Are you a robot? The CAPTCHA arms race", markdown })).challenge).toBe(false);
  });

  it("leaves a short article about CAPTCHA copy alone", () => {
    const markdown = [
      "# Are you a robot? The CAPTCHA arms race",
      "",
      "Challenge pages increasingly shape how ordinary readers experience the web.",
      'Sites ask users to "verify you are human" while risk engines inspect behavior behind the scenes.',
      "The result is an arms race between publishers, bot operators, and accessibility advocates.",
    ].join("\n");

    expect(markdown.length).toBeLessThan(4_000);
    expect(classifyChallengeContent(input({ title: "Are you a robot? The CAPTCHA arms race", markdown })).challenge).toBe(false);
  });

  it("leaves a short article that quotes a verification prompt alone", () => {
    const markdown = [
      "# Are you a robot? The CAPTCHA arms race",
      "",
      'A researcher collected prompts such as "Please verify you are human" to compare their accessibility.',
      "The article explains why those words are not themselves evidence that its reader is blocked.",
    ].join("\n");

    expect(classifyChallengeContent(input({ title: "Are you a robot? The CAPTCHA arms race", markdown })).challenge).toBe(false);
  });

  it("flags a long subscription wall supported by independent offer copy", () => {
    const markdown = [
      "Subscribe to continue reading this article.",
      "Already a subscriber? Log in to your account.",
      "Get unlimited access and start your free trial today. Cancel anytime.",
      "Subscriber benefits and account help are available below.",
      "More membership information follows.",
      PROSE,
      PROSE,
      PROSE,
    ].join("\n\n");

    expect(markdown.length).toBeGreaterThan(4_000);
    expect(classifyChallengeContent(input({ title: "Subscribe to continue reading | The Ledger", markdown })).challenge).toBe(true);
  });

  it("keeps the long-body safeguard when prose quotes a subscription offer", () => {
    const markdown = [
      "Subscribe to continue reading this article.",
      "Get unlimited access and start your free trial today.",
      PROSE,
      PROSE,
      PROSE,
    ].join("\n\n");

    expect(markdown.length).toBeGreaterThan(4_000);
    expect(classifyChallengeContent(input({ title: "Paywall design patterns", markdown })).challenge).toBe(false);
  });

  it("ignores a CAPTCHA widget embedded outside the article", () => {
    // A comment form's reCAPTCHA is structural evidence of a widget, not of a
    // challenge — one family can never carry a verdict on its own.
    const verdict = classifyChallengeContent(
      input({
        title: "How Queues Drain",
        html: `<article>...</article><form class="comment"><div class="g-recaptcha" data-sitekey="x"></div></form>`,
        markdown: `${PROSE}\n\n[Sign in](https://example.com/login) to leave a comment.`,
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("does not let a comment-form CAPTCHA corroborate a challenge-themed article title", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Are you a robot? The CAPTCHA arms race",
        html: `<article>...</article><form class="comment"><div class="g-recaptcha" data-sitekey="x"></div></form>`,
        markdown: "A short report on how CAPTCHA systems shape online publishing.",
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("does not classify on a single keyword, however loaded", () => {
    for (const markdown of [
      `A captcha appeared halfway through checkout. ${PROSE}`,
      `The login page is served by Cloudflare. ${PROSE}`,
      `Security teams argue about robots and bots all day. ${PROSE}`,
    ]) {
      expect(classifyChallengeContent(input({ title: "Field notes", markdown })).challenge, markdown.slice(0, 40)).toBe(false);
    }
  });

  it("sees through markdown decoration and smart punctuation", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Security check",
        markdown: "**Please verify you are human** to continue — we couldn’t confirm the request came from a browser.",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("reports bounded, stable evidence codes rather than page content", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Just a moment...",
        html: `<form id="challenge-form"></form><div class="g-recaptcha"></div><script src="https://hcaptcha.com/1/api.js"></script><div id="px-captcha"></div><div class="_incapsula_resource"></div><script>datadome</script>`,
        markdown:
          "Enable JavaScript and cookies to continue. Please verify you are human. Our systems have detected unusual traffic from your computer network. Sign in to continue reading. Already a subscriber? Unlimited access awaits.",
      }),
    );

    expect(verdict.challenge).toBe(true);
    if (!verdict.challenge) throw new Error("unreachable");
    expect(verdict.evidence.length).toBeLessThanOrEqual(6);
    for (const code of verdict.evidence) expect(code).toMatch(/^[a-z_]+:[a-z-]+$/);

    const detail = challengeContentDetail(verdict, "https://public.example/a");
    expect(detail).toContain("success-status challenge content detected");
    expect(detail).toContain("https://public.example/a");
    expect(detail).not.toContain("Enable JavaScript");
    expect(detail).not.toContain("challenge-form");
    expect(detail.length).toBeLessThan(300);
  });
});
