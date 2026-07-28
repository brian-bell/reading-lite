// High-confidence success-status challenge detection.
//
// A provider widget is not enough: ordinary articles can embed CAPTCHA in a
// comment form. A verdict requires both provider-specific structure in the
// bounded HTML capture and instructions aimed at the current reader in the
// extracted Markdown. Title evidence is diagnostic only.

import { parseHTML } from "linkedom";

export interface ChallengeContentInput {
  html: string;
  markdown: string;
  title?: string;
}

export type ChallengeFamily = "structural" | "body" | "title";

export type ChallengeVerdict =
  | { challenge: false }
  | { challenge: true; evidence: string[]; normalizedChars: number };

export const HTML_SCAN_MAX_CHARS = 1_000_000;
export const MARKDOWN_SCAN_MAX_CHARS = 200_000;
export const MAX_CHALLENGE_EVIDENCE = 6;

interface Signal {
  code: string;
  phrases: readonly string[];
}

const STRUCTURAL_SIGNALS: readonly Signal[] = [
  {
    code: "cloudflare",
    phrases: [
      "cdn-cgi/challenge-platform",
      "cf-browser-verification",
      "cf_chl_opt",
    ],
  },
  // Generic reCAPTCHA/hCaptcha widgets are intentionally absent: comment and
  // signup forms embed them on otherwise readable articles, so they are not
  // page-level challenge structure.
  { code: "perimeterx", phrases: ["px-captcha"] },
  { code: "incapsula", phrases: ["_incapsula_resource"] },
  { code: "awswaf", phrases: ["captcha.awswaf.com"] },
  { code: "datadome", phrases: ["captcha-delivery.com/captcha"] },
] as const;

const BODY_SIGNALS: readonly Signal[] = [
  {
    code: "verify-human",
    phrases: [
      "verify you are human to continue",
      "verify you are a human to continue",
      "verify that you are human to continue",
      "complete the security check",
      "complete the captcha",
      "solve the captcha",
    ],
  },
  {
    code: "enable-browser",
    phrases: [
      "enable javascript and cookies to continue",
      "enable cookies and reload",
      "javascript is required to continue",
    ],
  },
  {
    code: "automated-traffic",
    phrases: [
      "unusual traffic from your computer network",
      "detected unusual traffic",
      "automated queries",
      "this website is using a security service to protect itself",
    ],
  },
] as const;

const TITLE_SIGNALS: readonly Signal[] = [
  { code: "just-a-moment", phrases: ["just a moment"] },
  { code: "attention-required", phrases: ["attention required", "one more step"] },
  { code: "checking-browser", phrases: ["checking your browser"] },
  { code: "human-check", phrases: ["are you a robot", "are you human", "human verification"] },
] as const;

export function classifyChallengeContent(input: ChallengeContentInput): ChallengeVerdict {
  const structure = structuralSurface(input.html);
  const body = normalizeMarkdown(input.markdown);
  const title = normalizeInline(input.title ?? "");
  const matched = {
    structural: matchSignals(structure, STRUCTURAL_SIGNALS),
    body: matchSignals(body, BODY_SIGNALS),
    title: matchSignals(title, TITLE_SIGNALS),
  } satisfies Record<ChallengeFamily, string[]>;

  // Title never participates in the decision. This keeps a challenge-themed
  // article plus an unrelated comment-form widget extractable.
  if (matched.structural.length === 0 || matched.body.length === 0) {
    return { challenge: false };
  }

  return {
    challenge: true,
    evidence: boundedEvidence(matched),
    normalizedChars: body.length,
  };
}

function structuralSurface(html: string): string {
  const { document } = parseHTML(html.slice(0, HTML_SCAN_MAX_CHARS));
  const values: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    // Provider markup shown as prose is not live page structure.
    if (element.closest("pre, code, blockquote, template")) continue;
    for (const attribute of ["id", "class", "action", "src"]) {
      const value = element.getAttribute(attribute);
      if (value) values.push(value);
    }
    // Some providers publish their marker as executable inline configuration.
    // Text in any other element is page prose and never structural evidence.
    if (element.tagName === "SCRIPT" && element.textContent) {
      values.push(element.textContent);
    }
  }
  return values.join(" ").toLowerCase();
}

export function normalizedMarkdownChars(markdown: string): number {
  return normalizeMarkdown(markdown).length;
}

export function challengeContentDetail(verdict: { evidence: string[] }, url: string): string {
  return `success-status challenge content detected (${verdict.evidence.join(", ")}): ${url}`;
}

function boundedEvidence(matched: Record<ChallengeFamily, string[]>): string[] {
  // Deciding-family coverage comes first. Only then may additional stable codes
  // fill the overall cap.
  const required = [
    `structural:${matched.structural[0]}`,
    `body:${matched.body[0]}`,
  ];
  const remaining = (["structural", "body", "title"] as const)
    .flatMap((family) => matched[family].map((code) => `${family}:${code}`))
    .filter((code) => !required.includes(code));
  return [...required, ...remaining].slice(0, MAX_CHALLENGE_EVIDENCE);
}

function matchSignals(haystack: string, signals: readonly Signal[]): string[] {
  return signals
    .filter((signal) => signal.phrases.some((phrase) => haystack.includes(phrase)))
    .map((signal) => signal.code);
}

function normalizeMarkdown(markdown: string): string {
  return normalizeInline(markdown.slice(0, MARKDOWN_SCAN_MAX_CHARS));
}

function normalizeInline(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>~|\\\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
