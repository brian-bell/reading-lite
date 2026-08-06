// Success-status challenge detection (issue reading-lite-0bs).
//
// Both tiers label any nonempty markdown as an article. That is wrong for the
// page a bot check or login wall serves with HTTP 200: it has a title, it has
// prose, and above the `minArticleChars` floor it sails through the submit gate
// and *replaces a recoverable failed reading with a corrupted ready one*. The
// 350-char floor catches "Just a moment..."; it does not catch a text-heavy
// sign-in wall.
//
// So: a pure, deterministic classifier that runs after extraction and before an
// outcome is called `extracted`. No network, no model, no mutable domain list.
//
// Two rules shape everything below:
//
//   1. Never a flat keyword blacklist. An article *about* CAPTCHAs quotes
//      challenge copy verbatim, and an ordinary page can embed a reCAPTCHA in
//      its comment form. Every signal belongs to a family, and a verdict needs
//      at least two independent families — one word never decides. Independent
//      means *distinct text* too: everything matched inside the heading is one
//      piece of evidence however many tables it satisfies, so an H1 cannot pay
//      twice.
//   2. The bar rises as the challenge copy thins out. A challenge page exists to
//      interrupt, so it has little to say and what it says *is* the notice; an
//      article that quotes the same copy buries it in prose. That is a ratio,
//      not a length — a block page drags nav and footer chrome into the
//      extraction, and a newsletter issue about paywalls is shorter than it.
//
// The two error costs are not symmetric. A false negative imports a bot check
// as an article and *replaces a recoverable failed reading with a corrupted
// ready one*; a false positive costs the row a render and leaves it recorded as
// a challenge, re-runnable and uncorrupted. So the tables lean slightly eager,
// and the density rule carries the burden of keeping real articles out.
//
// Five residuals are accepted rather than tuned away. Each names a page shape
// that is textually indistinguishable from its opposite, so the choice is which
// way to be wrong, not whether to be:
//
//   • a post that quotes a wall notice verbatim ("subscribe to keep reading")
//     *and* an offer phrase ("cancel anytime") scores as a wall. The alternative
//     — demanding two support codes — would drop the real walls that offer one.
//   • a long article that both embeds a provider *challenge frame* and states
//     verification copy in its body scores as a challenge. Separating it from a
//     block page that scraped its own nav into the extraction would take a
//     second density floor tuned to nothing but fixtures.
//   • a short post whose title reads like a challenge and whose body quotes
//     challenge copy scores as one — at that length the copy is a large share of
//     the text, which is the whole density signal. Raising the density floor to
//     exclude it drops real block pages carrying nav chrome, which is the
//     expensive direction. The mirror of that trade is the floor's other side: a
//     block page carrying *no* recognized provider markup, whose chrome dilutes
//     its notice just under the floor, scores 4 against the sparse bar of 6 and
//     is missed. Every threshold has a boundary; this names where this one is.
//   • the mirror of the first: a wall whose *only* evidence is its notice in the
//     title and the same notice in the body, with no offer copy, is missed. That
//     is one claim stated twice, and the two-family invariant is what stops this
//     from being a keyword blacklist — an essay titled "Sign in to continue: the
//     design of paywalls" has exactly that shape. Real walls in the corpus carry
//     offer copy; if one turns up that does not, capture it and revisit.
//
//   • an article that *names* an enforcement artifact in prose —
//     `geo.captcha-delivery.com`, `distil_r_captcha` — is matched structurally,
//     because the HTML a page serves contains its own article text and nothing
//     distinguishes a hostname in a `src=` from one in a paragraph. With one
//     quoted notice alongside it, that reaches the plain bar. Restricting the
//     match to markup context would drop the block pages whose only artifact is
//     visible text ("Incapsula incident ID: …"), which is the expensive
//     direction.
//
// Per the issue's own follow-up rule: capture the minimal real fixture first,
// then tune here. Do not broaden the tables ad hoc.
//
// Diagnostics are stable evidence codes, never page excerpts: the detail string
// travels into run logs and the sidecar.

export interface ChallengeContentInput {
  // The document the markdown came from. Only high-confidence structural
  // evidence is read from here — never text, which the markdown already carries
  // in normalized form.
  html: string;
  markdown: string;
  title?: string;
}

export type ChallengeFamily =
  | "structural"
  | "title"
  | "verify"
  | "automation"
  | "retry"
  | "wall"
  | "wall_support";

export type ChallengeVerdict =
  | { challenge: false }
  | { challenge: true; score: number; evidence: string[] };

// Weights and thresholds live together and are named, so fixture-driven tuning
// later is a change to this block rather than a hunt through the tables.
const FAMILY_WEIGHT: Record<ChallengeFamily, number> = {
  structural: 2,
  title: 2,
  verify: 2,
  automation: 2,
  retry: 1,
  // The heaviest family: its phrases are whole compound notices ("subscribe to
  // continue reading", "reached your free article limit") that state the
  // interruption outright. Five, because a teaser wall dilutes its own copy with
  // paragraphs of teaser and must still clear the sparse bar with a *single*
  // support phrase behind it — most walls offer one, not both.
  wall: 5,
  wall_support: 1,
};

// The most one family can contribute however many of its signals match. Only
// `wall_support` stacks: its individual phrases ("already a subscriber",
// "unlimited access") are weak alone and decisive together.
const FAMILY_CAP: Record<ChallengeFamily, number> = {
  structural: 2,
  title: 2,
  verify: 2,
  automation: 2,
  retry: 1,
  wall: 5,
  wall_support: 2,
};

const MIN_FAMILIES = 2;
const SCORE_THRESHOLD = 4;
// Families that describe what the page is *doing* rather than what it is about.
// A title is a subject line; these are the notice itself.
const BODY_COPY_FAMILIES = new Set<ChallengeFamily>(["verify", "automation", "retry", "wall"]);
// Density, not length, is the "little to say" test. An interstitial's matched
// copy *is* most of its extracted text; an article that quotes the same copy
// buries it in prose. Absolute length cannot separate the two — a block page
// carries nav and footer chrome into the extraction, and a newsletter issue
// about paywalls is shorter than the block page — but the share of the text
// that is challenge copy separates them cleanly.
const MIN_COPY_DENSITY = 0.02;
// Sparse copy does not clear a page: it raises the bar. A wall diluted by its
// own teaser still reaches it on a single support phrase (wall 5 + wall_support
// 1), while an article reproducing an interstitial's copy tops out below it even
// when it quotes three families at once (verify 2 + automation 2 + retry 1) —
// the shape rule 1 exists to protect, and the reason this is 6 rather than 5.
const SPARSE_COPY_SCORE_THRESHOLD = 6;
// A wall withholds what comes after it, so on a page whose copy is already thin
// the notice belongs in the tail: prose that keeps going for pages past the
// notice was never withheld, and the page is an article about walls rather than
// one. Only applied in the sparse regime — a real wall's own extraction is short
// and dense, and the notice can sit anywhere in it.
const WALL_TAIL_FRACTION = 0.5;

// Scan bounds. A challenge marker is at the top of the document or it is not
// evidence; these keep a 20 MB capture from becoming a 20 MB scan.
export const HTML_SCAN_MAX_CHARS = 1_000_000;
const TEXT_SCAN_MAX_CHARS = 200_000;
// Enough evidence to explain the verdict, few enough to stay a log line.
const MAX_EVIDENCE = 6;

interface Signal {
  code: string;
  family: ChallengeFamily;
  phrases: readonly string[];
  // The stronger signal from the same provider that this one merely restates.
  duplicates?: string;
  // Matched only against a whole block or heading, never as a substring.
  standalone?: boolean;
  // A marker that says "this site can serve a challenge", not "this page is
  // one". It scores, but it never excuses a page from the copy-density bar.
  weak?: boolean;
}

// Structural evidence: provider challenge widgets and containers, matched
// against raw HTML.
//
// Every token here must mean "a challenge was served", never merely "this site
// buys bot protection". The vendors below tag *every page they proxy* — DataDome
// ships `js.datadome.co/tags.js` site-wide, Imperva injects
// `/_Incapsula_Resource?...` into each response, PerimeterX's sensor and
// `_pxhd` cookie ride along on ordinary pages, and the AWS WAF token SDK is
// meant to be embedded site-wide. A bare vendor name would hand half a verdict
// to every article they protect, so each entry names the enforcement artifact
// (the CAPTCHA iframe host, the block-page incident marker) instead.
const STRUCTURAL_SIGNALS: readonly Signal[] = [
  // Cloudflare needs the same split, and the split has to be the *orchestrate*
  // path rather than the `/h/` segment: JavaScript Detections injects both
  // `/cdn-cgi/challenge-platform/scripts/jsd/main.js` and, historically,
  // `/cdn-cgi/challenge-platform/h/b/scripts/invisible.js` into every HTML page
  // on a zone (force-enabled under Bot Fight Mode). Only orchestrate and the
  // challenge-page ids mean the challenge was actually served.
  {
    code: "cloudflare",
    family: "structural",
    phrases: [
      "challenge-platform/h/b/orchestrate",
      "challenge-platform/h/g/orchestrate",
      "cf-browser-verification",
      "cf_chl_opt",
      "challenge-form",
      "challenge-running",
    ],
  },
  { code: "cloudflare-jsd", family: "structural", weak: true, duplicates: "cloudflare", phrases: ["cdn-cgi/challenge-platform"] },
  // reCAPTCHA and hCaptcha are weak in *every* serialization. Their loader and
  // checkbox ship on ordinary comment and newsletter forms, and the frames they
  // inject are no better: `api2/anchor` is the checkbox iframe itself, `bframe`
  // the overlay it preloads, and hCaptcha's `captcha/v1` covers its checkbox
  // frame too. A rendered DOM has all of them on any page carrying the widget.
  // So both serializations are listed — a fetched-bytes extraction only ever
  // sees the first pair — and neither can excuse a page from the density bar.
  {
    code: "recaptcha",
    family: "structural",
    weak: true,
    phrases: ["g-recaptcha", "recaptcha/api.js", "recaptcha/api2/anchor", "recaptcha/api2/bframe", "recaptcha/enterprise/anchor"],
  },
  { code: "hcaptcha", family: "structural", weak: true, phrases: ["h-captcha", "hcaptcha.com/1/api.js", "hcaptcha.com/captcha/v1"] },
  { code: "perimeterx", family: "structural", phrases: ["px-captcha", "captcha.px-cdn.net"] },
  { code: "incapsula", family: "structural", phrases: ["incapsula incident id"] },
  // AWS WAF has no served-only artifact to name: `captcha-sdk.awswaf.com` is the
  // *application integration* SDK a site embeds in its own login or comment form
  // (`AwsWafCaptcha.renderCaptcha`), and `token.awswaf.com` is site-wide. So the
  // whole vendor is weak — the same category as the reCAPTCHA loader, and it
  // must not decide a verdict a reCAPTCHA page would be spared. Both hosts are
  // listed because reports differ on which one a WAF-served interstitial
  // references, and at weak that costs nothing to carry.
  { code: "awswaf", family: "structural", weak: true, phrases: ["captcha-sdk.awswaf.com", "captcha.awswaf.com"] },
  { code: "datadome", family: "structural", phrases: ["captcha-delivery.com", "datadome-captcha"] },
  // Arkose is the same shape as reCAPTCHA: `client-api.arkoselabs.com` and the
  // FunCaptcha widget markup ride along on signup, login, and checkout forms.
  { code: "arkose", family: "structural", weak: true, phrases: ["arkoselabs", "funcaptcha"] },
  { code: "distil", family: "structural", phrases: ["distil_r_captcha"] },
];

// Title/heading evidence: what the page calls itself. Matched against the
// document title and the article's first heading only, never the body — an
// article may discuss "access denied" pages, but the family alone can never
// reach the threshold.
const TITLE_SIGNALS: readonly Signal[] = [
  { code: "just-a-moment", family: "title", phrases: ["just a moment"] },
  // "one more step" deliberately absent: it titles Cloudflare's old interstitial
  // and every second product announcement. That page still matches on its
  // security-check copy and its challenge markup.
  { code: "attention-required", family: "title", phrases: ["attention required"] },
  { code: "access-denied", family: "title", phrases: ["access denied", "access to this page has been denied", "403 forbidden", "request blocked", "you have been blocked"] },
  { code: "checking-browser", family: "title", phrases: ["checking your browser", "checking if the site connection is secure"] },
  { code: "security-check", family: "title", phrases: ["security check", "security verification"] },
  { code: "human-check", family: "title", phrases: ["are you a robot", "are you human", "human verification", "bot verification", "verify you are human", "verify your identity"] },
  { code: "unusual-traffic", family: "title", phrases: ["unusual traffic"] },
  // Matched in the heading like its neighbours, but it belongs to the `wall`
  // family: "sign in to continue" as a title is not *independent* evidence from
  // "subscribe to continue reading" in the body, it is the same claim said twice.
  // Counting them as two families let an essay titled "Sign in to continue: the
  // design of paywalls" convict itself by quoting one wall notice.
  { code: "sign-in-wall", family: "wall", phrases: ["sign in to continue", "log in to continue", "sign in to read", "subscribe to continue", "subscribe to read"] },
];

// Body-copy evidence. Compound phrases only: the whole point is that "captcha",
// "robot", "login", "security", and "cloudflare" on their own prove nothing.
const TEXT_SIGNALS: readonly Signal[] = [
  {
    code: "verify-human",
    family: "verify",
    phrases: [
      // Carrying their own context, so they survive being quoted mid-sentence.
      "verify you are human to continue",
      "verify you are a human to continue",
      "verify that you are human to continue",
      "verify that you are a human to continue",
      "please prove you are human",
      "prove you are human to continue",
      "please confirm you are human",
      "confirm you are human to continue",
      "complete the security check",
      "complete the captcha",
      "solve the captcha",
      "checking if the site connection is secure",
      "review the security of your connection",
    ],
  },
  // The bare imperative is the strongest copy a challenge page has and the
  // easiest thing for an article to quote — 'sites ask users to "verify you are
  // human"'. So it counts only where it *opens* a paragraph, a sentence, or a
  // heading segment. A page making the demand leads with it; an article quoting
  // one buries it mid-clause, which is exactly what the quotation marks do.
  {
    code: "standalone-verify-human",
    family: "verify",
    standalone: true,
    phrases: [
      "verify you are human",
      "verify you are a human",
      "verify that you are human",
      "verify that you are a human",
      "please verify you are human",
      "prove you are human",
      "confirm you are human",
    ],
  },
  {
    code: "automated-traffic",
    family: "automation",
    phrases: [
      "unusual traffic from your computer network",
      "detected unusual traffic",
      "automated queries",
      "your request has been blocked",
      "you have been blocked from",
      "this website is using a security service to protect itself",
      "requests from your network",
      "access to this page has been denied",
      "blocked by network security",
    ],
  },
  {
    code: "retry-instructions",
    family: "retry",
    phrases: [
      "enable javascript and cookies to continue",
      "please enable cookies",
      "enable cookies and reload",
      "javascript is required to continue",
      "refresh the page to continue",
      "please try again in a few",
      "this process is automatic",
    ],
  },
  {
    code: "continue-reading-wall",
    family: "wall",
    phrases: [
      "sign in to continue reading",
      "log in to continue reading",
      "sign in to keep reading",
      "subscribe to continue reading",
      "subscribe to keep reading",
      "subscribe to read the full",
      "register to continue reading",
      "sign up to continue reading",
      // The verb is pinned rather than allowing any word before "now": the bare
      // "to continue reading this article" suffix matches a syndication pointer
      // ("head over to our partner site to continue reading this article"), and
      // so does a floating "now".
      "subscribe now to continue reading",
      "register now to continue reading",
      "sign up now to continue reading",
      "sign in now to continue reading",
      "log in now to continue reading",
      "create an account to continue",
      "create a free account to continue",
      "this article is for subscribers",
      "this content is available to subscribers",
      "become a member to read",
      "sign in to read the full",
      "reached your article limit",
      "reached your free article limit",
    ],
  },
  // Support signals corroborate a wall; they never stand in for one. Both of
  // these live in the footer of articles that extracted perfectly well, so they
  // are discarded unless the `wall` family also matched.
  { code: "existing-subscriber", family: "wall_support", phrases: ["already a subscriber"] },
  { code: "existing-account", family: "wall_support", phrases: ["already have an account"] },
  { code: "unlimited-access", family: "wall_support", phrases: ["unlimited access"] },
  { code: "free-trial", family: "wall_support", phrases: ["start your free trial"] },
  { code: "cancel-anytime", family: "wall_support", phrases: ["cancel anytime"] },
  { code: "subscribers-only", family: "wall_support", phrases: ["subscribers only"] },
  { code: "free-articles", family: "wall_support", phrases: ["free articles remaining"] },
];

interface Match {
  family: ChallengeFamily;
  code: string;
  chars: number;
  weak?: boolean;
  duplicates?: string;
  // Where in the body the phrase was found, for the families that care.
  at?: number;
  // Which text this match read, and where in it. Body and markup matches each
  // stand on their own; heading matches are evidence only once per span of text.
  heading?: number;
  start?: number;
  end?: number;
}

export function classifyChallengeContent(input: ChallengeContentInput): ChallengeVerdict {
  const html = input.html.slice(0, HTML_SCAN_MAX_CHARS).toLowerCase();
  // The heading is held apart from the body it came from — not to hide it from
  // the body families, but so a phrase found *only* there is recognizable as the
  // single piece of evidence it is.
  const split = splitFirstHeading(input.markdown);
  const body = normalizeText(split.body);
  const headings = distinctHeadings(input.title, split.heading);

  const matched: Match[] = [];
  for (const signal of STRUCTURAL_SIGNALS) {
    const hit = signal.phrases.find((p) => html.includes(p));
    if (hit) matched.push({ ...signal, chars: 0 });
  }
  const inHeadings = (signal: Signal): Match | undefined => {
    for (const [index, text] of headings.entries()) {
      for (const phrase of signal.phrases) {
        const at = text.indexOf(phrase);
        if (at >= 0) return { ...signal, chars: phrase.length, heading: index, start: at, end: at + phrase.length };
      }
    }
    return undefined;
  };
  for (const signal of TITLE_SIGNALS) {
    const hit = inHeadings(signal);
    if (hit) matched.push(hit);
  }
  const bodyBlocks = normalizedBlocks(split.body);
  for (const signal of TEXT_SIGNALS) {
    // A heading is part of the text: a wall that renders its notice as the H1 is
    // still a wall. Body matches are preferred because they are independent of
    // whatever the heading already proved.
    if (signal.standalone) {
      const opensBody = signal.phrases.find((p) => bodyBlocks.some((unit) => unit.startsWith(p)));
      if (opensBody) matched.push({ ...signal, chars: opensBody.length });
      else {
        const at = headings.findIndex((h) => signal.phrases.some((p) => h.startsWith(p)));
        const opensHeading = at < 0 ? undefined : signal.phrases.find((p) => headings[at].startsWith(p));
        if (opensHeading) matched.push({ ...signal, chars: opensHeading.length, heading: at, start: 0, end: opensHeading.length });
      }
      continue;
    }
    const inBody = signal.phrases.find((p) => body.includes(p));
    if (inBody) matched.push({ ...signal, chars: inBody.length, at: body.lastIndexOf(inBody) });
    else {
      const hit = inHeadings(signal);
      if (hit) matched.push(hit);
    }
  }

  // Two matches that read the *same words* are one piece of evidence however
  // many tables they satisfy: without this, an H1 saying "verify you are human"
  // would score as both a page-level cue and body copy, and one phrase would
  // decide a verdict. Overlap is what disqualifies, not sharing a heading — a
  // heading reading "Access Denied — Please verify you are human" states two
  // different things and is entitled to be believed twice.
  //
  // Ties go to the family that says what the page is *doing*: that same heading
  // is the notice itself, not a page-level cue about one.
  const rank = (m: Match): number => FAMILY_WEIGHT[m.family] * 2 + (BODY_COPY_FAMILIES.has(m.family) ? 1 : 0);
  const claimed = new Map<number, Array<[number, number]>>();
  const deduped: Match[] = [];
  for (const match of [...matched].sort((a, b) => rank(b) - rank(a))) {
    if (match.heading === undefined || match.start === undefined || match.end === undefined) {
      deduped.push(match);
      continue;
    }
    const spans = claimed.get(match.heading) ?? [];
    if (spans.some(([from, to]) => match.start! < to && from < match.end!)) continue;
    spans.push([match.start, match.end]);
    claimed.set(match.heading, spans);
    deduped.push(match);
  }

  // A weak marker next to its own provider's served artifact is the same
  // provider twice. It cannot change the score (structural is capped) but it can
  // crowd a distinct family — or another vendor — out of the six evidence slots
  // an operator reads, so only the restated provider is dropped.
  const named = new Set(deduped.filter((m) => !m.weak).map((m) => m.code));
  const withoutWeakDuplicates = deduped.filter((m) => m.duplicates === undefined || !named.has(m.duplicates));

  // Support phrases score only alongside the notice they support.
  const scored = withoutWeakDuplicates.some((m) => m.family === "wall")
    ? withoutWeakDuplicates
    : withoutWeakDuplicates.filter((m) => m.family !== "wall_support");
  if (scored.length === 0) return { challenge: false };

  const textChars = headings.reduce((sum, h) => sum + h.length, 0) + body.length;
  const density = scored.reduce((sum, m) => sum + m.chars, 0) / Math.max(1, textChars);
  // Structural evidence is markup, not copy — it contributes no characters and
  // dilutes with nothing, so it can excuse a page from the copy-density bar. But
  // only when the page also *acts* like a challenge somewhere in its body: a
  // widget plus a title is the weakest possible pair, and it is precisely the
  // shape of an article about bot checks published on a site whose comment form
  // loads a CAPTCHA. A widget plus body copy is a page doing the interrupting.
  const acting = scored.some((m) => BODY_COPY_FAMILIES.has(m.family));
  const served = scored.some((m) => m.family === "structural" && !m.weak);
  const sparse = !(served && acting) && density < MIN_COPY_DENSITY;

  // Once the copy is that thin, "this site buys bot protection" is worth nothing
  // at all: a loader that ships on every page of a zone must not be the second
  // family that convicts a page of prose. Nor does a wall notice with pages of
  // prose still to come — see WALL_TAIL_FRACTION.
  const stranded = (m: Match): boolean =>
    m.family === "wall" && m.at !== undefined && m.at < body.length * WALL_TAIL_FRACTION;
  const counted = sparse ? scored.filter((m) => !m.weak && !stranded(m)) : scored;
  const perFamily = new Map<ChallengeFamily, number>();
  for (const { family } of counted) {
    const capped = Math.min((perFamily.get(family) ?? 0) + FAMILY_WEIGHT[family], FAMILY_CAP[family]);
    perFamily.set(family, capped);
  }
  const score = [...perFamily.values()].reduce((a, b) => a + b, 0);
  const threshold = sparse ? SPARSE_COPY_SCORE_THRESHOLD : SCORE_THRESHOLD;
  // Markup and a subject line are both statements *about* a page. Whatever else
  // it has, a challenge has to say something: without a body-copy family the
  // page is an article on a protected site with a challenge-shaped title.
  const corroborated = [...perFamily.keys()].some((family) => BODY_COPY_FAMILIES.has(family));
  if (perFamily.size < MIN_FAMILIES || !corroborated || score < threshold) return { challenge: false };

  return {
    challenge: true,
    score,
    evidence: counted.slice(0, MAX_EVIDENCE).map(({ family, code }) => `${family}:${code}`),
  };
}

// The detail both tiers report. Names the rule (so an operator can tell it from
// a 403) and the evidence codes, and nothing from the page itself.
export function challengeContentDetail(verdict: { evidence: string[] }, url: string): string {
  return `success-status challenge content detected (${verdict.evidence.join(", ")}): ${url}`;
}

// Lowercase, de-decorate, collapse. Markdown emphasis, link syntax, and smart
// punctuation exist for presentation and would otherwise split a phrase in half.
function normalizeText(text: string): string {
  return text
    .slice(0, TEXT_SCAN_MAX_CHARS)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>~|\\\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The parts of the document title and the first heading, normalized, minus the
// empty ones and minus a part that merely repeats another (Readability usually
// derives one from the other, and a repetition is not a second witness).
function distinctHeadings(title: string | undefined, heading: string | undefined): string[] {
  const texts = [title, heading]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    // Split before normalizing, while the separators still exist: titles and
    // headings are routinely compound ("Access Denied | example.com", "Access
    // Denied — Please verify you are human") and each part speaks for itself.
    .flatMap((v) => v.split(/\s+[—–|•·]\s+|:\s+/))
    .map(normalizeText)
    .filter((v) => v.length > 0);
  return texts.filter((text, i) => !texts.some((other, j) => j !== i && other.includes(text) && (other.length > text.length || j < i)));
}

// The openings a standalone signal may match: every paragraph of the body and
// every sentence inside it. A notice that opens either is the page speaking.
function normalizedBlocks(markdown: string): string[] {
  const units: string[] = [];
  for (const block of markdown.slice(0, TEXT_SCAN_MAX_CHARS).split(/\n\s*\n/)) {
    for (const sentence of block.split(/(?<=[.!?])\s+/)) {
      const normalized = normalizeText(sentence);
      if (normalized.length > 0) units.push(normalized);
    }
  }
  return units;
}



// The first ATX heading's text, and the markdown without that heading line.
function splitFirstHeading(markdown: string): { heading?: string; body: string } {
  const match = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(markdown);
  if (!match) return { body: markdown };
  return {
    heading: match[1],
    body: `${markdown.slice(0, match.index)} ${markdown.slice(match.index + match[0].length)}`,
  };
}
