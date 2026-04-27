#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";

interface Args {
  url: string;
  base: string;
  token: string;
  pollMs: number;
  timeoutMs: number;
}

function parseCliArgs(): Args {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      base: { type: "string" },
      token: { type: "string" },
      "poll-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const url = values.url ?? positionals[0];
  if (!url) {
    printUsage();
    process.exit(2);
  }

  const devVars = loadDotVars(".dev.vars");
  const base =
    values.base ?? process.env.READER_BASE_URL ?? "http://127.0.0.1:8787";
  const token =
    values.token ?? process.env.READER_API_TOKEN ?? devVars.READER_API_TOKEN ?? "";
  if (!token) {
    console.error(
      "missing token. pass --token, set READER_API_TOKEN in env, or add it to .dev.vars.",
    );
    process.exit(2);
  }

  const pollMs = Number(values["poll-ms"] ?? 1500);
  const timeoutMs = Number(values["timeout-ms"] ?? 120_000);

  return {
    url,
    base: base.replace(/\/+$/, ""),
    token,
    pollMs,
    timeoutMs,
  };
}

function printUsage(): void {
  console.log(`Usage: npm run read -- <url> [--base <url>] [--token <t>] [--poll-ms 1500] [--timeout-ms 120000]

Posts a URL to the reading-lite worker and polls until the manifest is
ready or failed. The final manifest is printed as JSON to stdout.

Token resolution: --token > READER_API_TOKEN env > .dev.vars READER_API_TOKEN.
Base URL resolution: --base > READER_BASE_URL env > http://127.0.0.1:8787.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const headers = {
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
  };

  const postRes = await fetch(`${args.base}/readings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: args.url }),
  });
  const postBody = (await postRes.json()) as Record<string, unknown>;
  if (postRes.status !== 202 && postRes.status !== 200) {
    console.error(`POST /readings -> ${postRes.status}`);
    console.error(JSON.stringify(postBody, null, 2));
    process.exit(1);
  }

  const id = typeof postBody.id === "string" ? postBody.id : undefined;
  if (!id) {
    console.error("response missing id");
    console.error(JSON.stringify(postBody, null, 2));
    process.exit(1);
  }

  if (postRes.status === 200) {
    console.log(JSON.stringify(postBody, null, 2));
    return;
  }

  console.error(`pending id=${id}, polling /readings/${id} ...`);
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, args.pollMs));
    const r = await fetch(`${args.base}/readings/${id}`, { headers });
    if (r.status !== 200) {
      console.error(`GET /readings/${id} -> ${r.status}`);
      continue;
    }
    const m = (await r.json()) as Record<string, unknown>;
    const status = m.status;
    if (status === "ready" || status === "failed") {
      console.log(JSON.stringify(m, null, 2));
      if (status === "failed") process.exit(1);
      return;
    }
  }
  console.error(`timed out after ${args.timeoutMs}ms; reading still pending.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
