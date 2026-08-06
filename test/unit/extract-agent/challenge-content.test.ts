import { describe, expect, it } from "vitest";
import {
  challengeContentDetail,
  classifyChallengeContent,
  type ChallengeContentInput,
} from "../../../scripts/extract-agent-lib/challenge-content";

function input(overrides: Partial<ChallengeContentInput>): ChallengeContentInput {
  return { html: "<html><body></body></html>", markdown: "", ...overrides };
}

// Prose used where a fixture needs to be unambiguously an article. `prose(n)`
// so a fixture can pick which length band it lands in — the band is load-bearing.
const prose = (paragraphs: number): string =>
  Array.from(
    { length: paragraphs },
    (_, i) =>
      `Paragraph ${i}: a queue consumer drains messages in waves, and producer pacing keeps the in-flight backlog bounded so retries do not dead-letter under upstream rate limits.`,
  ).join("\n\n");
const PROSE = prose(10);
// Short enough that a matched phrase stays a visible share of the text, so a
// fixture using it tests the scoring rules rather than the copy-density bar.
const SHORT_PROSE = prose(3);

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

    expect(classifyChallengeContent(input({ title: "Are you a robot? The CAPTCHA arms race", markdown })).challenge).toBe(false);
  });

  it("leaves an article that reproduces a whole interstitial's copy alone", () => {
    // The hardest version of rule 1: not one quoted phrase but three families at
    // once — verify, automation, and retry — which is what a writeup about
    // interstitials naturally contains. Diluted across prose it must still read
    // as an article.
    const markdown = [
      "# How Cloudflare decides you are a robot",
      "",
      "The page tells you to verify you are human.",
      "It explains that this process is automatic and asks you to enable javascript and cookies to continue.",
      "Sites do this when they have detected unusual traffic.",
      prose(45),
    ].join("\n\n");

    expect(classifyChallengeContent(input({ title: "How Cloudflare decides you are a robot", markdown })).challenge).toBe(false);
  });

  it("does not let one phrase in the heading count as two independent families", () => {
    // The heading is read from the markdown that also feeds the body, so without
    // collapsing heading-only matches a single H1 phrase scores as both a
    // page-level cue and body copy — the keyword blacklist this design rejects.
    // Kept dense (the phrase is a large share of a short page) so the verdict
    // turns on the collapse rather than on the sparse-copy bar.
    const markdown = [
      "# Why “verify you are human” loops happen in Firefox",
      "",
      "The loop is nearly always a cookie partitioning problem rather than a scoring problem.",
    ].join("\n\n");

    expect(
      classifyChallengeContent(input({ title: "Why “verify you are human” loops happen in Firefox", markdown })).challenge,
    ).toBe(false);
  });

  it("leaves an essay titled like a wall alone when it merely quotes one notice", () => {
    // "Sign in to continue" in a title is not independent evidence from
    // "subscribe to continue reading" in the body — it is the same claim twice,
    // so it belongs to the same family and cannot corroborate itself.
    const markdown = [
      "# Sign in to continue: the design of paywalls",
      "",
      PROSE,
      'The canonical notice reads "subscribe to continue reading".',
    ].join("\n\n");

    expect(classifyChallengeContent(input({ title: "Sign in to continue: the design of paywalls", markdown })).challenge).toBe(false);
  });

  it("flags a block page whose title and heading each carry a different notice", () => {
    // Two headings that say different things are two witnesses. Collapsing them
    // into one would lose the second family on the shape most likely to have no
    // body copy at all: a block page whose extraction is site chrome.
    const verdict = classifyChallengeContent(
      input({
        title: "Access Denied",
        markdown: "# Please verify you are human\n\nHome About Contact Privacy Terms Careers Advertise Subscribe Newsletters",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("leaves a real article behind a site-wide bot-protection vendor alone", () => {
    // DataDome, Imperva, PerimeterX, and AWS WAF tag *every* page they proxy,
    // server-side, so their site-wide markers are worth nothing at all. A vendor
    // being present is not a challenge being served. One quoted challenge phrase
    // is left in, so a bare vendor token would supply the second family and flip
    // the verdict — the narrowing is what holds here.
    const markdown = [
      "# Copper holds its bid as smelters idle",
      "",
      SHORT_PROSE,
      "Traders behind the paywall still had to verify you are human before the quote page would load.",
    ].join("\n\n");

    for (const html of [
      `<script src="https://js.datadome.co/tags.js"></script>`,
      `<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>`,
      `<script src="https://client.perimeterx.net/PXabc/main.min.js"></script><!-- _pxhd -->`,
      `<script src="https://abc.us-east-1.token.awswaf.com/abc/challenge.js"></script>`,
    ]) {
      expect(classifyChallengeContent(input({ title: "Copper holds its bid as smelters idle", html, markdown })).challenge, html).toBe(
        false,
      );
    }
  });

  it("flags a widget-gated interstitial from the markup the static tier actually sees", () => {
    // reCAPTCHA and hCaptcha inject their challenge frame with script, so a
    // fetched-bytes extraction only ever sees the loader and the checkbox. If
    // those counted for nothing, tier 1 would submit this page as an article.
    for (const html of [
      `<form><div class="g-recaptcha" data-sitekey="x"></div></form><script src="https://www.google.com/recaptcha/api.js"></script>`,
      `<div class="h-captcha" data-sitekey="x"></div><script src="https://js.hcaptcha.com/1/api.js"></script>`,
    ]) {
      const verdict = classifyChallengeContent(
        input({ html, markdown: "Please verify you are human.\n\nHome About Contact Privacy Terms Careers Advertise" }),
      );

      expect(verdict.challenge, html).toBe(true);
    }
  });

  it("leaves a long article on a CAPTCHA-protected site alone even when it quotes the copy", () => {
    // The other half of the same trade: a loader on an ordinary page is a weak
    // marker, so unlike a challenge frame it cannot buy the page out of the
    // copy-density bar, and prose dilutes the quoted phrase well below it.
    const verdict = classifyChallengeContent(
      input({
        title: "Inside the bot wars",
        html: `<script src="https://www.google.com/recaptcha/api.js?render=abc"></script>`,
        markdown: `${prose(45)}\n\nThe page asks you to verify you are human before it loads.`,
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("flags a wall that says sign up rather than sign in", () => {
    const markdown = ["# Copper holds its bid as smelters idle", "", prose(20), "Sign up to continue reading this article.", "Already a subscriber? Sign in."].join(
      "\n\n",
    );

    expect(classifyChallengeContent(input({ title: "Copper holds its bid as smelters idle", markdown })).challenge).toBe(true);
  });

  it("does not treat subscription CTA copy as evidence without a wall", () => {
    // "already have an account" and "unlimited access" are corroboration for a
    // wall, not a verdict: they appear in the footer of articles that extracted
    // perfectly well. Short band on purpose — ungated, structural + both support
    // phrases would score 4 and flip this.
    const verdict = classifyChallengeContent(
      input({
        title: "How Queues Drain",
        html: `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>`,
        markdown: `${SHORT_PROSE}\n\nAlready have an account? Unlimited access, cancel anytime.`,
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("flags a teaser wall that has diluted its own notice below the density bar", () => {
    // The common paywall shape, and the one a length rule gets wrong in both
    // directions: pages of teaser ahead of three lines of notice. The wall family
    // has to carry the sparse-copy bar with only its support phrases behind it.
    const markdown = [
      "# Copper holds its bid as smelters idle",
      "",
      prose(30),
      "Subscribe to continue reading this article.",
      "Already a subscriber? Sign in.",
      "Unlimited access. Cancel anytime.",
    ].join("\n\n");

    expect(markdown.length).toBeGreaterThan(5_000);
    expect(classifyChallengeContent(input({ title: "Copper holds its bid as smelters idle", markdown })).challenge).toBe(true);
  });

  it("flags a wall whose only notice is its heading", () => {
    // Holding the heading apart from the body must not disarm the wall: the
    // notice is the same evidence wherever the renderer put it. This phrase
    // deliberately has no TITLE_SIGNALS counterpart, so only the wall family can
    // match it — otherwise the test passes without exercising the case.
    const markdown = ["# Register to continue reading", "", SHORT_PROSE, "Already a subscriber? Sign in. Unlimited access, cancel anytime."].join(
      "\n\n",
    );

    const verdict = classifyChallengeContent(input({ title: "Copper holds its bid as smelters idle", markdown }));
    expect(verdict.challenge).toBe(true);
    if (!verdict.challenge) throw new Error("unreachable");
    expect(verdict.evidence).toEqual(expect.arrayContaining(["wall:continue-reading-wall"]));
  });

  it("flags a long teaser wall that offers only one support phrase", () => {
    // Most walls say "already a subscriber?" or advertise unlimited access, not
    // both. The wall family has to reach the sparse bar on a single support.
    const markdown = [
      "# Copper holds its bid as smelters idle",
      "",
      prose(20),
      "Subscribe to continue reading this article.",
      "Already a subscriber? Sign in.",
    ].join("\n\n");

    expect(classifyChallengeContent(input({ title: "Copper holds its bid as smelters idle", markdown })).challenge).toBe(true);
  });

  it("leaves a long article carrying a widget and a challenge-shaped title alone", () => {
    // Markup plus a subject line is the weakest pair there is, and it is the
    // shape of an article about blocking published on a site whose comment form
    // loads a CAPTCHA. Nothing here interrupts the reader.
    for (const title of ["One more step to a faster build", "Access denied: inside the blocklist wars"]) {
      const verdict = classifyChallengeContent(
        input({ title, html: `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>`, markdown: prose(45) }),
      );

      expect(verdict.challenge, title).toBe(false);
    }
  });

  it("holds a served enforcement artifact to the plain bar, not the copy-density bar", () => {
    // A block page drags nav and footer chrome into the extraction, thinning its
    // notice to a fraction of the text. Markup evidence dilutes with nothing, so
    // a page carrying an artifact that is only ever served *as* a challenge — the
    // DataDome CAPTCHA frame here — is not punished for that chrome.
    const verdict = classifyChallengeContent(
      input({
        title: "Access to this site",
        html: `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe>`,
        markdown: `Please verify you are human.\n\n${PROSE}`,
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("does not let a served artifact alone excuse a page from the density bar", () => {
    // The other conjunct: the artifact buys the exemption only for a page that
    // also *says* something. An artifact plus a subject line, with prose and no
    // notice anywhere, is a page about blocking rather than a blocked one.
    const verdict = classifyChallengeContent(
      input({
        title: "Access Denied",
        html: `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe>`,
        markdown: prose(45),
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("does not spend an evidence slot on a provider it already named", () => {
    // Cloudflare's orchestrate path contains its site-wide JS Detections prefix,
    // so both signals fire on every real interstitial. The evidence list is the
    // only operator-facing diagnostic; a duplicate provider would crowd out a
    // family.
    const verdict = classifyChallengeContent(
      input({
        title: "Just a moment...",
        html: `<form id="challenge-form" action="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></form>`,
        markdown: "# Checking your browser before accessing example.com\n\nEnable JavaScript and cookies to continue. This process is automatic.",
      }),
    );

    expect(verdict.challenge).toBe(true);
    if (!verdict.challenge) throw new Error("unreachable");
    expect(verdict.evidence).toContain("structural:cloudflare");
    expect(verdict.evidence).not.toContain("structural:cloudflare-jsd");
  });

  it("keeps a second provider in the evidence even when one is only a widget", () => {
    // Only the *restated* provider is dropped. A DataDome challenge page that
    // also carries the site's reCAPTCHA loader really does have both, and the
    // evidence list is what an operator reads to tell them apart.
    const verdict = classifyChallengeContent(
      input({
        html: `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe><script src="https://www.google.com/recaptcha/api.js"></script>`,
        markdown: "Please verify you are human.\n\nHome About Contact Privacy",
      }),
    );

    expect(verdict.challenge).toBe(true);
    if (!verdict.challenge) throw new Error("unreachable");
    expect(verdict.evidence).toEqual(expect.arrayContaining(["structural:datadome", "structural:recaptcha"]));
  });

  it("holds the artifact to the same bar when the notice landed in the heading", () => {
    // Same page as above with the notice rendered as an H1 instead of a
    // paragraph. A verdict that turns on which tag the renderer chose is a bug,
    // and the direction it fails in is the expensive one.
    const verdict = classifyChallengeContent(
      input({
        title: "Access to this site",
        html: `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe>`,
        markdown: `# Please verify you are human\n\n${PROSE}`,
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("leaves a long article served from a Bot-Fight-Mode zone alone", () => {
    // Cloudflare's JavaScript Detections script is on every HTML page of the
    // zone, so it says the site buys bot protection, not that this page is a
    // challenge — the same distinction the vendor tokens above are narrowed on.
    // Both injection paths count: one of them lives under `/h/`, which is why
    // the served signal is pinned to `orchestrate` and not to that segment.
    for (const html of [
      `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`,
      `<script src="/cdn-cgi/challenge-platform/h/b/scripts/invisible.js"></script>`,
    ]) {
      const verdict = classifyChallengeContent(
        input({
          title: "Inside the bot wars",
          html,
          markdown: `${prose(45)}\n\nThe page asks you to verify you are human before it loads.`,
        }),
      );

      expect(verdict.challenge, html).toBe(false);
    }
  });

  it("leaves a long article on an AWS-WAF-integrating site alone", () => {
    // `captcha-sdk.awswaf.com` is the SDK a site embeds in its own login form,
    // not something WAF serves — so it is weak, and this page must fare exactly
    // as the byte-identical reCAPTCHA one above does.
    const verdict = classifyChallengeContent(
      input({
        title: "Inside the bot wars",
        html: `<script src="https://abc.us-east-1.captcha-sdk.awswaf.com/abc/jsapi.js"></script>`,
        markdown: `${prose(45)}\n\nThe page asks you to verify you are human before it loads.`,
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("flags a wall that puts a word between the verb and the notice", () => {
    // "Subscribe now to continue reading this article" and every verb the
    // un-pinned list covers. The bare suffix is deliberately not a phrase — see
    // the table — so each verb has to be enumerated, and none may be forgotten.
    for (const notice of [
      "Subscribe now to continue reading this article.",
      "Register now to continue reading this article.",
      "Sign up now to continue reading this article.",
      "Sign in now to continue reading this article.",
      "Log in now to continue reading this article.",
    ]) {
      const markdown = ["# Copper holds its bid as smelters idle", "", prose(20), notice, "Already a subscriber? Sign in."].join("\n\n");

      expect(classifyChallengeContent(input({ title: "Copper holds its bid as smelters idle", markdown })).challenge, notice).toBe(true);
    }
  });

  it("leaves a syndication pointer alone, with or without a wedged 'now'", () => {
    // The reason the wall table pins the verb: "continue reading this article"
    // is what a partner-site pointer says too, and so is "now to continue
    // reading". Both are ordinary article footers.
    for (const pointer of [
      "Head over to our partner site to continue reading this article. Members get unlimited access.",
      "Head over to our partner site now to continue reading this article. Members get unlimited access.",
    ]) {
      const verdict = classifyChallengeContent(input({ title: "How Queues Drain", markdown: `${SHORT_PROSE}\n\n${pointer}` }));

      expect(verdict.challenge, pointer).toBe(false);
    }
  });

  it("flags a block page diluted by site chrome and carrying no provider markup", () => {
    // Not every WAF leaves a token this module knows. With no structural signal
    // there is no escape from the density bar, so the notice has to stay a
    // visible share of the extraction — the header records where that boundary
    // sits and which way it fails past it.
    const verdict = classifyChallengeContent(
      input({
        title: "Access Denied",
        markdown:
          "# Access Denied\n\nYour request has been blocked.\n\nHome About Contact Privacy Terms Careers Advertise Subscribe Newsletters Sitemap Accessibility",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("leaves a long article on an Arkose-embedding site alone", () => {
    // FunCaptcha sits on signup and checkout forms exactly as reCAPTCHA does, so
    // it is a weak marker too and cannot buy a page out of the density bar.
    const verdict = classifyChallengeContent(
      input({
        title: "Inside the bot wars",
        html: `<script src="https://client-api.arkoselabs.com/v2/ABC/api.js"></script>`,
        markdown: `${prose(45)}\n\nThe page asks you to verify you are human before it loads.`,
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("does not let a site-wide widget be the second family on diluted prose", () => {
    // With the copy this thin, "this site buys bot protection" is worth nothing:
    // a loader present on every page of the zone must not corroborate a single
    // quoted wall notice into a verdict.
    const markdown = ["# How metered paywalls work", "", prose(45), 'The canonical notice reads "subscribe to continue reading".'].join("\n\n");
    const verdict = classifyChallengeContent(
      input({ title: "How metered paywalls work", html: `<script src="https://www.google.com/recaptcha/api.js?render=x"></script>`, markdown }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("leaves a rendered page carrying only a CAPTCHA widget frame alone", () => {
    // The headless tier serializes the post-load DOM, where any page with a
    // comment-form CAPTCHA carries the injected anchor and bframe iframes. Those
    // are the widget, not a served challenge, so they buy nothing here — and a
    // tier-2 challenge verdict would cost the row its rendered article.
    const verdict = classifyChallengeContent(
      input({
        title: "Inside the bot wars",
        html: `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x"></iframe>`,
        markdown: `${prose(45)}\n\nThe notice said your request has been blocked by the vendor rules.`,
      }),
    );

    expect(verdict.challenge).toBe(false);
  });

  it("believes one heading twice when it states two different things", () => {
    // The collapse rule is about overlapping *words*, not about sharing a
    // heading: a block page whose title and H1 both read "Access Denied — Please
    // verify you are human" makes two claims and has no body copy to fall back on.
    const verdict = classifyChallengeContent(
      input({
        title: "Access Denied — Please verify you are human",
        markdown: "# Access Denied — Please verify you are human\n\nHome About Contact Privacy Terms Careers Advertise Subscribe",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("flags an AWS WAF captcha interstitial whose notice is most of the page", () => {
    const verdict = classifyChallengeContent(
      input({
        title: "Copper holds its bid as smelters idle",
        html: `<script src="https://abc.us-east-1.captcha-sdk.awswaf.com/abc/jsapi.js"></script>`,
        markdown: "Solve the puzzle to continue. Please verify you are human before we can show you this page.",
      }),
    );

    expect(verdict.challenge).toBe(true);
  });

  it("leaves a short article about challenge pages alone", () => {
    // The regime most blog posts and newsletter issues live in — shorter than a
    // block page that scraped its own nav in, so only the *share* of the text
    // that is challenge copy tells the two apart.
    const markdown = [
      "# Are you a robot? The CAPTCHA arms race",
      "",
      "When a site asks you to verify you are human, the decision was usually made several hundred milliseconds earlier.",
      "The modern check does not care whether you can read warped text; it cares about the shape of the mouse path that got you there.",
      PROSE,
    ].join("\n\n");

    expect(classifyChallengeContent(input({ title: "Are you a robot? The CAPTCHA arms race", markdown })).challenge).toBe(false);
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
        html: `<form id="challenge-form"></form><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html"></iframe><div id="px-captcha"></div><p>Incapsula incident ID: 282-1234</p><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>`,
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

  // Fixtures from the parallel line of work on this branch (0dc18fe, 7cdeb72,
  // 5cb7b0b). They caught four false positives this file's own fixtures did
  // not, and are kept verbatim so the intent behind them stays pinned.

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
});
