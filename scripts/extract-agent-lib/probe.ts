// Read-only extraction probe.
//
// The dependency surface is deliberately incapable of polling the reading API,
// submitting Markdown, or touching agent state. It can read one offline fixture
// or perform ordinary page fetch/render work, then returns bounded metadata.

import { open } from "node:fs/promises";
import {
  normalizedMarkdownChars,
} from "./challenge-content";
import {
  extractHeadless,
  type RenderPage,
} from "./headless-tier";
import type { ExtractOutcome } from "./outcome";
import type { LookupFn } from "./safe-fetch";
import { extractStatic } from "./static-tier";

export type ProbeTier = "static" | "headless" | "both";

export interface ProbeArgs {
  htmlPath?: string;
  url?: string;
  sourceUrl?: string;
  tier: ProbeTier;
  json: boolean;
}

export interface ProbeDeps {
  readFile: (path: string, maxBytes: number) => Promise<string>;
  fetch: typeof fetch;
  lookup: LookupFn;
  renderPage: RenderPage;
  maxBytes: number;
}

export interface ProbeResult {
  tier: "static" | "headless";
  outcome: ExtractOutcome["kind"];
  title?: string;
  normalized_character_count: number;
  evidence_codes: string[];
}

const OFFLINE_PUBLIC_ADDRESS = "192.0.2.1";

export function parseProbeArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = { tier: "both", json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--html":
        args.htmlPath = requiredValue(flag, argv[++i]);
        break;
      case "--url":
        args.url = requiredValue(flag, argv[++i]);
        break;
      case "--source-url":
        args.sourceUrl = requiredValue(flag, argv[++i]);
        break;
      case "--tier": {
        const value = requiredValue(flag, argv[++i]);
        if (value !== "static" && value !== "headless" && value !== "both") {
          throw new Error(`--tier must be static, headless, or both; got ${JSON.stringify(value)}`);
        }
        args.tier = value;
        break;
      }
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (Boolean(args.htmlPath) === Boolean(args.url)) {
    throw new Error("provide exactly one of --html or --url");
  }
  if (args.htmlPath && !args.sourceUrl) {
    throw new Error("--html requires --source-url");
  }
  if (args.url && args.sourceUrl) {
    throw new Error("--source-url is only valid with --html");
  }
  return args;
}

export async function runProbe(args: ProbeArgs, deps: ProbeDeps): Promise<ProbeResult[]> {
  const offline = args.htmlPath !== undefined;
  const sourceUrl = offline ? args.sourceUrl : args.url;
  if (!sourceUrl) throw new Error(offline ? "--html requires --source-url" : "--url is required");

  let staticFetch = deps.fetch;
  let renderPage = deps.renderPage;
  let lookup = deps.lookup;
  if (offline) {
    const html = await deps.readFile(args.htmlPath!, deps.maxBytes);
    staticFetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;
    renderPage = async () => ({ html, finalUrl: sourceUrl });
    lookup = async () => [{ address: OFFLINE_PUBLIC_ADDRESS }];
  }

  const results: ProbeResult[] = [];
  if (args.tier === "static" || args.tier === "both") {
    const outcome = await extractStatic(sourceUrl, {
      fetch: staticFetch,
      lookup,
      maxBytes: deps.maxBytes,
    });
    results.push(toProbeResult("static", outcome));
  }
  if (args.tier === "headless" || args.tier === "both") {
    const outcome = await extractHeadless(sourceUrl, {
      renderPage,
      lookup,
      maxBytes: deps.maxBytes,
      readOnly: true,
    });
    results.push(toProbeResult("headless", outcome));
  }
  return results;
}

export async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`maxBytes must be a positive safe integer, got ${maxBytes}`);
  }
  const file = await open(path, "r");
  try {
    // Read at most one byte beyond the limit. This bounds regular files, files
    // that grow after open, and non-terminating device-like inputs alike.
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`offline html is over the ${maxBytes} byte cap: ${path}`);
    }
    return buffer.subarray(0, offset).toString("utf-8");
  } finally {
    await file.close();
  }
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function toProbeResult(
  tier: "static" | "headless",
  outcome: ExtractOutcome,
): ProbeResult {
  if (outcome.kind === "extracted") {
    return {
      tier,
      outcome: outcome.kind,
      title: outcome.title,
      normalized_character_count: normalizedMarkdownChars(outcome.markdown),
      evidence_codes: [],
    };
  }
  if (outcome.kind === "challenge") {
    return {
      tier,
      outcome: outcome.kind,
      title: outcome.title,
      normalized_character_count: outcome.normalizedChars ?? 0,
      evidence_codes: outcome.evidence ?? [],
    };
  }
  return {
    tier,
    outcome: outcome.kind,
    normalized_character_count: 0,
    evidence_codes: [],
  };
}
