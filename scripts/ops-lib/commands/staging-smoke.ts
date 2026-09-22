// `ops staging smoke` — end-to-end provider smoke against staging: submit,
// markdown import, reprocess, deliberate failure, diagnostics, extracted content,
// and list visibility. It never prints the bearer token. Plan-first: a mode-less
// run only describes the checks; --execute performs the staging
// writes (paid summarization on staging).

import { parseArgs } from "node:util";
import { loadDotVars } from "../../lib/dotvars";
import { classifyOutcome, readingApiFor, type ReadingApiOutcome } from "../../lib/reading-api";
import { parseSummarizerProvider } from "../../../src/modules/summarizer";
import {
  isAttemptTerminal,
  summarizeDiagnostics,
  validateStagingSmokeTarget,
} from "../../lib/staging-provider-smoke-lib";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface StagingSmokeDeps extends BaseDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  writeFile: (path: string, body: string) => Promise<void>;
  resolveToken: () => string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface Args {
  base: string;
  provider: "openai" | "anthropic";
  execute: boolean;
  output?: string;
}

function parseSmokeArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: {
          type: "string",
          default: "https://reading-lite-staging.bellbm.workers.dev",
        },
        provider: { type: "string" },
        execute: { type: "boolean", default: false },
        output: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.provider) throw new UsageError("missing required --provider openai|anthropic");
  let provider;
  try {
    provider = parseSummarizerProvider(values.provider);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  return {
    base: values.base!.replace(/\/$/, ""),
    provider,
    execute: values.execute === true,
    ...(values.output === undefined ? {} : { output: values.output }),
  };
}

async function runStagingSmoke(argv: string[], deps: StagingSmokeDeps): Promise<number> {
  const args = parseSmokeArgs(argv);
  const { io } = deps;
  if (!args.execute) {
    io.stdout(
      `[PLAN] would run provider smoke against ${args.base} for ${args.provider}; pass --execute to write staging data.`,
    );
    return 0;
  }
  validateStagingSmokeTarget(args);
  const token = deps.resolveToken();
  const marker = `eval-${args.provider}-${deps.now()}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Intake verbs and terminal polling go through the Reading API client; the
  // read-path checks below (diagnostics, list) keep this local helper.
  const api = readingApiFor({
    base: args.base,
    token,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
  });

  const request = async (path: string, init?: RequestInit): Promise<JsonObject> => {
    const response = await deps.fetch(`${args.base}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { text };
    }
    if (!response.ok) {
      throw new Error(`${init?.method ?? "GET"} ${path}: HTTP ${response.status} ${text}`);
    }
    return body as JsonObject;
  };

  // A smoke submit/import must land an accepted owner; anything else aborts
  // the run with the decoded reason.
  const acceptedId = (out: ReadingApiOutcome, label: string): string => {
    if ((out.kind === "activated" || out.kind === "existing") && typeof out.id === "string") {
      return out.id;
    }
    throw new Error(`${label} was not accepted: ${classifyOutcome(out).error ?? out.kind}`);
  };

  const waitTerminal = async (id: string): Promise<JsonObject> => {
    const out = await api.waitTerminal(id, { pollMs: 2_000, timeoutMs: 180_000 });
    if (out.kind === "timeout") throw new Error(`reading ${id} did not become terminal`);
    return out.manifest as unknown as JsonObject;
  };
  const waitAttemptTerminal = async (id: string, attemptId: string): Promise<JsonObject> => {
    for (let attempt = 0; attempt < 90; attempt++) {
      const res = await api.getReading(id);
      if (res.kind === "manifest") {
        const manifest = res.manifest as unknown as JsonObject;
        if (isAttemptTerminal(manifest, attemptId)) return manifest;
      } else if (
        res.kind === "http_error" &&
        res.status !== 408 &&
        res.status !== 429 &&
        res.status < 500
      ) {
        throw new Error(
          `GET /api/readings/${encodeURIComponent(id)}: HTTP ${res.status} ${res.message}`.trim(),
        );
      }
      await deps.sleep(2_000);
    }
    throw new Error(`attempt ${attemptId} for reading ${id} did not become terminal`);
  };
  const waitDiagnostics = async (id: string): Promise<JsonObject> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      const diagnostics = await request(`/api/readings/${encodeURIComponent(id)}/diagnostics`);
      try {
        summarizeDiagnostics(diagnostics);
        return diagnostics;
      } catch (error) {
        lastError = error;
        await deps.sleep(1_000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`diagnostics for ${id} did not converge`);
  };

  const assertProvider = (manifest: JsonObject, label: string): void => {
    const usage = manifest.usage as JsonObject | undefined;
    const summarization = usage?.summarization as JsonObject | undefined;
    if (summarization?.provider !== args.provider) {
      throw new Error(
        `${label} expected provider ${args.provider}, got ${String(summarization?.provider)}`,
      );
    }
  };

  const assertExtractedContent = async (manifest: JsonObject, label: string): Promise<void> => {
    if (manifest.content_status !== "captured") {
      throw new Error(`${label} expected captured article text, got ${String(manifest.content_status)}`);
    }
    const response = await deps.fetch(
      `${args.base}/api/readings/${encodeURIComponent(String(manifest.id))}/content`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`${label} extracted article request failed: HTTP ${response.status}`);
    }
    if (!(await response.text()).trim()) {
      throw new Error(`${label} extracted article text was empty`);
    }
  };

  const submittedId = acceptedId(
    await api.submit(`https://www.rfc-editor.org/rfc/rfc1149.html?reading-lite-${marker}`, {
      email: false,
    }),
    "submit",
  );
  io.stderr(`submit ${submittedId}: waiting`);
  const submittedManifest = await waitTerminal(submittedId);
  if (submittedManifest.status !== "ready") {
    throw new Error(`submit ${submittedId} ended ${String(submittedManifest.status)}`);
  }
  await assertExtractedContent(submittedManifest, "submit");
  assertProvider(submittedManifest, "submit");

  const importedId = acceptedId(
    await api.importMarkdown({
      source_url: `https://eval.invalid/staging/${marker}/import`,
      title: `Staging ${args.provider} import`,
      markdown:
        `# Staging provider smoke\n\n` +
        `This synthetic article marks ${marker}. Rowan Vale measured a 27 percent reduction in water use after replacing a timer with soil-moisture control. The test lasted six weeks and did not measure winter performance.`,
      email: false,
    }),
    "import",
  );
  io.stderr(`import ${importedId}: waiting`);
  const importedManifest = await waitTerminal(importedId);
  if (importedManifest.status !== "ready") {
    throw new Error(`import ${importedId} ended ${String(importedManifest.status)}`);
  }
  await assertExtractedContent(importedManifest, "import");
  assertProvider(importedManifest, "import");

  const beforeReprocessUpdatedAt = submittedManifest.updated_at;
  const reprocessed = await api.reprocess(submittedId, { force: true });
  if (reprocessed.kind !== "activated") {
    throw new Error(
      `reprocess was not accepted: ${classifyOutcome(reprocessed).error ?? reprocessed.kind}`,
    );
  }
  if (typeof reprocessed.attemptId !== "string") {
    throw new Error("reprocess response did not include an attempt_id");
  }
  io.stderr(`reprocess ${submittedId}: waiting`);
  const reprocessedManifest = await waitAttemptTerminal(submittedId, reprocessed.attemptId);
  if (
    reprocessedManifest.status !== "ready" ||
    reprocessedManifest.updated_at === beforeReprocessUpdatedAt
  ) {
    throw new Error(`reprocess ${submittedId} did not produce a new ready manifest`);
  }
  await assertExtractedContent(reprocessedManifest, "reprocess");
  assertProvider(reprocessedManifest, "reprocess");

  const failedId = acceptedId(
    await api.submit(`https://${marker}.invalid/unreachable`, { email: false }),
    "failure submit",
  );
  io.stderr(`failure ${failedId}: waiting`);
  const failedManifest = await waitTerminal(failedId);
  if (failedManifest.status !== "failed") {
    throw new Error(`failure ${failedId} ended ${String(failedManifest.status)}`);
  }

  const [submitDiagnostics, importDiagnostics, failureDiagnostics, list] = await Promise.all([
    waitDiagnostics(submittedId),
    waitDiagnostics(importedId),
    waitDiagnostics(failedId),
    request(`/api/readings?q=${encodeURIComponent(marker)}&limit=20`),
  ]);
  const listRows = Array.isArray(list.readings) ? list.readings : [];
  const visibleIds = new Set(
    listRows
      .map((row) =>
        typeof row === "object" && row !== null ? (row as JsonObject).id : undefined,
      )
      .filter((id): id is string => typeof id === "string"),
  );
  for (const id of [submittedId, importedId, failedId]) {
    if (!visibleIds.has(id)) throw new Error(`list did not contain ${id}`);
  }

  const evidence = {
    generated_at: new Date(deps.now()).toISOString(),
    base: args.base,
    provider: args.provider,
    marker,
    submit: {
      id: submittedId,
      status: reprocessedManifest.status,
      content_status: reprocessedManifest.content_status,
      model: (
        (reprocessedManifest.usage as JsonObject | undefined)
          ?.summarization as JsonObject | undefined
      )?.model,
      last_attempt: reprocessedManifest.last_attempt,
      diagnostics: summarizeDiagnostics(submitDiagnostics),
    },
    import: {
      id: importedId,
      status: importedManifest.status,
      content_status: importedManifest.content_status,
      model: (
        (importedManifest.usage as JsonObject | undefined)
          ?.summarization as JsonObject | undefined
      )?.model,
      diagnostics: summarizeDiagnostics(importDiagnostics),
    },
    failure: {
      id: failedId,
      status: failedManifest.status,
      error: failedManifest.error,
      diagnostics: summarizeDiagnostics(failureDiagnostics),
    },
    list_visible_ids: [...visibleIds],
  };
  const rendered = JSON.stringify(evidence, null, 2);
  if (args.output) await deps.writeFile(args.output, rendered + "\n");
  io.stdout(rendered);
  return 0;
}

export const stagingSmokeCommand: CommandDefinition<StagingSmokeDeps> = {
  group: "staging",
  name: "smoke",
  summary: "End-to-end provider smoke against staging (submit/import/reprocess/failure)",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- staging smoke --provider openai|anthropic [options]

Previews submit, markdown import, reprocess, deliberate failure, diagnostics,
extracted-content, and list-visibility checks against staging. It never prints
the bearer token and writes nothing unless --execute is present. --execute performs the staging
writes and triggers paid summarization on staging.

Against PostgreSQL-backed staging, run --execute only after the #349 import:
the #348 importer refuses a database that already holds application rows, and
the bearer token is the one founder bootstrap imports, which must not run on
staging before #349 either.

Options:
  --base <url>       Worker origin. Default: the staging workers.dev origin.
  --provider <name>  Expected summarization provider (required).
  --output <path>    Optional JSON evidence output (execute only).
  --execute          Perform the staging writes.
  --help             Show this message.`,
  defaultDeps: (io: CommandIo): StagingSmokeDeps => ({
    io,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    writeFile: async (p, body) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(p, body, "utf8");
    },
    resolveToken: () => {
      const token =
        process.env.READER_API_TOKEN ??
        loadDotVars(".stg.vars").READER_API_TOKEN ??
        loadDotVars(".dev.vars").READER_API_TOKEN;
      if (!token) throw new Error("missing staging READER_API_TOKEN");
      return token;
    },
  }),
  run: runStagingSmoke,
};
