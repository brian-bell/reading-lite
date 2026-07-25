import type { ListIndexItem, ListReadingsResponse } from "../../../src/schemas/api";
import type { AgentConfig } from "../../../scripts/extract-agent-lib/config";

let counter = 0;

// Single home for a test config, so a new knob lands here once rather than in
// every suite that needs an AgentConfig.
export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    api: { base: "https://reading.example", token: "tok" },
    maxPaidActions: 25,
    maxAttempts: 3,
    fetchMaxBytes: 20 * 1024 * 1024,
    minArticleChars: 350,
    statePath: "/unused/state.json",
    runLogPath: "/unused/runs.jsonl",
    runLogMaxBytes: 5 * 1024 * 1024,
    lockPath: "/unused/agent.lock",
    lockMaxAgeSeconds: 3 * 60 * 60,
    email: false,
    ...overrides,
  };
}

export function makeRow(overrides: Partial<ListIndexItem> = {}): ListIndexItem {
  counter += 1;
  return {
    id: `rd_${counter.toString().padStart(4, "0")}`,
    key_prefix: `readings/rd_${counter.toString().padStart(4, "0")}`,
    url: `https://example.com/article-${counter}`,
    status: "failed",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

export function pageResponse(
  rows: ListIndexItem[],
  hasMore: boolean,
  offset = 0,
): ListReadingsResponse {
  return { readings: rows, limit: 100, offset, has_more: hasMore };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
