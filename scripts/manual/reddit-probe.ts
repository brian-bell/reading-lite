#!/usr/bin/env -S npx tsx
//
// Manual probe for the Reddit OAuth extraction path (PR #45 / issue #16).
// Companion to plans/009-testing-reddit-oauth.md (Layer 2).
//
// Runs the *real* extractor in Node against a live Reddit thread: app-only
// token fetch -> oauth.reddit.com/*.json -> markdown. This exercises the actual
// network round-trip and credentials without deploying the Worker or touching
// staging. The unit tests cover the same code with a fake `fetch`; this proves
// it works against Reddit for real.
//
// Credentials are read from .dev.vars (then process.env wins), matching
// corpus-recover.ts:
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT
//
// Usage:
//   npx tsx scripts/manual/reddit-probe.ts <reddit-thread-url> [--no-creds]
//
//   --no-creds   Clear the credentials before extracting, to confirm the path
//                fails visibly ("reddit credentials not configured") rather
//                than silently degrading to the HTML Readability fallback.
//
// Examples:
//   npx tsx scripts/manual/reddit-probe.ts "https://www.reddit.com/r/programming/comments/<id>/<slug>/"
//   npx tsx scripts/manual/reddit-probe.ts "https://redd.it/<id>"
//   npx tsx scripts/manual/reddit-probe.ts "https://old.reddit.com/r/x/comments/<id>/" --no-creds

import { extractFromUrl } from "../../src/modules/extractor/index";
import { isRedditThreadUrl, redditJsonUrl } from "../../src/modules/extractor/reddit";
import { loadDotVars } from "../lib/dotvars";

function parse(): { url: string; noCreds: boolean } {
  const args = process.argv.slice(2);
  const noCreds = args.includes("--no-creds");
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    process.stderr.write(
      "usage: npx tsx scripts/manual/reddit-probe.ts <reddit-thread-url> [--no-creds]\n",
    );
    process.exit(2);
  }
  return { url, noCreds };
}

async function main(): Promise<void> {
  const { url, noCreds } = parse();

  const vars = { ...loadDotVars(".dev.vars"), ...process.env };
  const haveCreds = Boolean(vars.REDDIT_CLIENT_ID && vars.REDDIT_CLIENT_SECRET);

  process.stderr.write(`url:            ${url}\n`);
  process.stderr.write(`reddit thread?  ${isRedditThreadUrl(url)}\n`);
  if (isRedditThreadUrl(url)) {
    process.stderr.write(`rewritten:      ${redditJsonUrl(url)}\n`);
  }
  process.stderr.write(`credentials:    ${noCreds ? "intentionally cleared (--no-creds)" : haveCreds ? "present" : "MISSING"}\n`);
  if (!noCreds && !haveCreds) {
    process.stderr.write(
      "\nNo REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET found in .dev.vars or env.\n" +
        "Reddit thread URLs will throw 'reddit credentials not configured'.\n",
    );
  }
  process.stderr.write("\n");

  try {
    const result = await extractFromUrl(url, {
      fetch,
      timeoutMs: 30_000,
      maxBytes: 30_000_000,
      redditClientId: noCreds ? undefined : vars.REDDIT_CLIENT_ID,
      redditClientSecret: noCreds ? undefined : vars.REDDIT_CLIENT_SECRET,
      redditUserAgent: vars.REDDIT_USER_AGENT,
    });

    process.stdout.write(
      JSON.stringify(
        {
          content_status: result.content_status,
          content_type: result.content_type,
          content_bytes: result.content_bytes,
          title: result.title,
          markdown_preview: result.markdown?.slice(0, 500) ?? null,
        },
        null,
        2,
      ) + "\n",
    );

    if (result.content_status === "captured") {
      process.stderr.write("\nOK: captured via the OAuth .json path.\n");
    } else {
      process.stderr.write(
        `\nNOTE: content_status=${result.content_status} (not 'captured'). The bulk batch path drops non-captured readings.\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`\nthrew: ${e instanceof Error ? e.message : String(e)}\n`);
    if (noCreds) {
      process.stderr.write(
        "Expected with --no-creds: missing Reddit credentials must fail visibly, not degrade to HTML.\n",
      );
      process.exit(0);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + "\n");
  process.exit(1);
});
