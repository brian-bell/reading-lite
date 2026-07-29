// High-confidence success-status challenge detection.
//
// A provider widget is not enough: ordinary articles can embed CAPTCHA in a
// comment form. A verdict requires both provider-specific structure in the
// bounded HTML capture and instructions aimed at the current reader in
// extracted Markdown or bounded visible fallback text. Title evidence is
// diagnostic only.

import { parseHTML } from "linkedom";

export interface ChallengeContentInput {
  html: string;
  markdown?: string;
  title?: string;
  rendered?: boolean;
}

export type ChallengeFamily = "structural" | "body" | "title";

export type ChallengeVerdict =
  | { challenge: false }
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
  const body = input.markdown === undefined
    ? visibleTextSurface(html, input.rendered !== true)
    : normalizeMarkdown(input.markdown);
  const title = normalizeInline(input.title ?? documentTitle(html));
  const matched = {
    structural: matchSignals(structure, STRUCTURAL_SIGNALS),
    body: matchSignals(body, BODY_SIGNALS),
    title: matchSignals(title, TITLE_SIGNALS),
  } satisfies Record<ChallengeFamily, string[]>;
  let textOnlyBody: string[] = [];
  if (matched.title.length > 0) {
    const visibleHtmlBody = readerDirectedHtmlSignals(html, input.rendered !== true);
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
    normalizedChars: body.length,
  };
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
  const hiddenElements = includeNoscript
    ? "head, script, style, template"
    : "head, script, style, noscript, template";
  for (const element of document.querySelectorAll(hiddenElements)) {
    element.remove();
  }
  return normalizeMarkdown(document.body?.textContent ?? "");
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
  return readerDirectedBlockSignals(blocks);
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

function readerDirectedHtmlSignals(html: string, includeNoscript: boolean): string[] {
  const { document } = parseHTML(html);
  const hasArticle = document.querySelector("article") !== null;
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
  const articleIsChallengeShell = (node: TraversableNode): boolean => {
    const visibleBlocks: string[] = [];
    const stack = [{ node, inheritedVisibilityHidden: false, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
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
      if (HTML_TEXT_BLOCK_TAGS.has(tagName)) {
        const block = visibleInlineBlockText(current.node, visibilityHidden);
        if (block.length > 0) visibleBlocks.push(block);
      }

      const visibleChildren = tagName === "DETAILS"
        && (current.node.getAttribute?.("open") ?? null) === null
        ? children.filter((child) =>
          child.tagName?.toUpperCase() === "SUMMARY")
        : children;
      for (const child of visibleChildren) {
        if (child.nodeType === 1) {
          stack.push({
            node: child,
            inheritedVisibilityHidden: visibilityHidden,
            depth: current.depth + 1,
          });
        }
      }
    }
    const challengeBlock = (block: string) =>
      readerDirectedUiBlockSignals([block]).length > 0;
    const titleBlock = (block: string) =>
      exactSignalMatches(block, TITLE_SIGNALS).length > 0;

    return visibleBlocks.some(challengeBlock)
      && visibleBlocks.every((block) =>
        challengeBlock(block) || titleBlock(block));
  };
  const visit = (
    value: unknown,
    evidenceExcluded = false,
    inheritedVisibilityHidden = false,
    depth = 0,
    insideChallengeArticle = false,
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
            insideChallengeArticle,
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

    const challengeArticle = tagName === "ARTICLE"
      && articleIsChallengeShell(node);
    const excludesDescendants = evidenceExcluded
      // Readability can mistake a text-only interstitial for an article. Keep
      // prose articles excluded, but admit article wrappers made entirely of
      // recognized challenge UI blocks.
      || (tagName === "ARTICLE" && !challengeArticle)
      || (hasArticle && tagName === "FORM" && !insideChallengeArticle)
      || tagName === "BLOCKQUOTE"
      || tagName === "PRE"
      || tagName === "CODE";
    const start = visibleChars;
    const children = Array.from(node.childNodes);
    const visibleChildren = tagName === "DETAILS"
      && (node.getAttribute?.("open") ?? null) === null
      ? children.filter((child) =>
        (child as TraversableNode).tagName?.toUpperCase() === "SUMMARY")
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
            insideChallengeArticle || challengeArticle,
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
  return readerDirectedBlockSignals(blocks);
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
