import { vi } from "vitest";
import { stubBatchCorpus } from "./batch-corpus";
import { type BatchRunDeps } from "../../scripts/corpus-lib/batch/run";
import { EMIT_READING_TOOL_NAME } from "../../src/modules/anthropic";
import type { AuditRow } from "../../scripts/corpus-lib/types";
import type { ExtractedContent } from "../../src/modules/extractor";
import type { Manifest } from "../../src/schemas/manifest";
import { batchSpendAuthority } from "./operator-spend";
import type { PersistedSidecar } from "../../scripts/corpus-lib/batch/types";

export const NOW = "2026-06-18T12:00:00.000Z";

export function manifest(id: string, over: Partial<Manifest> = {}): Manifest {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: id.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0"),
    status: "failed",
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

export function row(id: string): AuditRow {
  return {
    category: "failed",
    url: `https://example.com/${id}`,
    short: `example.com/${id}`,
    reading_id: id,
    key_prefix: `readings/kp-${id}`,
    attempts: 1,
  };
}

export const reading = {
  title: "Title",
  tldr: "Tldr.",
  tags: ["t"],
  keywords: ["keyword one", "keyword two", "keyword three"],
  people: [],
  orgs: [],
  novelty_verdict: "novel" as const,
  connections: [],
  summary_markdown: "body",
};

// Orchestration harness: in-memory corpus, R2, provider and spend fakes.
export function harness(seedManifests: Record<string, Manifest>) {
  const store = new Map<string, string>();
  for (const [id, m] of Object.entries(seedManifests)) {
    store.set(`readings/kp-${id}/manifest.json`, JSON.stringify(m));
    store.set(`readings/kp-${id}/extracted.md`, `# ${id}\n\nsaved markdown`);
  }
  const r2 = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, b: Uint8Array | string) => {
      store.set(k, typeof b === "string" ? b : new TextDecoder().decode(b));
    }),
    head: vi.fn(async (k: string) => store.has(k)),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    listKeys: vi.fn(async () => [...store.keys()]),
  };
  let sidecar: PersistedSidecar | null = null;
  let inputJsonl: string | null = null;
  const batch = {
    create: vi.fn(async (requests: Array<{ custom_id: string }>) => ({
      id: "msgbatch_run",
      processing_status: "in_progress",
      results_url: null,
      _ids: requests.map((r) => r.custom_id),
    })),
    get: vi.fn(async () => ({ id: "msgbatch_run", processing_status: "ended", results_url: "https://results" })),
    results: vi.fn(async () =>
      (sidecar?.targets ?? []).map((t) => ({
        custom_id: t.customId,
        result: {
          type: "succeeded" as const,
          message: {
            content: [{ type: "tool_use", id: "x", name: EMIT_READING_TOOL_NAME, input: { ...reading, title: `Title ${t.customId}` } }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      })),
    ),
  };
  const extract = vi.fn(
    async (url: string): Promise<ExtractedContent> => ({
      raw: new TextEncoder().encode("x"),
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "c".repeat(64),
      markdown: `fresh ${url}`,
      title: "Fresh",
    }),
  );
  const authority = batchSpendAuthority();
  const deps: BatchRunDeps = {
    r2: r2 as any,
    corpus: stubBatchCorpus(store),
    spend: authority.spend,
    batch: batch as any,
    embed: {
      embedMany: vi.fn(async (inputs: string[]) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0.1)),
        tokensByInput: inputs.map(() => 4),
      })),
    },
    extract,
    model: "claude-opus-4-8",
    newAttemptId: () => "at_recover_1",
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    loadSidecar: vi.fn(async () => null),
    saveSidecar: vi.fn(async (s: PersistedSidecar) => {
      sidecar = s;
    }),
    clearSidecar: vi.fn(async () => {
      sidecar = null;
    }),
    saveInputJsonl: vi.fn(async (jsonl: string) => {
      inputJsonl = jsonl;
    }),
    loadInputJsonl: vi.fn(async () => inputJsonl),
    // The reconciler's create-window lock isn't relevant to integration
    // tests — provide a no-op so the lock release path doesn't touch the fs.
    reconcileAcquireLock: async () => ({
      release: async () => undefined,
    }),
    poll: { intervalMs: 1, maxPolls: 5 },
  };
  return { store, r2, batch, extract, deps, authority, getSidecar: () => sidecar, setSidecar: (s: PersistedSidecar | null) => (sidecar = s), getInputJsonl: () => inputJsonl, setInputJsonl: (s: string | null) => (inputJsonl = s) };
}
