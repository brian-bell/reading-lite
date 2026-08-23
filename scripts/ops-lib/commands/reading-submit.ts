// `ops reading submit` — POST a URL to the reading API and poll until the
// manifest reaches a terminal state.
//
// This workflow used to act by default (scripts/read-url.ts). Under the common
// contract a mode-less invocation prints a redacted plan — source URL, API
// target, and polling behavior — without requiring a token or making any
// request; --execute performs the submission and polls. The bearer token stays
// opaque: plans and logs report only whether one resolved, never its value.

import { parseArgs } from "node:util";
import { loadDotVars } from "../../lib/dotvars";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ReadingSubmitDeps extends BaseDeps {
  fetch: typeof fetch;
  // Base/token resolution (env + .dev.vars). Injected so tests never read the
  // developer's dotvars. The token may be empty — plan mode tolerates that.
  resolveTarget: (flags: { base?: string; token?: string }) => { base: string; token: string };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface Args {
  url: string;
  base?: string;
  token?: string;
  pollMs: number;
  timeoutMs: number;
  execute: boolean;
}

function parseSubmitArgs(argv: string[]): Args {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        base: { type: "string" },
        token: { type: "string" },
        "poll-ms": { type: "string" },
        "timeout-ms": { type: "string" },
        execute: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const url = values.url ?? positionals[0];
  if (!url) throw new UsageError("missing URL: pass it as a positional argument or --url");
  return {
    url,
    base: values.base,
    token: values.token,
    pollMs: Number(values["poll-ms"] ?? 1500),
    timeoutMs: Number(values["timeout-ms"] ?? 120_000),
    execute: values.execute === true,
  };
}

async function runReadingSubmit(argv: string[], deps: ReadingSubmitDeps): Promise<number> {
  const args = parseSubmitArgs(argv);
  const target = deps.resolveTarget({ base: args.base, token: args.token });

  if (!args.execute) {
    deps.io.stdout(`Plan: submit ${args.url}`);
    deps.io.stdout(`  would POST ${target.base}/api/readings`);
    deps.io.stdout(`  then poll GET ${target.base}/api/readings/{id} every ${args.pollMs}ms until ready/failed (timeout ${args.timeoutMs}ms)`);
    deps.io.stdout(`  bearer token: ${target.token ? "resolved (redacted)" : "NOT resolved — required for --execute"}`);
    deps.io.stdout("Rerun with --execute to submit.");
    return 0;
  }

  if (!target.token) {
    throw new UsageError("missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars.");
  }

  const headers = {
    authorization: `Bearer ${target.token}`,
    "content-type": "application/json",
  };

  const postRes = await deps.fetch(`${target.base}/api/readings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: args.url }),
  });
  const postBody = (await postRes.json()) as Record<string, unknown>;
  if (postRes.status !== 202 && postRes.status !== 200) {
    deps.io.stderr(`POST /api/readings -> ${postRes.status}`);
    deps.io.stderr(JSON.stringify(postBody, null, 2));
    return 1;
  }

  const id = typeof postBody.id === "string" ? postBody.id : undefined;
  if (!id) {
    deps.io.stderr("response missing id");
    deps.io.stderr(JSON.stringify(postBody, null, 2));
    return 1;
  }

  if (postRes.status === 200) {
    deps.io.stdout(JSON.stringify(postBody, null, 2));
    return 0;
  }

  deps.io.stderr(`pending id=${id}, polling /api/readings/${id} ...`);
  const deadline = deps.now() + args.timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(args.pollMs);
    const r = await deps.fetch(`${target.base}/api/readings/${id}`, { headers });
    if (r.status !== 200) {
      deps.io.stderr(`GET /api/readings/${id} -> ${r.status}`);
      continue;
    }
    const m = (await r.json()) as Record<string, unknown>;
    const status = m.status;
    if (status === "ready" || status === "failed") {
      deps.io.stdout(JSON.stringify(m, null, 2));
      return status === "failed" ? 1 : 0;
    }
  }
  deps.io.stderr(`timed out after ${args.timeoutMs}ms; reading still pending.`);
  return 1;
}

export const readingSubmitCommand: CommandDefinition<ReadingSubmitDeps> = {
  group: "reading",
  name: "submit",
  summary: "Submit a URL to the reading API and poll to a terminal state",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- reading submit <url> [options]

Plans by default (no token needed, no request made); --execute POSTs the URL
to the reading API and polls until the manifest is ready or failed, printing
the final manifest as JSON to stdout.

Options:
  --url <url>         Source URL (or pass it as the positional argument).
  --base <url>        API base. Default: READER_BASE_URL env, then
                      http://127.0.0.1:8787.
  --token <token>     Bearer token. Default: READER_API_TOKEN env, then
                      .dev.vars READER_API_TOKEN. Never printed.
  --poll-ms <n>       Poll interval while pending. Default: 1500.
  --timeout-ms <n>    Give up after this long. Default: 120000.
  --execute           Submit and poll.
  --help              Show this message.`,
  defaultDeps: (io: CommandIo): ReadingSubmitDeps => ({
    io,
    fetch: globalThis.fetch,
    resolveTarget: (flags) => {
      const base = (flags.base ?? process.env.READER_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
      const token =
        flags.token ?? process.env.READER_API_TOKEN ?? loadDotVars(".dev.vars").READER_API_TOKEN ?? "";
      return { base, token };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }),
  run: runReadingSubmit,
};
