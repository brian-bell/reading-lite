// `ops import reddit` — import a Reddit thread from a `.json` listing payload
// that was fetched through a logged-in browser session (see the reddit-import
// skill). The worker can't fetch Reddit directly (datacenter egress gets a
// bot-challenge), so the skill drives Chrome to fetch the public
// `<thread>.json`, saves it, and this command parses it with the shared
// redditListingToMarkdown parser and POSTs the markdown to
// /api/readings/import-markdown, keyed by the canonical thread URL.
//
// Plan-first: a mode-less run parses the saved listing and prints the markdown
// it would import (no POST, no token needed); --execute imports.

import { parseArgs } from "node:util";
import { buildRedditImport } from "../../reddit-import-lib/parse";
import { isRedditThreadUrl } from "../../../src/modules/extractor/reddit";
import { DEFAULT_API_BASE, resolveApiTarget, type ApiTarget } from "../../corpus-lib/config";
import { classifyOutcome, readingApiFor, type ReadingApi } from "../../lib/reading-api";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ImportRedditDeps extends BaseDeps {
  readFile: (path: string) => Promise<string>;
  resolveApiTarget: (flags: { url?: string; token?: string }) => ApiTarget;
  // Constructed only on the execute path (plan mode never touches the network).
  makeApi: (target: ApiTarget) => Pick<ReadingApi, "importMarkdown">;
}

interface Args {
  url: string;
  json: string;
  execute: boolean;
  apiUrl?: string;
  token?: string;
}

function parseRedditArgs(argv: string[]): Args {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "string" },
        execute: { type: "boolean", default: false },
        "api-url": { type: "string" },
        token: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const url = positionals[0];
  if (!url || !values.json) {
    throw new UsageError("pass a Reddit thread URL and --json <file>");
  }
  return {
    url,
    json: values.json,
    execute: values.execute === true,
    apiUrl: values["api-url"],
    token: values.token,
  };
}

async function runImportReddit(argv: string[], deps: ImportRedditDeps): Promise<number> {
  const args = parseRedditArgs(argv);
  const { io } = deps;

  if (!isRedditThreadUrl(args.url)) {
    throw new UsageError(`not a recognized Reddit thread URL: ${args.url}`);
  }

  let jsonText: string;
  try {
    jsonText = await deps.readFile(args.json);
  } catch (e) {
    throw new UsageError(`cannot read --json ${args.json}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = buildRedditImport(args.url, jsonText);
  if (!body) {
    io.stderr(
      `could not parse a Reddit thread from ${args.json}. ` +
        "Make sure it's the saved `.json` listing (not the HTML page / a bot-challenge).",
    );
    return 1;
  }

  if (!args.execute) {
    io.stderr(`source_url: ${body.source_url}`);
    io.stderr(`title:      ${body.title ?? "(none)"}`);
    io.stderr(`markdown:   ${body.markdown.length} bytes`);
    io.stderr("Rerun with --execute to import.");
    io.stdout(body.markdown);
    return 0;
  }

  const target = deps.resolveApiTarget({ url: args.apiUrl, token: args.token });
  if (!target.token) {
    throw new UsageError("missing reading API token (pass --token, set READER_API_TOKEN, or .prd.vars)");
  }

  const res = classifyOutcome(await deps.makeApi(target).importMarkdown(body));
  if (res.classification === "error") {
    io.stderr(`import failed: ${res.error}`);
    return 1;
  }

  const id = res.id ?? "(unknown)";
  io.stdout(
    JSON.stringify({ outcome: res.classification, id, poll: res.id ? `${target.base}/api/readings/${id}` : undefined }, null, 2),
  );
  io.stderr(`\nimported (${res.classification}) to ${target.base} — poll ${target.base}/api/readings/${id}`);
  return 0;
}

export const importRedditCommand: CommandDefinition<ImportRedditDeps> = {
  group: "import",
  name: "reddit",
  summary: "Import a Reddit thread from a saved .json listing",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- import reddit <redditThreadUrl> --json <file> [options]

Plans by default: parses the saved listing and prints the markdown it would
import without POSTing. --execute imports through
POST /api/readings/import-markdown, keyed by the canonical thread URL.

Options:
  --json <file>     Path to the saved Reddit .json listing (required).
  --api-url <base>  Reading API base. Default: READER_URL env, then ${DEFAULT_API_BASE}
  --token <token>   Bearer token (execute only). Default: READER_API_TOKEN
                    env, then .prd.vars. Never printed.
  --execute         Import the thread.
  --help            Show this message.

Examples:
  npm run ops -- import reddit "https://www.reddit.com/r/programming/comments/<id>/<slug>/" --json /tmp/thread.json
  npm run ops -- import reddit "https://redd.it/<id>" --json /tmp/thread.json --execute`,
  defaultDeps: (io: CommandIo): ImportRedditDeps => ({
    io,
    readFile: async (p) => {
      const { promises: fs } = await import("node:fs");
      return fs.readFile(p, "utf8");
    },
    resolveApiTarget,
    makeApi: (target) => readingApiFor({ ...target, fetch: globalThis.fetch }),
  }),
  run: runImportReddit,
};
