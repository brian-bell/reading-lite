#!/usr/bin/env -S npx tsx
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadDotVars } from "./lib/dotvars";
import { parseSummarizerProvider } from "../src/modules/summarizer";
import {
  isAttemptTerminal,
  summarizeDiagnostics,
  validateStagingSmokeTarget,
} from "./staging-provider-smoke-lib";

interface Args {
  base: string;
  provider: "openai" | "anthropic";
  execute: boolean;
  output?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      base: {
        type: "string",
        default: "https://reading-lite-staging.bellbm.workers.dev",
      },
      provider: { type: "string" },
      execute: { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.provider) {
    process.stdout.write(`Usage: npx tsx scripts/staging-provider-smoke.ts --provider openai|anthropic [options]

Previews submit, markdown import, reprocess, deliberate failure, diagnostics,
and list-visibility checks against staging. It never prints the bearer token
and writes nothing unless --execute is present.

  --base <url>       Worker origin.
  --provider <name>  Expected summarization provider.
  --execute          Perform staging writes.
  --output <path>    Optional JSON evidence output.
`);
    process.exit(values.help ? 0 : 2);
  }
  return {
    base: values.base!.replace(/\/$/, ""),
    provider: parseSummarizerProvider(values.provider),
    execute: values.execute === true,
    ...(values.output === undefined ? {} : { output: values.output }),
  };
}

function resolveToken(): string {
  const token =
    process.env.READER_API_TOKEN ??
    loadDotVars(".stg.vars").READER_API_TOKEN ??
    loadDotVars(".dev.vars").READER_API_TOKEN;
  if (!token) throw new Error("missing staging READER_API_TOKEN");
  return token;
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (!args.execute) {
    process.stdout.write(
      `[DRY RUN] would run provider smoke against ${args.base} for ${args.provider}; pass --execute to write staging data.\n`,
    );
    return;
  }
  validateStagingSmokeTarget(args);
  const token = resolveToken();
  const marker = `eval-${args.provider}-${Date.now()}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<JsonObject> => {
    const response = await fetch(`${args.base}${path}`, {
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

  const waitTerminal = async (id: string): Promise<JsonObject> => {
    for (let attempt = 0; attempt < 90; attempt++) {
      const manifest = await request(`/api/readings/${encodeURIComponent(id)}`);
      if (manifest.status === "ready" || manifest.status === "failed") {
        return manifest;
      }
      await sleep(2_000);
    }
    throw new Error(`reading ${id} did not become terminal`);
  };
  const waitAttemptTerminal = async (
    id: string,
    attemptId: string,
  ): Promise<JsonObject> => {
    for (let attempt = 0; attempt < 90; attempt++) {
      const manifest = await request(`/api/readings/${encodeURIComponent(id)}`);
      if (isAttemptTerminal(manifest, attemptId)) return manifest;
      await sleep(2_000);
    }
    throw new Error(`attempt ${attemptId} for reading ${id} did not become terminal`);
  };
  const waitDiagnostics = async (id: string): Promise<JsonObject> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      const diagnostics = await request(
        `/api/readings/${encodeURIComponent(id)}/diagnostics`,
      );
      try {
        summarizeDiagnostics(diagnostics);
        return diagnostics;
      } catch (error) {
        lastError = error;
        await sleep(1_000);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`diagnostics for ${id} did not converge`);
  };

  const idFrom = (body: JsonObject, label: string): string => {
    if (typeof body.id !== "string") {
      throw new Error(`${label} response did not include an id`);
    }
    return body.id;
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

  const submitted = await request("/api/readings", {
    method: "POST",
    body: JSON.stringify({
      url: `https://www.rfc-editor.org/rfc/rfc1149.html?reading-lite-${marker}`,
      email: false,
    }),
  });
  const submittedId = idFrom(submitted, "submit");
  process.stderr.write(`submit ${submittedId}: waiting\n`);
  const submittedManifest = await waitTerminal(submittedId);
  if (submittedManifest.status !== "ready") {
    throw new Error(`submit ${submittedId} ended ${String(submittedManifest.status)}`);
  }
  assertProvider(submittedManifest, "submit");

  const imported = await request("/api/readings/import-markdown", {
    method: "POST",
    body: JSON.stringify({
      source_url: `https://eval.invalid/staging/${marker}/import`,
      title: `Staging ${args.provider} import`,
      markdown:
        `# Staging provider smoke\n\n` +
        `This synthetic article marks ${marker}. Rowan Vale measured a 27 percent reduction in water use after replacing a timer with soil-moisture control. The test lasted six weeks and did not measure winter performance.`,
      email: false,
    }),
  });
  const importedId = idFrom(imported, "import");
  process.stderr.write(`import ${importedId}: waiting\n`);
  const importedManifest = await waitTerminal(importedId);
  if (importedManifest.status !== "ready") {
    throw new Error(`import ${importedId} ended ${String(importedManifest.status)}`);
  }
  assertProvider(importedManifest, "import");

  const beforeReprocessUpdatedAt = submittedManifest.updated_at;
  const reprocessed = await request(
    `/api/readings/${encodeURIComponent(submittedId)}/reprocess`,
    {
      method: "POST",
      body: JSON.stringify({ force: true }),
    },
  );
  idFrom(reprocessed, "reprocess");
  if (typeof reprocessed.attempt_id !== "string") {
    throw new Error("reprocess response did not include an attempt_id");
  }
  process.stderr.write(`reprocess ${submittedId}: waiting\n`);
  const reprocessedManifest = await waitAttemptTerminal(
    submittedId,
    reprocessed.attempt_id,
  );
  if (
    reprocessedManifest.status !== "ready" ||
    reprocessedManifest.updated_at === beforeReprocessUpdatedAt
  ) {
    throw new Error(`reprocess ${submittedId} did not produce a new ready manifest`);
  }
  assertProvider(reprocessedManifest, "reprocess");

  const failed = await request("/api/readings", {
    method: "POST",
    body: JSON.stringify({
      url: `https://${marker}.invalid/unreachable`,
      email: false,
    }),
  });
  const failedId = idFrom(failed, "failure submit");
  process.stderr.write(`failure ${failedId}: waiting\n`);
  const failedManifest = await waitTerminal(failedId);
  if (failedManifest.status !== "failed") {
    throw new Error(`failure ${failedId} ended ${String(failedManifest.status)}`);
  }

  const [submitDiagnostics, importDiagnostics, failureDiagnostics, list] =
    await Promise.all([
      waitDiagnostics(submittedId),
      waitDiagnostics(importedId),
      waitDiagnostics(failedId),
      request(`/api/readings?q=${encodeURIComponent(marker)}&limit=20`),
    ]);
  const listRows = Array.isArray(list.readings) ? list.readings : [];
  const visibleIds = new Set(
    listRows
      .map((row) =>
        typeof row === "object" && row !== null
          ? (row as JsonObject).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string"),
  );
  for (const id of [submittedId, importedId, failedId]) {
    if (!visibleIds.has(id)) throw new Error(`list did not contain ${id}`);
  }

  const evidence = {
    generated_at: new Date().toISOString(),
    base: args.base,
    provider: args.provider,
    marker,
    submit: {
      id: submittedId,
      status: reprocessedManifest.status,
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
  const rendered = JSON.stringify(evidence, null, 2) + "\n";
  if (args.output) await writeFile(args.output, rendered, "utf8");
  process.stdout.write(rendered);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
