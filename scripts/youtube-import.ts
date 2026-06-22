#!/usr/bin/env -S npx tsx
//
// Import a YouTube video into reading-lite with a *full* local extraction —
// title + author (oEmbed), description (watch-page `ytInitialPlayerResponse`),
// and the transcript (via yt-dlp). The in-worker path only reliably gets the
// oEmbed floor because datacenter egress is blocked from the watch page and
// timedtext is gated behind a proof-of-origin token; fetching from this
// machine's residential IP returns the full page, and yt-dlp does the player
// handshake that bare timedtext fetches can't. See issue #17 / the youtube.ts
// extractor.
//
// Usage:
//   npx tsx scripts/youtube-import.ts <youtubeUrl> [options]
//
//   --dry-run         Print the markdown that would be imported; do not POST.
//   --no-transcript   Skip the yt-dlp transcript step (title + author + description only).
//   --api-url <base>  Reading API base. Default: https://reading-lite.bbell.dev
//   --token <token>   Bearer token. Default: READER_API_TOKEN env, then .prd.vars.
//
// Examples:
//   npx tsx scripts/youtube-import.ts "https://www.youtube.com/watch?v=YtTWNzOtkxU" --dry-run
//   npx tsx scripts/youtube-import.ts "https://youtu.be/YtTWNzOtkxU" --api-url https://reading-lite-staging.bellbm.workers.dev

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalWatchUrl,
  isYoutubeWatchUrl,
  oembedUrl,
  parseVideoId,
  timedtextToText,
  youtubeWatchUrlVariants,
} from "../src/modules/extractor/youtube";
import { buildYoutubeImport } from "./youtube-import-lib/parse";
import { resolveApiTarget } from "./corpus-lib/config";
import { importMarkdown, lookupReading, type ApiDeps } from "./corpus-lib/api";

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+cb",
};

interface Args {
  url: string;
  dryRun: boolean;
  transcript: boolean;
  apiUrl?: string;
  token?: string;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "no-transcript": { type: "boolean", default: false },
      "api-url": { type: "string" },
      token: { type: "string" },
    },
  });
  const url = positionals[0];
  if (!url) {
    process.stderr.write(
      "usage: npx tsx scripts/youtube-import.ts <youtubeUrl> [--dry-run] [--no-transcript] [--api-url <base>] [--token <token>]\n",
    );
    process.exit(2);
  }
  return {
    url,
    dryRun: Boolean(values["dry-run"]),
    transcript: !values["no-transcript"],
    apiUrl: values["api-url"],
    token: values.token,
  };
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) {
      process.stderr.write(`  fetch ${url} -> ${res.status}\n`);
      return undefined;
    }
    return await res.text();
  } catch (e) {
    process.stderr.write(`  fetch ${url} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return undefined;
  }
}

// Best-effort transcript via yt-dlp: it performs the player handshake that bare
// timedtext GETs can't, so it retrieves captions a plain fetch returns empty for.
// Writes json3 subtitles to a temp dir, then flattens them with the shared
// timedtextToText parser. Returns undefined when yt-dlp is absent or the video
// has no captions.
function fetchTranscriptViaYtDlp(watchUrl: string): string | undefined {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "yt-import-"));
    const run = spawnSync(
      "yt-dlp",
      [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "en.*,en",
        "--sub-format",
        "json3",
        "--paths",
        dir,
        "-o",
        "%(id)s.%(ext)s",
        watchUrl,
      ],
      { encoding: "utf8", timeout: 90_000 },
    );
    if (run.error) {
      process.stderr.write(
        `  yt-dlp unavailable (${run.error.message}); skipping transcript. Install yt-dlp or pass --no-transcript.\n`,
      );
      return undefined;
    }
    const json3 = readdirSync(dir).find((f) => f.endsWith(".json3"));
    if (!json3) {
      process.stderr.write("  no captions found for this video; importing without a transcript.\n");
      return undefined;
    }
    const text = timedtextToText(readFileSync(join(dir, json3), "utf8"));
    return text || undefined;
  } catch (e) {
    process.stderr.write(`  transcript step failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return undefined;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// We always import under the *canonical* watch URL, but a pre-existing thin
// worker reading may have been submitted under a different URL form (youtu.be,
// shorts, live, embed, or the exact link the user passed). by-url ownership
// hashes the stored URL, so this import won't find/upgrade those — it would
// create a duplicate. Look the variants up and tell the operator to drop any
// stale one (we don't auto-drop: that's a destructive R2/Vectorize operation
// that belongs to the corpus-drop tool).
// POSIX single-quote escaping for a value pasted into a shell command. The
// passed-in URL is operator-supplied and `new URL` accepts characters like
// `$()` in a query string, so wrapping it in double quotes would leave command
// substitution live. Single quotes disable all expansion; an embedded `'` is
// closed, escaped, and reopened.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function warnNoncanonicalOwners(
  videoId: string,
  canonicalUrl: string,
  passedUrl: string,
  deps: ApiDeps,
): Promise<void> {
  const candidates = new Set<string>([...youtubeWatchUrlVariants(videoId), passedUrl]);
  candidates.delete(canonicalUrl); // the canonical owner is handled by the import itself

  const found: { url: string; id?: string }[] = [];
  for (const candidate of candidates) {
    const hit = await lookupReading(candidate, deps);
    if (hit.found) found.push({ url: candidate, id: hit.id });
  }
  if (found.length === 0) return;

  process.stderr.write(
    `\nnote: found ${found.length} existing reading(s) under a noncanonical URL for this video.\n` +
      `This import claims the canonical ${canonicalUrl}, so those will NOT be replaced —\n` +
      `drop the stale variant(s) to avoid a duplicate:\n` +
      found.map((f) => `  npm run corpus-drop -- ${shellQuote(f.url)} --execute   # ${f.id ?? "?"}\n`).join(""),
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  if (!isYoutubeWatchUrl(args.url)) {
    process.stderr.write(`not a recognized YouTube watch URL: ${args.url}\n`);
    process.exit(2);
  }
  const videoId = parseVideoId(args.url)!;
  const watchUrl = canonicalWatchUrl(videoId);

  process.stderr.write(`youtube-import ${watchUrl}\n`);
  const oembedJson = await fetchText(oembedUrl(videoId));
  if (!oembedJson) {
    process.stderr.write("oEmbed lookup failed — the video may be private, deleted, or region-locked.\n");
    process.exit(1);
    return;
  }
  const watchHtml = await fetchText(watchUrl);
  if (!watchHtml) process.stderr.write("  watch page unavailable; importing title + author only.\n");

  const transcript = args.transcript ? fetchTranscriptViaYtDlp(watchUrl) : undefined;

  const body = buildYoutubeImport(args.url, { oembedJson, watchHtml, transcript });
  if (!body) {
    process.stderr.write("could not build an import from the fetched metadata (no usable title).\n");
    process.exit(1);
    return;
  }

  if (args.dryRun) {
    process.stderr.write(`source_url:  ${body.source_url}\n`);
    process.stderr.write(`title:       ${body.title ?? "(none)"}\n`);
    process.stderr.write(`transcript:  ${transcript ? `${transcript.length} chars` : "(none)"}\n`);
    process.stderr.write(`markdown:    ${body.markdown.length} bytes\n\n`);
    process.stdout.write(body.markdown + "\n");
    return;
  }

  const target = resolveApiTarget({ url: args.apiUrl, token: args.token });
  if (!target.token) {
    process.stderr.write("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)\n");
    process.exit(2);
    return;
  }
  const deps: ApiDeps = { ...target, fetch: globalThis.fetch };

  await warnNoncanonicalOwners(videoId, body.source_url, args.url, deps);

  const res = await importMarkdown(body, deps);
  if (res.outcome === "error") {
    process.stderr.write(`import failed: ${res.error}\n`);
    process.exit(1);
    return;
  }
  if (res.outcome === "existing") {
    process.stderr.write(
      `\nnote: ${body.source_url} already has a reading (${res.id ?? "?"}). Ready/pending owners are\n` +
        "returned as-is — to replace a worker-made floor-only reading with this richer import,\n" +
        "drop it first: npm run corpus-drop -- \"" +
        body.source_url +
        '" --execute\n',
    );
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
