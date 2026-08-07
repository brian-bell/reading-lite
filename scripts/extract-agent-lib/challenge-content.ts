// High-confidence success-status challenge detection.
//
// A provider widget or subscription phrase is not enough: ordinary articles
// can embed CAPTCHA in a comment form or discuss paywall copy. A verdict
// requires bounded visible HTML to agree with instructions aimed at the current
// reader in extracted Markdown (or visible fallback text). Challenge titles are
// diagnostic only; exact wall titles contribute to the explicit wall score.

import { parseHTML } from "linkedom";

export interface ChallengeContentInput {
  html: string;
  markdown?: string;
  title?: string;
  requestedUrl?: string;
  resolvedUrl?: string;
  rendered?: boolean;
}

export type ChallengeFamily = "structural" | "body" | "title";

export type ChallengeVerdict =
  | { challenge: false }
  | {
    challenge: false;
    noArticle: true;
    evidence: ["page:membership-destination"];
    normalizedChars: number;
  }
  | { challenge: true; evidence: string[]; normalizedChars: number };

export const HTML_SCAN_MAX_CHARS = 1_000_000;
export const MARKDOWN_SCAN_MAX_CHARS = 200_000;
export const MAX_CHALLENGE_EVIDENCE = 6;
const HTML_VISIBLE_MAX_DEPTH = 256;
const HTML_TEXT_BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BUTTON",
  "DETAILS",
  "DIALOG",
  "DIV",
  "DL",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

const READER_DIRECTED_VERIFY_PREFIXES = [
  "please verify you are human to continue",
  "please verify you are a human to continue",
  "please verify that you are human to continue",
  "please verify that you are a human to continue",
  "verify you are human to continue",
  "verify you are a human to continue",
  "verify that you are human to continue",
  "verify that you are a human to continue",
] as const;

const READER_DIRECTED_VERIFY_LEAD_INS = [
  "to protect this site from automated requests,",
  "to protect this site from automated requests",
  "to protect the site from automated requests,",
  "to protect the site from automated requests",
  "before accessing the requested page,",
  "before accessing the requested page",
] as const;

const STANDALONE_VERIFY_PHRASES = [
  "verify you are human",
  "verify you are a human",
  "verify that you are human",
  "verify that you are a human",
] as const;

const READER_DIRECTED_AUTOMATION_PREFIXES = [
  "our systems have detected unusual traffic",
  "we have detected unusual traffic",
  "we have detected that your computer may be sending automated queries",
  "your computer or network may be sending automated queries",
  "unusual traffic from your computer network",
] as const;

const READER_DIRECTED_SECURITY_PREFIXES = [
  "complete the security check",
  "complete the captcha",
  "solve the captcha",
] as const;

const READER_DIRECTED_BROWSER_PREFIXES = [
  "enable javascript and cookies to continue",
  "enable cookies and reload",
  "javascript is required to continue",
] as const;

const VISIBLE_INPUT_VALUE_TYPES = new Set([
  "button",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "reset",
  "search",
  "submit",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

interface Signal {
  code: string;
  phrases: readonly string[];
}

const STRUCTURAL_SIGNALS: readonly Signal[] = [
  {
    code: "cloudflare",
    phrases: [
      // Not the bare `cdn-cgi/challenge-platform` prefix: JavaScript Detections
      // injects `/cdn-cgi/challenge-platform/scripts/jsd/main.js` (and,
      // historically, `/h/b/scripts/invisible.js`) into every HTML page on a
      // zone, force-enabled under Bot Fight Mode. Those say the zone buys bot
      // protection, not that this page is a challenge. The orchestrate paths and
      // the challenge-page config object are what a served challenge carries.
      "cdn-cgi/challenge-platform/h/b/orchestrate",
      "cdn-cgi/challenge-platform/h/g/orchestrate",
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
      "your computer or network may be sending automated queries",
      "we have detected that your computer may be sending automated queries",
      "this website is using a security service to protect itself",
    ],
  },
] as const;

const TITLE_SIGNALS: readonly Signal[] = [
  { code: "just-a-moment", phrases: ["just a moment"] },
  { code: "attention-required", phrases: ["attention required", "one more step"] },
  { code: "checking-browser", phrases: ["checking your browser"] },
  {
    code: "human-check",
    phrases: [
      "are you a robot",
      "are you human",
      "human verification",
      "verify you are human",
      "verify you are a human",
    ],
  },
  { code: "unusual-traffic", phrases: ["unusual traffic"] },
] as const;

const WALL_TITLE_SIGNALS: readonly Signal[] = [
  {
    code: "subscription-wall",
    phrases: [
      "subscribe to continue reading",
      "please subscribe to continue reading",
      "subscribe to continue",
      "subscribe to read",
      "sign in to continue reading",
      "sign in to read",
      "log in to continue reading",
      "log in to read",
      "this article is for subscribers only",
    ],
  },
] as const;

const WALL_SIGNALS: readonly Signal[] = [
  {
    code: "continue-reading",
    phrases: [
      "subscribe to continue reading",
      "please subscribe to continue reading",
      "subscribe to continue",
      "subscribe to keep reading",
      "sign in to continue reading",
      "sign in to keep reading",
      "sign in to read the full",
      "log in to continue reading",
      "log in to keep reading",
      "log in to read the full",
      "to continue reading this article",
      "register to continue reading",
      "create an account to continue",
      "create a free account to continue",
    ],
  },
  {
    code: "subscriber-content",
    phrases: [
      "this article is for subscribers",
      "this content is available to subscribers",
      "this content is available to digital subscribers",
    ],
  },
  {
    code: "member-content",
    phrases: [
      "become a member to read",
    ],
  },
  {
    code: "article-limit",
    phrases: [
      "you have reached your free article limit",
      "you've reached your free article limit",
      "you have reached your article limit",
      "you've reached your article limit",
    ],
  },
] as const;

const WALL_SUPPORT_SIGNALS: readonly Signal[] = [
  {
    code: "existing-subscriber",
    phrases: [
      "already a subscriber",
      "already a paid subscriber",
      "already a member",
      "already have a subscription",
    ],
  },
  { code: "existing-account", phrases: ["already have an account"] },
  {
    code: "account-access",
    phrases: [
      "sign in to your account",
      "log in to your account",
    ],
  },
  {
    code: "subscriber-access",
    phrases: [
      "subscribe to get access to the rest",
      "become a paid subscriber to get access to the rest",
    ],
  },
  { code: "unlimited-access", phrases: ["unlimited access", "get unlimited access"] },
  { code: "full-access", phrases: ["full access", "full website content"] },
  {
    code: "free-trial",
    phrases: [
      "start your free trial",
      "your first month is free",
    ],
  },
  { code: "free-registration", phrases: ["it's free"] },
  { code: "cancel-anytime", phrases: ["cancel anytime"] },
  {
    code: "free-articles",
    phrases: [
      "0 free articles left",
      "no free articles left",
      "free articles remaining",
      "you have no more free articles",
      "you have used all your free articles",
      "you've used all your free articles",
    ],
  },
  {
    code: "subscriber-only",
    phrases: [
      "subscribers only",
      // Stored normalized: normalizeInline rewrites hyphens to spaces before
      // any phrase is matched, so a hyphenated literal could never match.
      "subscriber only",
      "access every subscriber only story",
    ],
  },
] as const;

const SHORT_WALL_SCORE_THRESHOLD = 4;
const LONG_BODY_CHARS = 4_000;
const LONG_WALL_SCORE_THRESHOLD = 6;
const WALL_SUPPORT_SCORE_CAP = 4;

// The JavaScript MIME type essence-match set from the MIME Sniffing Standard.
// Script `type` parameters are intentionally not parsed away: HTML treats a
// value such as `text/javascript; charset=utf-8` as a data block.
const JAVASCRIPT_MIME_TYPES = new Set([
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
]);

export function classifyChallengeContent(input: ChallengeContentInput): ChallengeVerdict {
  const html = boundedCodePointPrefix(input.html, HTML_SCAN_MAX_CHARS);
  const structure = structuralSurface(html);
  const visibleBody = visibleTextSurface(html, input.rendered !== true);
  const body = input.markdown === undefined
    ? visibleBody
    : normalizeMarkdown(input.markdown);
  const normalizedChars = visibleBody.length;
  if (isRequestedMembershipDestination(input.requestedUrl, input.resolvedUrl)) {
    return {
      challenge: false,
      noArticle: true,
      evidence: ["page:membership-destination"],
      normalizedChars,
    };
  }
  if (isMembershipRedirect(input.requestedUrl, input.resolvedUrl)) {
    return {
      challenge: true,
      evidence: ["wall:membership-redirect"],
      normalizedChars,
    };
  }
  const titleMatches = Array.from(new Set(
    [input.title, documentTitle(html)]
      .filter((title): title is string => title !== undefined)
      .flatMap((title) => matchSignals(normalizeInline(title), TITLE_SIGNALS)),
  ));
  const matched = {
    structural: matchSignals(structure, STRUCTURAL_SIGNALS),
    body: matchSignals(body, BODY_SIGNALS),
    title: titleMatches,
  } satisfies Record<ChallengeFamily, string[]>;
  const wallTitle = Array.from(new Set(
    [input.title, documentTitle(html)]
      .filter((title): title is string => title !== undefined)
      .flatMap((title) => exactSignalMatches(normalizeInline(title), WALL_TITLE_SIGNALS)),
  ));
  const visibleHtmlBlocks = readerDirectedHtmlBlocks(
    html,
    input.rendered !== true,
    normalizedChars,
    wallTitle.length > 0,
  );
  const visibleMarkdownBlocks = input.markdown === undefined
    ? visibleHtmlBlocks
    : readerDirectedMarkdownBlocks(input.markdown);
  const visibleHtmlWall = matchReaderDirectedSignals(
    visibleHtmlBlocks,
    WALL_SIGNALS,
  );
  const wall = input.markdown === undefined
    ? visibleHtmlWall
    : matchReaderDirectedSignals(
      visibleMarkdownBlocks,
      WALL_SIGNALS,
    ).filter((code) => visibleHtmlWall.includes(code));
  const visibleHtmlWallSupport = matchReaderDirectedSignals(
    visibleHtmlBlocks,
    WALL_SUPPORT_SIGNALS,
  );
  const wallSupport = input.markdown === undefined
    ? visibleHtmlWallSupport
    : matchReaderDirectedSignals(
      visibleMarkdownBlocks,
      WALL_SUPPORT_SIGNALS,
    ).filter((code) => visibleHtmlWallSupport.includes(code));
  const wallScore = (wallTitle.length > 0 ? 2 : 0)
    + (wall.length > 0 ? 2 : 0)
    + Math.min(wallSupport.length, WALL_SUPPORT_SCORE_CAP);
  const wallThreshold = normalizedChars > LONG_BODY_CHARS
    ? LONG_WALL_SCORE_THRESHOLD
    : SHORT_WALL_SCORE_THRESHOLD;
  if (wall.length > 0 && wallScore >= wallThreshold) {
    return {
      challenge: true,
      evidence: [
        ...wallTitle.map((code) => `title:${code}`),
        ...wall.map((code) => `wall:${code}`),
        ...wallSupport.map((code) => `wall_support:${code}`),
      ].slice(0, MAX_CHALLENGE_EVIDENCE),
      normalizedChars,
    };
  }
  let textOnlyBody: string[] = [];
  if (matched.title.length > 0) {
    const visibleHtmlBody = readerDirectedBlockSignals(visibleHtmlBlocks);
    textOnlyBody = input.markdown === undefined
      ? visibleHtmlBody
      : readerDirectedMarkdownSignals(input.markdown)
        .filter((code) => visibleHtmlBody.includes(code));
  }
  const decidingFamilies = matched.structural.length > 0 && matched.body.length > 0
    ? ["structural", "body"] as const
    : matched.title.length > 0 && textOnlyBody.length > 0
      ? ["title", "body"] as const
      : undefined;

  if (!decidingFamilies) {
    return { challenge: false };
  }

  return {
    challenge: true,
    evidence: boundedEvidence(
      { ...matched, body: decidingFamilies[0] === "title" ? textOnlyBody : matched.body },
      decidingFamilies,
    ),
    normalizedChars,
  };
}

const MEMBERSHIP_DESTINATION_SEGMENTS = new Set([
  "join",
  "membership",
  "membership-landing-page",
  "plans",
  "subscribe",
  "subscription",
]);

const MEMBERSHIP_DESTINATION_MAX_SEGMENTS = 2;
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/;

function isRequestedMembershipDestination(
  requestedUrl: string | undefined,
  resolvedUrl: string | undefined,
): boolean {
  return isMembershipDestinationUrl(requestedUrl)
    && isMembershipDestinationUrl(resolvedUrl ?? requestedUrl);
}

function isMembershipRedirect(
  requestedUrl: string | undefined,
  resolvedUrl: string | undefined,
): boolean {
  return requestedUrl !== undefined
    && resolvedUrl !== undefined
    && !isMembershipDestinationUrl(requestedUrl)
    && isMembershipDestinationUrl(resolvedUrl);
}

function isMembershipDestinationUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const path = new URL(value).pathname
      .toLowerCase()
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replace(/\.(?:html?|php)$/, ""));
    // These segments are ordinary words, so their presence anywhere in a path
    // proves nothing: `/news/plans/retirement` is a story about plans. Only a
    // landing-page shape counts — the segment leads the path, and at most one
    // segment follows it (`/membership`, `/subscribe/annual`).
    if (path.length === 0 || path.length > MEMBERSHIP_DESTINATION_MAX_SEGMENTS) {
      return false;
    }
    // International publishers route the same landing page under a locale, so a
    // leading locale may take the lead segment's place (`/en/subscribe`). It
    // replaces that slot rather than adding one: the depth cap above still
    // holds, so `/en/plans/retirement` stays an article path.
    const lead = path.length === MEMBERSHIP_DESTINATION_MAX_SEGMENTS
        && LOCALE_SEGMENT.test(path[0]!)
      ? path[1]!
      : path[0]!;
    return MEMBERSHIP_DESTINATION_SEGMENTS.has(lead);
  } catch {
    return false;
  }
}

function structuralSurface(html: string): string {
  const { document } = parseHTML(html);
  const values: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    // Provider markup shown as prose is not live page structure.
    if (element.closest("pre, code, blockquote, template")) continue;
    const isScript = element.tagName === "SCRIPT";
    if (isScript && !isExecutableScriptType(element.getAttribute("type"))) {
      continue;
    }
    for (const attribute of ["id", "class", "action", "src"]) {
      const value = element.getAttribute(attribute);
      if (value) values.push(value);
    }
    // Some providers publish their marker as executable inline configuration.
    // Text in any other element is page prose and never structural evidence.
    if (isScript && element.textContent) {
      values.push(element.textContent);
    }
  }
  return values.join(" ").toLowerCase();
}

function documentTitle(html: string): string {
  const { document } = parseHTML(html);
  return document.querySelector("title")?.textContent ?? "";
}

function isExecutableScriptType(type: string | null): boolean {
  const normalized = type?.trim().toLowerCase() ?? "";
  return normalized === ""
    || normalized === "module"
    || JAVASCRIPT_MIME_TYPES.has(normalized);
}

function visibleTextSurface(html: string, includeNoscript: boolean): string {
  const { document } = parseHTML(html);
  interface VisibleNode {
    nodeType: number;
    textContent: string | null;
    childNodes: ArrayLike<unknown>;
    tagName?: string;
    getAttribute?: (name: string) => string | null;
  }
  const root = (document.querySelector("body")
    ?? document.documentElement) as VisibleNode | null;
  if (root === null) return "";

  const excludedTags = new Set([
    "ASIDE",
    "BLOCKQUOTE",
    "CODE",
    "FOOTER",
    "HEAD",
    "PRE",
    "Q",
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    ...(includeNoscript ? [] : ["NOSCRIPT"]),
  ]);
  const parts: string[] = [];
  let chars = 0;
  const stack = [{
    node: root,
    inheritedVisibilityHidden: false,
    depth: 0,
  }];
  while (stack.length > 0 && chars < MARKDOWN_SCAN_MAX_CHARS) {
    const current = stack.pop()!;
    if (current.depth >= HTML_VISIBLE_MAX_DEPTH) continue;
    if (current.node.nodeType === 3) {
      if (!current.inheritedVisibilityHidden) {
        const text = current.node.textContent ?? "";
        const bounded = text.slice(0, MARKDOWN_SCAN_MAX_CHARS - chars);
        parts.push(bounded);
        chars += bounded.length;
      }
      continue;
    }
    if (current.node.nodeType !== 1) continue;

    const tagName = current.node.tagName?.toUpperCase() ?? "";
    const inputType = (current.node.getAttribute?.("type") ?? "text")
      .trim()
      .toLowerCase();
    const inlineStyle = inlineStyleState(
      (current.node.getAttribute?.("style") ?? "").toLowerCase(),
    );
    const excluded = excludedTags.has(tagName)
      || (current.node.getAttribute?.("hidden") ?? null) !== null
      || inlineStyle.displayNone
      || (tagName === "INPUT" && inputType === "hidden")
      || ((tagName === "DETAILS" || tagName === "DIALOG")
        && (current.node.getAttribute?.("open") ?? null) === null);
    if (excluded) continue;

    const visibilityHidden = resolveVisibilityHidden(
      inlineStyle.visibility,
      current.inheritedVisibilityHidden,
    );
    if (!visibilityHidden && tagName === "BR") {
      parts.push(" ");
      chars++;
    }
    if (
      !visibilityHidden
      && tagName === "INPUT"
      && VISIBLE_INPUT_VALUE_TYPES.has(inputType)
    ) {
      const value = current.node.getAttribute?.("value") ?? "";
      const bounded = value.slice(0, MARKDOWN_SCAN_MAX_CHARS - chars);
      parts.push(bounded);
      chars += bounded.length;
    }
    const children = Array.from(current.node.childNodes) as VisibleNode[];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({
        node: children[index]!,
        inheritedVisibilityHidden: visibilityHidden,
        depth: current.depth + 1,
      });
    }
  }
  return normalizeMarkdown(parts.join(""));
}

function boundedCodePointPrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let codePoints = 0;
  let codeUnits = 0;
  for (const char of text) {
    if (codePoints === maxChars) break;
    codePoints++;
    codeUnits += char.length;
  }
  return codeUnits === text.length ? text : text.slice(0, codeUnits);
}

export function normalizedMarkdownChars(markdown: string): number {
  return normalizeMarkdown(markdown).length;
}

export function challengeContentDetail(verdict: { evidence: string[] }, url: string): string {
  return `success-status challenge content detected (${verdict.evidence.join(", ")}): ${url}`;
}

function boundedEvidence(
  matched: Record<ChallengeFamily, string[]>,
  decidingFamilies: readonly [ChallengeFamily, ChallengeFamily],
): string[] {
  // Deciding-family coverage comes first. Only then may additional stable codes
  // fill the overall cap.
  const required = decidingFamilies.map((family) => `${family}:${matched[family][0]}`);
  const remaining = (["structural", "body", "title"] as const)
    .flatMap((family) => matched[family].map((code) => `${family}:${code}`))
    .filter((code) => !required.includes(code));
  return [...required, ...remaining].slice(0, MAX_CHALLENGE_EVIDENCE);
}

function readerDirectedMarkdownSignals(markdown: string): string[] {
  return readerDirectedBlockSignals(readerDirectedMarkdownBlocks(markdown));
}

function readerDirectedMarkdownBlocks(markdown: string): string[] {
  const bounded = markdown.slice(0, MARKDOWN_SCAN_MAX_CHARS);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let listItem = false;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const block = normalizedInstructionBlock(paragraph.join("\n"));
      if (block !== undefined) blocks.push(block);
      paragraph = [];
    }
  };

  for (const line of bounded.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      flushParagraph();
      const token = fenceMatch[1]!;
      const marker = token[0] as "`" | "~";
      if (fence === undefined) {
        fence = { marker, length: token.length };
      } else if (
        fence.marker === marker
        && token.length >= fence.length
        && fenceMatch[2]!.trim().length === 0
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    if (/^\s*$/.test(line)) {
      flushParagraph();
      listItem = false;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flushParagraph();
      continue;
    }
    if (/^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      listItem = true;
      continue;
    }
    if (listItem) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const block = normalizedInstructionBlock(heading[1]!);
      if (block !== undefined) blocks.push(block);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function normalizedInstructionBlock(markdown: string): string | undefined {
  const trimmed = markdown.trim();
  let candidate = trimmed.replace(/[.!?]+$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    const link = /^\[([\s\S]+)\]\([\s\S]*\)$/.exec(candidate);
    if (link) {
      candidate = link[1]!.trim();
      changed = true;
      continue;
    }
    for (const marker of ["***", "___", "**", "__", "~~", "*", "_"]) {
      if (
        candidate.startsWith(marker)
        && candidate.endsWith(marker)
        && candidate.length > marker.length * 2
      ) {
        candidate = candidate.slice(marker.length, -marker.length).trim();
        changed = true;
        break;
      }
    }
  }
  const opening = /^(`+)/.exec(candidate)?.[1];
  if (
    opening !== undefined
    && candidate.length > opening.length * 2
    && candidate.endsWith(opening)
  ) {
    return undefined;
  }
  return normalizeInline(markdown);
}

function readerDirectedHtmlBlocks(
  html: string,
  includeNoscript: boolean,
  // The page measurement that chose the wall score threshold. The article-shell
  // rule below relaxes only where that threshold is the long one, so it has to
  // read the same number rather than measure the wrapper itself.
  pageChars: number,
  // Whether an exact wall title scored, decided by the caller across both the
  // document title and the extracted one. A publisher can leave the original
  // story in <title> while the visible wall heading carries the offer, so
  // measuring the document title alone here would withhold the shell
  // relaxation from pages the score already credits two points.
  hasExplicitWallTitle: boolean,
): string[] {
  const { document } = parseHTML(html);
  const hasArticle = document.querySelector("article") !== null;
  const normalizedDocumentTitle = normalizeInline(
    document.querySelector("title")?.textContent ?? "",
  );
  const hiddenElements = includeNoscript
    ? "head, script, style, template"
    : "head, script, style, noscript, template";
  for (const element of document.querySelectorAll(hiddenElements)) {
    element.remove();
  }
  const blocks: string[] = [];
  let visibleChars = 0;
  interface TraversableNode {
    nodeType: number;
    textContent: string | null;
    childNodes: ArrayLike<unknown>;
    tagName?: string;
    getAttribute?: (name: string) => string | null;
  }
  const visibleInlineBlockText = (
    root: TraversableNode,
    inheritedVisibilityHidden: boolean,
  ): string => {
    const parts: string[] = [];
    const stack = (Array.from(root.childNodes) as TraversableNode[])
      .reverse()
      .map((node) => ({ node, inheritedVisibilityHidden }));
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.node.nodeType === 3) {
        if (!current.inheritedVisibilityHidden) {
          parts.push(current.node.textContent ?? "");
        }
        continue;
      }
      if (current.node.nodeType !== 1) continue;
      const tagName = current.node.tagName?.toUpperCase() ?? "";
      if (HTML_TEXT_BLOCK_TAGS.has(tagName)) continue;
      const inputType = (current.node.getAttribute?.("type") ?? "text")
        .trim()
        .toLowerCase();
      const inlineStyle = inlineStyleState(
        (current.node.getAttribute?.("style") ?? "").toLowerCase(),
      );
      const hidden = (current.node.getAttribute?.("hidden") ?? null) !== null
        || inlineStyle.displayNone
        || (tagName === "INPUT" && inputType === "hidden");
      if (hidden) continue;
      const visibilityHidden = resolveVisibilityHidden(
        inlineStyle.visibility,
        current.inheritedVisibilityHidden,
      );
      if (!visibilityHidden && tagName === "BR") parts.push(" ");
      if (
        !visibilityHidden
        && tagName === "INPUT"
        && VISIBLE_INPUT_VALUE_TYPES.has(inputType)
      ) {
        parts.push(current.node.getAttribute?.("value") ?? "");
      }
      const children = Array.from(current.node.childNodes) as TraversableNode[];
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({
          node: children[index]!,
          inheritedVisibilityHidden: visibilityHidden,
        });
      }
    }
    return normalizeInline(parts.join(""));
  };
  // Whether a child is part of its parent's own inline text — the same nodes
  // the block-text pass above collects, so the two agree on where that text
  // begins. A hidden inline node contributes to neither.
  const carriesOwnText = (
    child: TraversableNode,
    inheritedVisibilityHidden: boolean,
  ): boolean => {
    // Normalized, not trimmed: the block-text pass normalizes too, so a node
    // of nothing but punctuation ("—") survives a trim but leaves no block
    // text and cannot be where that text starts.
    if (child.nodeType === 3) {
      return !inheritedVisibilityHidden
        && normalizeInline(child.textContent ?? "").length > 0;
    }
    if (child.nodeType !== 1) return false;
    const tagName = child.tagName?.toUpperCase() ?? "";
    if (HTML_TEXT_BLOCK_TAGS.has(tagName)) return false;
    const inputType = (child.getAttribute?.("type") ?? "text").trim().toLowerCase();
    const inlineStyle = inlineStyleState(
      (child.getAttribute?.("style") ?? "").toLowerCase(),
    );
    if (
      (child.getAttribute?.("hidden") ?? null) !== null
      || inlineStyle.displayNone
      || (tagName === "INPUT" && inputType === "hidden")
    ) {
      return false;
    }
    const visibilityHidden = resolveVisibilityHidden(
      inlineStyle.visibility,
      inheritedVisibilityHidden,
    );
    if (tagName === "INPUT") {
      return !visibilityHidden
        && VISIBLE_INPUT_VALUE_TYPES.has(inputType)
        && normalizeInline(child.getAttribute?.("value") ?? "").length > 0;
    }
    // Not short-circuited on visibilityHidden: the block-text pass descends
    // into a concealed element too, and a descendant that sets `visibility:
    // visible` shows again, so its text is part of the wrapper's own block.
    return visibleInlineBlockText(child, visibilityHidden).length > 0;
  };
  const hasBlockDescendant = (node: TraversableNode): boolean => {
    const stack = Array.from(node.childNodes) as TraversableNode[];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.nodeType !== 1) continue;
      if (HTML_TEXT_BLOCK_TAGS.has(current.tagName?.toUpperCase() ?? "")) {
        return true;
      }
      const children = Array.from(current.childNodes) as TraversableNode[];
      for (const child of children) stack.push(child);
    }
    return false;
  };
  // How many element children a wrapper's own inline text starts after, or -1
  // when that has no answer: the wrapper's text is merged into one block, so an
  // inline child holding both that text and blocks of its own leaves nothing to
  // file the merged block against. The shell test refuses such a wrapper rather
  // than guess a position the wall rule then reads as meaningful.
  const elementsBeforeOwnText = (
    children: readonly TraversableNode[],
    inheritedVisibilityHidden: boolean,
  ): number => {
    let elements = 0;
    for (const child of children) {
      if (carriesOwnText(child, inheritedVisibilityHidden)) {
        return child.nodeType === 1 && hasBlockDescendant(child) ? -1 : elements;
      }
      if (child.nodeType === 1) elements++;
    }
    return elements;
  };
  const articleIsUiShell = (node: TraversableNode): boolean => {
    const visibleBlocks: string[] = [];
    interface ShellFrame {
      node?: TraversableNode;
      inheritedVisibilityHidden: boolean;
      depth: number;
      block?: string;
    }
    const stack: ShellFrame[] = [
      { node, inheritedVisibilityHidden: false, depth: 0 },
    ];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.block !== undefined) {
        visibleBlocks.push(current.block);
        continue;
      }
      if (current.node === undefined) continue;
      if (current.depth >= HTML_VISIBLE_MAX_DEPTH) return false;
      const tagName = current.node.tagName?.toUpperCase() ?? "";
      const inputType = (current.node.getAttribute?.("type") ?? "text")
        .trim()
        .toLowerCase();
      const inlineStyle = inlineStyleState(
        (current.node.getAttribute?.("style") ?? "").toLowerCase(),
      );
      const hidden = (current.node.getAttribute?.("hidden") ?? null) !== null
        || inlineStyle.displayNone
        || (tagName === "INPUT" && inputType === "hidden")
        || (tagName === "DIALOG"
          && (current.node.getAttribute?.("open") ?? null) === null);
      if (hidden) continue;
      const visibilityHidden = resolveVisibilityHidden(
        inlineStyle.visibility,
        current.inheritedVisibilityHidden,
      );
      if (
        !visibilityHidden
        && ["BLOCKQUOTE", "Q", "PRE", "CODE"].includes(tagName)
      ) {
        return false;
      }

      const children = Array.from(current.node.childNodes) as TraversableNode[];
      const visibleChildren = tagName === "DETAILS"
        && (current.node.getAttribute?.("open") ?? null) === null
        ? []
        : children;
      const frames: ShellFrame[] = visibleChildren
        .filter((child) => child.nodeType === 1)
        .map((child) => ({
          node: child,
          inheritedVisibilityHidden: visibilityHidden,
          depth: current.depth + 1,
        }));
      if (HTML_TEXT_BLOCK_TAGS.has(tagName) && tagName !== "ARTICLE") {
        const block = visibleInlineBlockText(current.node, visibilityHidden);
        // A block carries only its element's own inline text, so a wrapper's
        // block can belong anywhere among the blocks its children produce.
        // Place it where its own text actually starts: the wall rule reads
        // block position, and filing a wrapper at its start tag would let a
        // trailing offer read as leading, while filing it last would hide
        // leading prose from the same check.
        if (block.length > 0) {
          const ownTextIndex = elementsBeforeOwnText(
            visibleChildren,
            visibilityHidden,
          );
          if (ownTextIndex < 0) return false;
          frames.splice(ownTextIndex, 0, {
            block,
            inheritedVisibilityHidden: visibilityHidden,
            depth: current.depth,
          });
        }
      }
      // Pushed in reverse so the stack pops them in document order: the wall
      // rule below reads block position, not just block membership.
      for (let index = frames.length - 1; index >= 0; index--) {
        stack.push(frames[index]!);
      }
    }
    const challengeBlock = (block: string) =>
      readerDirectedUiBlockSignals([block]).length > 0;
    const titleBlock = (block: string) =>
      exactSignalMatches(block, TITLE_SIGNALS).length > 0;
    const terminalWallBlock = (block: string) =>
      WALL_SIGNALS.some((signal) =>
        signal.phrases.some((phrase) =>
          matchesReaderDirectedPhrase(block, phrase)))
      || exactSignalMatches(block, WALL_TITLE_SIGNALS).length > 0;
    const wallSupportCodes = (block: string) =>
      matchReaderDirectedSignals([block], WALL_SUPPORT_SIGNALS);
    const wallSupport = Array.from(new Set(visibleBlocks.flatMap(wallSupportCodes)));
    const wallUiChromeBlock = (block: string) => {
      const bare = block.replace(/[.!?…]+$/, "");
      return block === normalizedDocumentTitle
        || ["like", "subscribe"].includes(bare)
        || /^(?:enter|type) your email\b/.test(block)
        || /^posted in\b/.test(block);
    };

    const firstWallBlock = visibleBlocks.findIndex(terminalWallBlock);
    // A text-heavy wall is mostly its own marketing prose, which no block-level
    // signal can recognize, so requiring every block to be wall UI would only
    // ever match short walls. Above the long-body threshold, ask instead that
    // the instruction lead the wrapper: a wall replaces the article rather than
    // interrupting it, so only the page title, wall chrome, or support copy may
    // precede it, and an article that opens with body prose stays excluded.
    // That is safe up here because the score bar is LONG_WALL_SCORE_THRESHOLD —
    // several independent offer signals. Below it the bar is 4, which a
    // promotion box clears on its own, so a short wrapper must still be
    // recognized wall UI end to end or an article carrying a promotion at the
    // top would convict.
    const wallShell = pageChars > LONG_BODY_CHARS
      ? firstWallBlock >= 0
        && visibleBlocks.slice(0, firstWallBlock).every((block) =>
          wallSupportCodes(block).length > 0
          || wallUiChromeBlock(block)
          || titleBlock(block))
      : firstWallBlock >= 0
        && visibleBlocks.every((block) =>
          terminalWallBlock(block)
          || wallSupportCodes(block).length > 0
          || wallUiChromeBlock(block));

    return (
      visibleBlocks.some(challengeBlock)
      && visibleBlocks.every((block) =>
        challengeBlock(block) || titleBlock(block)
      )
    )
      || (wallShell && (hasExplicitWallTitle || wallSupport.length >= 2));
  };
  const visit = (
    value: unknown,
    evidenceExcluded = false,
    inheritedVisibilityHidden = false,
    depth = 0,
    insideUiArticle = false,
  ): string => {
    const node = value as TraversableNode;
    if (node.nodeType === 3) {
      if (inheritedVisibilityHidden) return "";
      const text = node.textContent ?? "";
      const start = visibleChars;
      visibleChars += text.length;
      if (evidenceExcluded || start >= MARKDOWN_SCAN_MAX_CHARS) return "";
      return text.slice(0, MARKDOWN_SCAN_MAX_CHARS - start);
    }
    if (node.nodeType !== 1) {
      return Array.from(node.childNodes)
        .map((child) =>
          visit(
            child,
            evidenceExcluded,
            inheritedVisibilityHidden,
            depth,
            insideUiArticle,
          ))
        .join("");
    }
    if (depth >= HTML_VISIBLE_MAX_DEPTH) return "";

    const tagName = node.tagName?.toUpperCase() ?? "";
    const inputType = (node.getAttribute?.("type") ?? "text").trim().toLowerCase();
    const style = (node.getAttribute?.("style") ?? "").toLowerCase();
    const inlineStyle = inlineStyleState(style);
    // Linkedom has no computed-style engine. Do not partially interpret
    // stylesheet rules here: media conditions and the CSS cascade would turn
    // that into unpredictable false negatives. HTML-native and inline hiding
    // are the deterministic visibility boundary for this offline classifier.
    const hidden = (node.getAttribute?.("hidden") ?? null) !== null
      || inlineStyle.displayNone
      || (tagName === "INPUT" && inputType === "hidden")
      || (tagName === "DIALOG" && (node.getAttribute?.("open") ?? null) === null);
    if (hidden) return "";
    const visibilityHidden = resolveVisibilityHidden(
      inlineStyle.visibility,
      inheritedVisibilityHidden,
    );

    const uiArticle = tagName === "ARTICLE"
      && articleIsUiShell(node);
    const excludesDescendants = evidenceExcluded
      // Readability can mistake a text-only interstitial or wall for an
      // article. Keep prose articles excluded, but admit article wrappers made
      // entirely of recognized challenge/wall UI plus one short title block.
      || (tagName === "ARTICLE" && !uiArticle)
      || (hasArticle && tagName === "FORM" && !insideUiArticle)
      || tagName === "FOOTER"
      || tagName === "ASIDE"
      || tagName === "BLOCKQUOTE"
      || tagName === "Q"
      || tagName === "PRE"
      || tagName === "CODE";
    const start = visibleChars;
    const children = Array.from(node.childNodes);
    const visibleChildren = tagName === "DETAILS"
      && (node.getAttribute?.("open") ?? null) === null
      ? []
      : children;
    let permittedText: string;
    if (tagName === "BR") {
      if (visibilityHidden) {
        permittedText = "";
      } else {
        visibleChars++;
        permittedText = start < MARKDOWN_SCAN_MAX_CHARS ? " " : "";
      }
    } else {
      permittedText = visibleChildren
        .map((child) =>
          visit(
            child,
            excludesDescendants,
            visibilityHidden,
            depth + 1,
            insideUiArticle || uiArticle,
          ))
        .join("");
    }
    if (
      !visibilityHidden
      && tagName === "INPUT"
      && VISIBLE_INPUT_VALUE_TYPES.has(inputType)
    ) {
      const rawValue = node.getAttribute?.("value") ?? "";
      const valueStart = visibleChars;
      visibleChars += rawValue.length;
      if (!excludesDescendants && valueStart < MARKDOWN_SCAN_MAX_CHARS) {
        permittedText += rawValue.slice(0, MARKDOWN_SCAN_MAX_CHARS - valueStart);
      }
    }
    if (!excludesDescendants && start < MARKDOWN_SCAN_MAX_CHARS && permittedText.trim().length > 0) {
      blocks.push(normalizeInline(permittedText));
    }
    return excludesDescendants ? "" : permittedText;
  };
  if (document.documentElement && document.body) visit(document.body);
  return blocks;
}

function inlineStyleState(style: string): {
  displayNone: boolean;
  visibility: string | undefined;
} {
  interface Declaration {
    value: string;
    important: boolean;
  }
  const winning = new Map<string, Declaration>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    if (property !== "display" && property !== "visibility") continue;
    const rawValue = declaration.slice(colon + 1).trim();
    const important = /!\s*important\s*$/.test(rawValue);
    const value = rawValue.replace(/\s*!\s*important\s*$/, "").trim();
    const current = winning.get(property);
    if (current?.important && !important) continue;
    winning.set(property, { value, important });
  }
  return {
    displayNone: winning.get("display")?.value === "none",
    visibility: winning.get("visibility")?.value,
  };
}

function resolveVisibilityHidden(
  visibility: string | undefined,
  inheritedVisibilityHidden: boolean,
): boolean {
  switch (visibility) {
    case "hidden":
    case "collapse":
      return true;
    case "visible":
    case "initial":
      return false;
    case "inherit":
    case "unset":
    case "revert":
    case "revert-layer":
    case undefined:
      return inheritedVisibilityHidden;
    default:
      // An invalid declaration does not change the inherited computed value.
      return inheritedVisibilityHidden;
  }
}

function readerDirectedBlockSignals(bodyBlocks: string[]): string[] {
  const matched: string[] = [];
  if (bodyBlocks.some((block) =>
    READER_DIRECTED_VERIFY_PREFIXES.some((phrase) => block.startsWith(phrase))
    || READER_DIRECTED_VERIFY_LEAD_INS.some((leadIn) => {
      if (!block.startsWith(leadIn)) return false;
      const instruction = block.slice(leadIn.length).trimStart();
      return READER_DIRECTED_VERIFY_PREFIXES.some((phrase) =>
        instruction.startsWith(phrase));
    }))) {
    matched.push("verify-human");
  }
  if (bodyBlocks.some((block) => {
    const bare = block.replace(/[.!?]+$/, "");
    return STANDALONE_VERIFY_PHRASES.includes(
      bare as (typeof STANDALONE_VERIFY_PHRASES)[number],
    );
  })) {
    matched.push("standalone-verify-human");
  }
  if (bodyBlocks.some((block) =>
    READER_DIRECTED_AUTOMATION_PREFIXES.some((phrase) => block.startsWith(phrase)))) {
    matched.push("automated-traffic");
  }
  if (bodyBlocks.some((block) =>
    READER_DIRECTED_SECURITY_PREFIXES.some((phrase) => block.startsWith(phrase)))) {
    matched.push("verify-human");
  }
  if (bodyBlocks.some((block) =>
    READER_DIRECTED_BROWSER_PREFIXES.some((phrase) => block.startsWith(phrase)))) {
    matched.push("enable-browser");
  }
  return matched;
}

function readerDirectedUiBlockSignals(bodyBlocks: string[]): string[] {
  const exactBlocks = bodyBlocks.map((block) => block.replace(/[.!?]+$/, ""));
  const matched: string[] = [];
  if (exactBlocks.some((block) =>
    READER_DIRECTED_VERIFY_PREFIXES.includes(
      block as (typeof READER_DIRECTED_VERIFY_PREFIXES)[number],
    )
    || READER_DIRECTED_VERIFY_LEAD_INS.some((leadIn) =>
      READER_DIRECTED_VERIFY_PREFIXES.some((phrase) =>
        block === `${leadIn} ${phrase}`)))) {
    matched.push("verify-human");
  }
  if (exactBlocks.some((block) =>
    STANDALONE_VERIFY_PHRASES.includes(
      block as (typeof STANDALONE_VERIFY_PHRASES)[number],
    ))) {
    matched.push("standalone-verify-human");
  }
  if (exactBlocks.some((block) =>
    READER_DIRECTED_AUTOMATION_PREFIXES.includes(
      block as (typeof READER_DIRECTED_AUTOMATION_PREFIXES)[number],
    ))) {
    matched.push("automated-traffic");
  }
  if (exactBlocks.some((block) =>
    READER_DIRECTED_SECURITY_PREFIXES.includes(
      block as (typeof READER_DIRECTED_SECURITY_PREFIXES)[number],
    ))) {
    matched.push("verify-human");
  }
  if (exactBlocks.some((block) =>
    READER_DIRECTED_BROWSER_PREFIXES.includes(
      block as (typeof READER_DIRECTED_BROWSER_PREFIXES)[number],
    ))) {
    matched.push("enable-browser");
  }
  return matched;
}

function matchSignals(haystack: string, signals: readonly Signal[]): string[] {
  return signals
    .filter((signal) => signal.phrases.some((phrase) => haystack.includes(phrase)))
    .map((signal) => signal.code);
}

function matchReaderDirectedSignals(blocks: string[], signals: readonly Signal[]): string[] {
  return signals
    .filter((signal) =>
      signal.phrases.some((phrase) =>
        blocks.some((block) => matchesReaderDirectedPhrase(block, phrase))))
    .map((signal) => signal.code);
}

function matchesReaderDirectedPhrase(block: string, phrase: string): boolean {
  const bare = block.replace(/[.!?]+$/, "");
  if (bare === phrase) return true;
  if (!bare.startsWith(phrase)) return false;
  const remainder = bare.slice(phrase.length);
  const punctuation = /^[?:;]\s*(.*)$/.exec(remainder);
  if (
    punctuation
    && /^(?:continue|get|log in|register|restore|sign in|start|subscribe|view)\b/.test(
      punctuation[1]!,
    )
  ) {
    return true;
  }
  if (/^,\s*(?:including|log in|sign in|subscribe)\b/.test(remainder)) {
    return true;
  }
  const suffix = remainder.trim();
  return /^(?:article|content|of\b|only|on this device|post|story|the full (?:article|post|story)|this (?:premium )?(?:article|content|post|story)|this month|today|to\b|includes?\b)/.test(
    suffix,
  );
}

function exactSignalMatches(haystack: string, signals: readonly Signal[]): string[] {
  const exact = haystack.replace(/[.!?]+$/, "");
  return signals
    .filter((signal) => signal.phrases.includes(exact))
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
