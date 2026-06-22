#!/usr/bin/env -S npx tsx
//
// Import a Reddit thread into reading-lite from a `.json` listing payload that
// was fetched through a logged-in browser session (see the reddit-import
// skill). Companion to plans/009-testing-reddit-import.md.
//
// The worker can't fetch Reddit directly (datacenter egress gets a
// bot-challenge), so the flow is: the skill drives Chrome to fetch the public
// `<thread>.json`, saves it, and this tool parses it with the shared
// `redditListingToMarkdown` parser and POSTs the markdown to
// `/readings/import-markdown`. The reading is keyed by the canonical thread URL
// the skill resolves (passed as the positional arg).
//
// Usage:
//   npx tsx scripts/reddit-import.ts <redditThreadUrl> --json <file> [options]
//
//   --json <file>     Path to the saved Reddit `.json` listing (required).
//   --dry-run         Print the markdown that would be imported; do not POST.
//   --api-url <base>  Reading API base. Default: https://reading-lite.bbell.dev
//   --token <token>   Bearer token. Default: READER_API_TOKEN env, then .prd.vars.
//
// Examples:
//   npx tsx scripts/reddit-import.ts "https://www.reddit.com/r/programming/comments/<id>/<slug>/" --json /tmp/thread.json
//   npx tsx scripts/reddit-import.ts "https://redd.it/<id>" --json /tmp/thread.json --dry-run

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { buildRedditImport } from "./reddit-import-lib/parse";
import { isRedditThreadUrl } from "../src/modules/extractor/reddit";
import { resolveApiTarget } from "./corpus-lib/config";
import { importMarkdown } from "./corpus-lib/api";

interface Args {
  url: string;
  json: string;
  dryRun: boolean;
  apiUrl?: string;
  token?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "api-url": { type: "string" },
      token: { type: "string" },
    },
  });
  const url = positionals[0];
  if (!url || !values.json) {
    process.stderr.write(
      "usage: npx tsx scripts/reddit-import.ts <redditThreadUrl> --json <file> [--dry-run] [--api-url <base>] [--token <token>]\n",
    );
    process.exit(2);
  }
  return {
    url,
    json: values.json,
    dryRun: Boolean(values["dry-run"]),
    apiUrl: values["api-url"],
    token: values.token,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  if (!isRedditThreadUrl(args.url)) {
    process.stderr.write(`not a recognized Reddit thread URL: ${args.url}\n`);
    process.exit(2);
  }

  let jsonText: string;
  try {
    jsonText = readFileSync(args.json, "utf8");
  } catch (e) {
    process.stderr.write(`cannot read --json ${args.json}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
    return;
  }

  const body = buildRedditImport(args.url, jsonText);
  if (!body) {
    process.stderr.write(
      `could not parse a Reddit thread from ${args.json}. ` +
        "Make sure it's the saved `.json` listing (not the HTML page / a bot-challenge).\n",
    );
    process.exit(1);
    return;
  }

  if (args.dryRun) {
    process.stderr.write(`source_url: ${body.source_url}\n`);
    process.stderr.write(`title:      ${body.title ?? "(none)"}\n`);
    process.stderr.write(`markdown:   ${body.markdown.length} bytes\n\n`);
    process.stdout.write(body.markdown + "\n");
    return;
  }

  const target = resolveApiTarget({ url: args.apiUrl, token: args.token });
  if (!target.token) {
    process.stderr.write("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)\n");
    process.exit(2);
    return;
  }

  const res = await importMarkdown(body, { ...target, fetch: globalThis.fetch });
  if (res.outcome === "error") {
    process.stderr.write(`import failed: ${res.error}\n`);
    process.exit(1);
    return;
  }

  const id = res.id ?? "(unknown)";
  process.stdout.write(
    JSON.stringify({ outcome: res.outcome, id, poll: res.id ? `${target.base}/readings/${id}` : undefined }, null, 2) + "\n",
  );
  process.stderr.write(`\nimported (${res.outcome}) to ${target.base} — poll ${target.base}/readings/${id}\n`);
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + "\n");
  process.exit(1);
});
