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
//      at least two independent families — one word never decides.
//   2. The bar rises with body length. A challenge page exists to interrupt, so
//      it has little to say; long bodies are prose, and prose is where quoted
//      challenge copy lives.
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
  wall: 2,
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
  wall: 2,
  wall_support: 2,
};

const MIN_FAMILIES = 2;
const SCORE_THRESHOLD = 4;
// Above this much extracted text the page is prose, and prose about bot checks
// or paywalls quotes their copy. Raise the bar rather than trust the keywords.
const LONG_BODY_CHARS = 4_000;
const LONG_BODY_SCORE_THRESHOLD = 6;

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
}

// Structural evidence: provider challenge widgets and containers, matched
// against raw HTML. Deliberately specific tokens — "distil" would hit
// "distillation", "captcha" alone hits any page that embeds one.
const STRUCTURAL_SIGNALS: readonly Signal[] = [
  { code: "cloudflare", family: "structural", phrases: ["cdn-cgi/challenge-platform", "cf-browser-verification", "cf_chl_opt", "challenge-form", "challenge-running"] },
  { code: "recaptcha", family: "structural", phrases: ["g-recaptcha", "recaptcha/api.js"] },
  { code: "hcaptcha", family: "structural", phrases: ["h-captcha", "hcaptcha.com/1/api.js"] },
  { code: "perimeterx", family: "structural", phrases: ["px-captcha", "_pxhd", "perimeterx"] },
  { code: "incapsula", family: "structural", phrases: ["_incapsula_resource", "incapsula"] },
  { code: "awswaf", family: "structural", phrases: ["captcha.awswaf.com", "awswaf"] },
  { code: "datadome", family: "structural", phrases: ["datadome"] },
  { code: "arkose", family: "structural", phrases: ["arkoselabs", "funcaptcha"] },
  { code: "distil", family: "structural", phrases: ["distil_r_captcha"] },
];

// Title/heading evidence: what the page calls itself. Matched against the
// document title and the article's first heading only, never the body — an
// article may discuss "access denied" pages, but the family alone can never
// reach the threshold.
const TITLE_SIGNALS: readonly Signal[] = [
  { code: "just-a-moment", family: "title", phrases: ["just a moment"] },
  { code: "attention-required", family: "title", phrases: ["attention required", "one more step"] },
  { code: "access-denied", family: "title", phrases: ["access denied", "access to this page has been denied", "403 forbidden", "request blocked", "you have been blocked"] },
  { code: "checking-browser", family: "title", phrases: ["checking your browser", "checking if the site connection is secure"] },
  { code: "security-check", family: "title", phrases: ["security check", "security verification"] },
  { code: "human-check", family: "title", phrases: ["are you a robot", "are you human", "human verification", "bot verification", "verify you are human", "verify your identity"] },
  { code: "unusual-traffic", family: "title", phrases: ["unusual traffic"] },
  { code: "sign-in-wall", family: "title", phrases: ["sign in to continue", "log in to continue", "sign in to read", "subscribe to continue", "subscribe to read"] },
];

// Body-copy evidence. Compound phrases only: the whole point is that "captcha",
// "robot", "login", "security", and "cloudflare" on their own prove nothing.
const TEXT_SIGNALS: readonly Signal[] = [
  {
    code: "verify-human",
    family: "verify",
    phrases: [
      "verify you are human",
      "verify you are a human",
      "verify that you are human",
      "verify that you are a human",
      "prove you are human",
      "confirm you are human",
      "complete the security check",
      "complete the captcha",
      "solve the captcha",
      "checking if the site connection is secure",
      "review the security of your connection",
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
      "to continue reading this article",
      "register to continue reading",
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
  { code: "existing-account", family: "wall_support", phrases: ["already a subscriber", "already have an account"] },
  { code: "subscription-offer", family: "wall_support", phrases: ["unlimited access", "start your free trial", "cancel anytime", "subscribers only", "free articles remaining"] },
];

export function classifyChallengeContent(input: ChallengeContentInput): ChallengeVerdict {
  const html = input.html.slice(0, HTML_SCAN_MAX_CHARS).toLowerCase();
  const body = normalizeText(input.markdown);
  const heading = [input.title, firstHeading(input.markdown)]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map(normalizeText)
    .join(" • ");

  const matched: Array<{ family: ChallengeFamily; code: string }> = [];
  for (const signal of STRUCTURAL_SIGNALS) {
    if (signal.phrases.some((p) => html.includes(p))) matched.push(signal);
  }
  for (const signal of TITLE_SIGNALS) {
    if (signal.phrases.some((p) => heading.includes(p))) matched.push(signal);
  }
  for (const signal of TEXT_SIGNALS) {
    if (signal.phrases.some((p) => body.includes(p))) matched.push(signal);
  }
  if (matched.length === 0) return { challenge: false };

  const perFamily = new Map<ChallengeFamily, number>();
  for (const { family } of matched) {
    const capped = Math.min((perFamily.get(family) ?? 0) + FAMILY_WEIGHT[family], FAMILY_CAP[family]);
    perFamily.set(family, capped);
  }
  const score = [...perFamily.values()].reduce((a, b) => a + b, 0);
  const threshold = body.length > LONG_BODY_CHARS ? LONG_BODY_SCORE_THRESHOLD : SCORE_THRESHOLD;
  if (perFamily.size < MIN_FAMILIES || score < threshold) return { challenge: false };

  return {
    challenge: true,
    score,
    evidence: matched.slice(0, MAX_EVIDENCE).map(({ family, code }) => `${family}:${code}`),
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

function firstHeading(markdown: string): string | undefined {
  return /^\s{0,3}#{1,6}\s+(.+)$/m.exec(markdown)?.[1];
}
