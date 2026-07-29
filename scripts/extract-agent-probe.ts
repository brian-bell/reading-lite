// Read-only fixture/live extraction probe.
//
// This entrypoint intentionally has no reading API, submitter, sidecar, lock,
// or run-log imports. It performs GET/render work only and prints bounded
// metadata—never extracted Markdown.

import { lookup as dnsLookup } from "node:dns/promises";
import { makePlaywrightRenderPage } from "./extract-agent-lib/render-playwright";
import {
  parseProbeArgs,
  readBoundedUtf8,
  runProbe,
  type ProbeResult,
} from "./extract-agent-lib/probe";

const PROBE_MAX_BYTES = 20 * 1024 * 1024;

async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2));
  const lookup = (hostname: string) => dnsLookup(hostname, { all: true });
  const results = await runProbe(args, {
    readFile: readBoundedUtf8,
    fetch,
    lookup,
    renderPage: makePlaywrightRenderPage({ lookup }),
    maxBytes: PROBE_MAX_BYTES,
  });

  console.log(args.json ? JSON.stringify(results, null, 2) : formatText(results));
}

function formatText(results: ProbeResult[]): string {
  return results
    .map((result) => {
      const evidence = result.evidence_codes.length > 0
        ? result.evidence_codes.join(",")
        : "none";
      return [
        `${result.tier}: ${result.outcome}`,
        `title=${JSON.stringify(result.title ?? null)}`,
        `normalized_character_count=${result.normalized_character_count}`,
        `evidence_codes=${evidence}`,
      ].join(" ");
    })
    .join("\n");
}

main().catch((error) => {
  console.error(`extract-agent:probe: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
