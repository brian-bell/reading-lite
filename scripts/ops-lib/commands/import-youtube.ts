// `ops import youtube` — import a YouTube video with a *full* local
// extraction: title + author (oEmbed), description (watch-page
// ytInitialPlayerResponse), and the transcript (via yt-dlp). The in-worker
// path only reliably gets the oEmbed floor because datacenter egress is
// blocked from the watch page and timedtext is gated behind a proof-of-origin
// token; fetching from this machine's residential IP returns the full page,
// and yt-dlp does the player handshake bare timedtext fetches can't. See
// issue #17 / the youtube.ts extractor.
//
// Plan-first: a mode-less run performs the read-only extraction (oEmbed,
// watch page, yt-dlp captions into a cleaned temp dir) and prints the
// markdown it would import — no POST, no token needed. --execute imports and
// warns about noncanonical-URL owners.

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
} from "../../../src/modules/extractor/youtube";
import { buildYoutubeImport } from "../../youtube-import-lib/parse";
import { DEFAULT_API_BASE, resolveApiTarget, type ApiTarget } from "../../corpus-lib/config";
import { classifyOutcome, readingApiFor, type ReadingApi } from "../../lib/reading-api";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ImportYoutubeDeps extends BaseDeps {
  // Browser-header GET returning undefined on any failure (logged to stderr).
  fetchText: (url: string, io: CommandIo) => Promise<string | undefined>;
  // Best-effort transcript via yt-dlp; undefined when unavailable. Temp files
  // are cleaned inside.
  fetchTranscript: (watchUrl: string, io: CommandIo) => string | undefined;
  resolveApiTarget: (flags: { url?: string; token?: string }) => ApiTarget;
  // Constructed only on the execute path (plan mode never touches the network).
  makeApi: (target: ApiTarget) => Pick<ReadingApi, "importMarkdown" | "lookup">;
}

interface Args {
  url: string;
  execute: boolean;
  transcript: boolean;
  apiUrl?: string;
  token?: string;
}

function parseYoutubeArgs(argv: string[]): Args {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        execute: { type: "boolean", default: false },
        "no-transcript": { type: "boolean", default: false },
        "api-url": { type: "string" },
        token: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const url = positionals[0];
  if (!url) throw new UsageError("pass a YouTube watch URL");
  return {
    url,
    execute: values.execute === true,
    transcript: !values["no-transcript"],
    apiUrl: values["api-url"],
    token: values.token,
  };
}

// POSIX single-quote escaping for a value pasted into a shell command. The
// passed-in URL is operator-supplied and `new URL` accepts characters like
// `$()` in a query string, so wrapping it in double quotes would leave command
// substitution live. Single quotes disable all expansion; an embedded `'` is
// closed, escaped, and reopened.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// We always import under the *canonical* watch URL, but a pre-existing thin
// worker reading may have been submitted under a different URL form. by-url
// ownership hashes the stored URL, so this import won't find/upgrade those —
// it would create a duplicate. Look the variants up and tell the operator to
// drop any stale one (we don't auto-drop: that's a destructive R2/Vectorize
// operation that belongs to the corpus drop command).
async function warnNoncanonicalOwners(
  deps: ImportYoutubeDeps,
  videoId: string,
  canonicalUrl: string,
  passedUrl: string,
  api: Pick<ReadingApi, "lookup">,
): Promise<void> {
  const candidates = new Set<string>([...youtubeWatchUrlVariants(videoId), passedUrl]);
  candidates.delete(canonicalUrl); // the canonical owner is handled by the import itself

  const found: { url: string; id?: string }[] = [];
  for (const candidate of candidates) {
    const hit = await api.lookup(candidate);
    // Both kinds mean the URL has an owner (initializing = pointer claimed,
    // manifest still being written) — either way, warn about the duplicate.
    if (hit.kind === "existing" || hit.kind === "initializing") {
      found.push({ url: candidate, ...(hit.id === undefined ? {} : { id: hit.id }) });
    }
  }
  if (found.length === 0) return;

  deps.io.stderr(
    `\nnote: found ${found.length} existing reading(s) under a noncanonical URL for this video.\n` +
      `This import claims the canonical ${canonicalUrl}, so those will NOT be replaced —\n` +
      `drop the stale variant(s) to avoid a duplicate:\n` +
      // The lookup ran as the caller's token, so the duplicate belongs to that
      // token's tenant — which this CLI cannot resolve. Emit a placeholder the
      // operator must fill in rather than an executable global command.
      found.map((f) => `  npm run ops -- corpus drop --tenant <tenant> ${shellQuote(f.url)} --execute   # ${f.id ?? "?"}`).join("\n"),
  );
}

async function runImportYoutube(argv: string[], deps: ImportYoutubeDeps): Promise<number> {
  const args = parseYoutubeArgs(argv);
  const { io } = deps;

  if (!isYoutubeWatchUrl(args.url)) {
    throw new UsageError(`not a recognized YouTube watch URL: ${args.url}`);
  }
  const videoId = parseVideoId(args.url)!;
  const watchUrl = canonicalWatchUrl(videoId);

  io.stderr(`import youtube ${watchUrl}`);
  const oembedJson = await deps.fetchText(oembedUrl(videoId), io);
  if (!oembedJson) {
    io.stderr("oEmbed lookup failed — the video may be private, deleted, or region-locked.");
    return 1;
  }
  const watchHtml = await deps.fetchText(watchUrl, io);
  if (!watchHtml) io.stderr("  watch page unavailable; importing title + author only.");

  const transcript = args.transcript ? deps.fetchTranscript(watchUrl, io) : undefined;

  const body = buildYoutubeImport(args.url, { oembedJson, watchHtml, transcript });
  if (!body) {
    io.stderr("could not build an import from the fetched metadata (no usable title).");
    return 1;
  }

  if (!args.execute) {
    io.stderr(`source_url:  ${body.source_url}`);
    io.stderr(`title:       ${body.title ?? "(none)"}`);
    io.stderr(`transcript:  ${transcript ? `${transcript.length} chars` : "(none)"}`);
    io.stderr(`markdown:    ${body.markdown.length} bytes`);
    io.stderr("Rerun with --execute to import.");
    io.stdout(body.markdown);
    return 0;
  }

  const target = deps.resolveApiTarget({ url: args.apiUrl, token: args.token });
  if (!target.token) {
    throw new UsageError("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)");
  }
  const api = deps.makeApi(target);

  await warnNoncanonicalOwners(deps, videoId, body.source_url, args.url, api);

  const res = classifyOutcome(await api.importMarkdown(body));
  if (res.classification === "error") {
    io.stderr(`import failed: ${res.error}`);
    return 1;
  }
  if (res.classification === "existing") {
    io.stderr(
      `\nnote: ${body.source_url} already has a reading (${res.id ?? "?"}). Ready/pending owners are\n` +
        "returned as-is — to replace a worker-made floor-only reading with this richer import,\n" +
        'drop it first: npm run ops -- corpus drop --tenant <tenant> "' +
        body.source_url +
        '" --execute',
    );
  }

  const id = res.id ?? "(unknown)";
  io.stdout(
    JSON.stringify({ outcome: res.classification, id, poll: res.id ? `${target.base}/api/readings/${id}` : undefined }, null, 2),
  );
  io.stderr(`\nimported (${res.classification}) to ${target.base} — poll ${target.base}/api/readings/${id}`);
  return 0;
}

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+cb",
};

export const importYoutubeCommand: CommandDefinition<ImportYoutubeDeps> = {
  group: "import",
  name: "youtube",
  summary: "Import a YouTube video with full local extraction (oEmbed + description + transcript)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- import youtube <youtubeUrl> [options]

Plans by default: performs the read-only extraction (oEmbed, watch page,
yt-dlp captions — temp files cleaned) and prints the markdown it would import,
without POSTing. --execute imports through POST /api/readings/import-markdown
under the canonical watch URL and warns about noncanonical-URL owners.

Options:
  --no-transcript   Skip the yt-dlp transcript step (title + author + description only).
  --api-url <base>  Reading API base. Default: READER_URL env, then ${DEFAULT_API_BASE}
  --token <token>   Bearer token (execute only). Default: READER_API_TOKEN
                    env, then .prd.vars. Never printed.
  --execute         Import the video.
  --help            Show this message.

Examples:
  npm run ops -- import youtube "https://www.youtube.com/watch?v=YtTWNzOtkxU"
  npm run ops -- import youtube "https://youtu.be/YtTWNzOtkxU" --execute`,
  defaultDeps: (io: CommandIo): ImportYoutubeDeps => ({
    io,
    fetchText: async (url, cio) => {
      try {
        const res = await fetch(url, { headers: BROWSER_HEADERS });
        if (!res.ok) {
          cio.stderr(`  fetch ${url} -> ${res.status}`);
          return undefined;
        }
        return await res.text();
      } catch (e) {
        cio.stderr(`  fetch ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
    // Best-effort transcript via yt-dlp: it performs the player handshake that
    // bare timedtext GETs can't. Writes json3 subtitles to a temp dir, then
    // flattens them with the shared timedtextToText parser. Returns undefined
    // when yt-dlp is absent or the video has no captions.
    fetchTranscript: (watchUrl, cio) => {
      let dir: string | undefined;
      try {
        dir = mkdtempSync(join(tmpdir(), "yt-import-"));
        const run = spawnSync(
          "yt-dlp",
          [
            "--skip-download", "--write-subs", "--write-auto-subs",
            "--sub-langs", "en.*,en", "--sub-format", "json3",
            "--paths", dir, "-o", "%(id)s.%(ext)s", watchUrl,
          ],
          { encoding: "utf8", timeout: 90_000 },
        );
        if (run.error) {
          cio.stderr(
            `  yt-dlp unavailable (${run.error.message}); skipping transcript. Install yt-dlp or pass --no-transcript.`,
          );
          return undefined;
        }
        const json3 = readdirSync(dir).find((f) => f.endsWith(".json3"));
        if (!json3) {
          cio.stderr("  no captions found for this video; importing without a transcript.");
          return undefined;
        }
        const text = timedtextToText(readFileSync(join(dir, json3), "utf8"));
        return text || undefined;
      } catch (e) {
        cio.stderr(`  transcript step failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
    resolveApiTarget,
    makeApi: (target) => readingApiFor({ ...target, fetch: globalThis.fetch }),
  }),
  run: runImportYoutube,
};
