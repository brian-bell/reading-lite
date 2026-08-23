// `ops extract probe` — read-only fixture/live extraction probe.
//
// Intentionally composed without the reading API, submitter, sidecar, lock,
// or run-log seams: it performs GET/render work only and prints bounded
// metadata — never extracted Markdown. Registered read-only, so the
// dispatcher rejects --execute. Probe machinery (and the lazily-imported
// Playwright renderer seam) loads only when the command runs — never at
// registry/help time.

import type { ProbeArgs, ProbeResult } from "../../extract-agent-lib/probe";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ExtractProbeDeps extends BaseDeps {
  // One lazy loader returning both halves: parsing (pure) and the probe run.
  loadProbe: () => Promise<{
    parseProbeArgs: (argv: string[]) => ProbeArgs;
    runProbe: (args: ProbeArgs) => Promise<ProbeResult[]>;
  }>;
}

async function runExtractProbe(argv: string[], deps: ExtractProbeDeps): Promise<number> {
  const { parseProbeArgs, runProbe } = await deps.loadProbe();
  let args: ProbeArgs;
  try {
    args = parseProbeArgs(argv);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const results = await runProbe(args);
  deps.io.stdout(args.json ? JSON.stringify(results, null, 2) : formatText(results));
  return 0;
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

const PROBE_MAX_BYTES = 20 * 1024 * 1024;

export const extractProbeCommand: CommandDefinition<ExtractProbeDeps> = {
  group: "extract",
  name: "probe",
  summary: "Probe what the static/headless extraction tiers see for a URL or fixture",
  safety: "read-only",
  helpText: `Usage: npm run ops -- extract probe (--url <url> | --html <path>) [options]

Read-only: performs GET/render work only and prints bounded metadata — never
extracted Markdown, and never touches the reading API, sidecar, lock, or run
log.

Options:
  --url <url>          Probe a live URL.
  --html <path>        Probe a saved HTML fixture instead (with --source-url).
  --source-url <url>   Source URL to attribute a --html fixture to.
  --tier <t>           static, headless, or both (default: both).
  --json               Print structured JSON instead of text.
  --help               Show this message.`,
  defaultDeps: (io: CommandIo): ExtractProbeDeps => ({
    io,
    loadProbe: async () => {
      const { lookup: dnsLookup } = await import("node:dns/promises");
      const { makePlaywrightRenderPage } = await import("../../extract-agent-lib/render-playwright");
      const { parseProbeArgs, readBoundedUtf8, runProbe } = await import("../../extract-agent-lib/probe");
      const lookup = (hostname: string) => dnsLookup(hostname, { all: true });
      return {
        parseProbeArgs,
        runProbe: (args) =>
          runProbe(args, {
            readFile: readBoundedUtf8,
            fetch,
            lookup,
            renderPage: makePlaywrightRenderPage({ lookup }),
            maxBytes: PROBE_MAX_BYTES,
          }),
      };
    },
  }),
  run: runExtractProbe,
};
