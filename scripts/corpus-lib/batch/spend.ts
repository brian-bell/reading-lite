import { createHash } from "node:crypto";
import { SpendAdmissionError, type SpendRpc } from "../../../src/control-plane/paid-dispatch";
import { utcSpendDay, type SpendQuote } from "../../../src/control-plane/spend-ledger";
import {
  actualPaidCost,
  quotePaidRequest,
  type PaidQuote,
} from "../../../src/modules/paid-pricing";
import type { AnthropicBatchRequest, BatchResult } from "./clients";

// Batch admission against the central spend authority (reading-lite-gh319.2).
// A provider batch is one operation: its maximum is the sum of the synchronous
// quote of every request in it, reserved and marked dispatched before the
// first pending sidecar, and settled from the validated results.
//
// Batch prices are at most the synchronous prices the catalog holds, so the
// synchronous bound is an upper bound on what the batch can bill; the catalog
// has no batch entries. A request the catalog cannot bound refuses the whole
// batch before any paid call.
//
// After dispatch the charge only moves down on proof: settlement needs valid
// usage for every request, and a batch known never to have been created
// settles at zero. A create that may have happened keeps the maximum.

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };

export interface BatchSpendBound {
  catalogVersion: number;
  requestFingerprint: string;
  maxMicrodollars: number;
  /** Anthropic's cache-write rate for the prompt shape, needed to price usage. */
  anthropicCacheWriteRate?: number;
}

/** What the sidecar persists so any later resume settles the same operation. */
export interface BatchSpendIdentity {
  tenantId: string;
  opId: string;
  quote: SpendQuote;
  anthropicCacheWriteRate?: number;
}

export type BatchSpendOutcome =
  | { state: "settled"; actualMicrodollars: number; maxMicrodollars: number }
  | { state: "held"; maxMicrodollars: number; reason: string }
  // A sidecar written before batch spend accounting: nothing was admitted.
  | { state: "unmetered" };

export async function boundAnthropicBatch(
  requests: AnthropicBatchRequest[],
  model: string,
): Promise<BatchSpendBound> {
  return boundCollection(
    ANTHROPIC_MESSAGES_URL,
    model,
    requests.map((request) => request.params),
    JSON.stringify(requests),
  );
}

export async function boundOpenAIBatch(jsonl: string, model: string): Promise<BatchSpendBound> {
  const bodies: unknown[] = [];
  for (const line of jsonl.split("\n")) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SpendAdmissionError("unbounded_request");
    }
    const row = parsed as { method?: unknown; url?: unknown; body?: unknown } | null;
    if (row?.method !== "POST" || row.url !== "/v1/responses") {
      throw new SpendAdmissionError("unbounded_request");
    }
    bodies.push(row.body);
  }
  return boundCollection(OPENAI_RESPONSES_URL, model, bodies, jsonl);
}

async function boundCollection(
  url: string,
  model: string,
  bodies: unknown[],
  collection: string,
): Promise<BatchSpendBound> {
  if (bodies.length === 0) throw new SpendAdmissionError("unbounded_request");
  let maxMicrodollars = 0;
  let first: PaidQuote | undefined;
  for (const body of bodies) {
    const quote = await quotePaidRequest(url, { ...JSON_POST, body: JSON.stringify(body) });
    // Settlement prices usage with the batch's model and cache-write rate, so
    // every request must share them.
    if (
      !quote ||
      quote.model !== model ||
      (first && quote.anthropicCacheWriteRate !== first.anthropicCacheWriteRate) ||
      !Number.isSafeInteger(maxMicrodollars + quote.maxMicrodollars)
    ) {
      throw new SpendAdmissionError("unbounded_request");
    }
    first ??= quote;
    maxMicrodollars += quote.maxMicrodollars;
  }
  return {
    catalogVersion: first!.catalogVersion,
    // Hex SHA-256: well inside the authority's 512-character fingerprint limit.
    requestFingerprint: createHash("sha256")
      .update(`${first!.catalogVersion}:batch:${url}:`)
      .update(collection)
      .digest("hex"),
    maxMicrodollars,
    ...(first!.anthropicCacheWriteRate === undefined
      ? {}
      : { anthropicCacheWriteRate: first!.anthropicCacheWriteRate }),
  };
}

export interface BatchSpendDeps {
  rpc: SpendRpc;
  log?: (line: string) => void;
}

/**
 * Reserve, then mark dispatched. Both happen before the caller writes any
 * sidecar, so a refusal leaves nothing to reconcile and a rerun starts clean.
 */
export async function admitBatchSpend(
  bound: BatchSpendBound,
  deps: BatchSpendDeps & { tenantId: string; nowMs: number; opId: string },
): Promise<BatchSpendIdentity> {
  const identity = {
    tenantId: deps.tenantId,
    opId: deps.opId,
    quote: {
      dayKey: utcSpendDay(deps.nowMs),
      catalogVersion: bound.catalogVersion,
      requestFingerprint: bound.requestFingerprint,
      maxMicrodollars: bound.maxMicrodollars,
    },
  };
  const reserved = await call(deps.rpc, { ...identity, kind: "reserve_spend", nowMs: deps.nowMs });
  if (!reserved.ok || reserved.state !== "reserved") {
    throw new SpendAdmissionError(reserved.reason ?? "operation_conflict");
  }
  const marked = await call(deps.rpc, { ...identity, kind: "mark_spend_dispatched" });
  if (!marked.ok || marked.fresh !== true) {
    await call(deps.rpc, { ...identity, kind: "release_spend" });
    throw new SpendAdmissionError(marked.reason ?? "dispatch_uncertain");
  }
  deps.log?.(
    `Spend: ${usd(bound.maxMicrodollars)} maximum admitted against ${deps.tenantId} (${deps.opId})`,
  );
  return bound.anthropicCacheWriteRate === undefined
    ? identity
    : { ...identity, anthropicCacheWriteRate: bound.anthropicCacheWriteRate };
}

/** Settle at zero: only for a batch whose create was never attempted. */
export async function cancelUnsentBatchSpend(
  spend: BatchSpendIdentity,
  deps: BatchSpendDeps,
): Promise<{ settled: true } | { settled: false; reason: string }> {
  const settled = await call(deps.rpc, settleBody(spend, 0));
  if (settled.ok) {
    deps.log?.(`Spend: no batch was created; ${spend.opId} settled at $0`);
    return { settled: true };
  }
  const reason = settled.reason ?? "unavailable";
  deps.log?.(
    `Spend: no batch was created, but ${usd(spend.quote.maxMicrodollars)} maximum stays held (${reason})`,
  );
  return { settled: false, reason };
}

/**
 * Settle from the batch's results: one body per target, each carrying valid
 * usage, or the maximum stays charged. Never throws, so an expired operation
 * record or an unreachable authority cannot fail a run whose results are
 * already in hand.
 */
export async function settleBatchSpend(
  sidecar: {
    provider: "openai" | "anthropic";
    model: string;
    targets: Array<{ customId: string }>;
    spend?: BatchSpendIdentity;
  },
  lines: Array<{ customId: string; body: unknown }>,
  deps: BatchSpendDeps,
): Promise<BatchSpendOutcome> {
  const { spend } = sidecar;
  if (!spend) {
    deps.log?.("Spend: batch was submitted before batch spend accounting; nothing to settle");
    return { state: "unmetered" };
  }
  const max = spend.quote.maxMicrodollars;
  const held = (reason: string): BatchSpendOutcome => {
    deps.log?.(`Spend: maximum ${usd(max)} permanently held for ${spend.opId} (${reason})`);
    return { state: "held", maxMicrodollars: max, reason };
  };
  const actual = actualBatchCost(sidecar, spend, lines);
  if (actual === null) return held("missing_valid_usage");
  if (actual > max) return held("actual_exceeds_max");
  const settled = await call(deps.rpc, settleBody(spend, actual));
  if (!settled.ok) return held(settled.reason ?? "unavailable");
  deps.log?.(`Spend: settled ${usd(actual)} of ${usd(max)} maximum (${spend.opId})`);
  return { state: "settled", actualMicrodollars: actual, maxMicrodollars: max };
}

function actualBatchCost(
  sidecar: { provider: "openai" | "anthropic"; model: string; targets: Array<{ customId: string }> },
  spend: BatchSpendIdentity,
  lines: Array<{ customId: string; body: unknown }>,
): number | null {
  const pricing = {
    catalogVersion: spend.quote.catalogVersion,
    provider: sidecar.provider,
    kind: sidecar.provider === "openai" ? "responses" : "messages",
    model: sidecar.model,
    // Per-request maxima are not persisted; the batch total is checked below
    // and again by the authority.
    maxMicrodollars: spend.quote.maxMicrodollars,
    fingerprint: spend.quote.requestFingerprint,
    ...(spend.anthropicCacheWriteRate === undefined
      ? {}
      : { anthropicCacheWriteRate: spend.anthropicCacheWriteRate }),
  } as PaidQuote;
  const byId = new Map<string, unknown[]>();
  for (const line of lines) byId.set(line.customId, [...(byId.get(line.customId) ?? []), line.body]);
  if (byId.size !== sidecar.targets.length) return null;
  let total = 0;
  for (const { customId } of sidecar.targets) {
    const bodies = byId.get(customId);
    if (bodies?.length !== 1) return null;
    const cost = actualPaidCost(pricing, bodies[0]);
    if (cost === null || !Number.isSafeInteger(total + cost)) return null;
    total += cost;
  }
  return total;
}

function settleBody(spend: BatchSpendIdentity, actualMicrodollars: number): Record<string, unknown> {
  return {
    kind: "settle_spend",
    tenantId: spend.tenantId,
    opId: spend.opId,
    quote: spend.quote,
    actualMicrodollars,
  };
}

async function call(
  rpc: SpendRpc,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<SpendRpc>>> {
  try {
    return await rpc(body);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

function usd(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(4)}`;
}

/** Anthropic results as settlement lines: a message only for a success. */
export function anthropicResultLines(results: BatchResult[]): Array<{ customId: string; body: unknown }> {
  return results.map((row) => {
    const result = (row as { result?: { type?: unknown; message?: unknown } }).result;
    return {
      customId: String(row.custom_id),
      body: result?.type === "succeeded" ? result.message : null,
    };
  });
}

/** OpenAI output and error JSONL as settlement lines: a body only for a 2xx. */
export function openAIResultLines(jsonl: string): Array<{ customId: string; body: unknown }> {
  const lines: Array<{ customId: string; body: unknown }> = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: { custom_id?: unknown; response?: { status_code?: unknown; body?: unknown } | null };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row?.custom_id !== "string") continue;
    const status = row.response?.status_code;
    lines.push({
      customId: row.custom_id,
      body: typeof status === "number" && status >= 200 && status < 300 ? row.response!.body : null,
    });
  }
  return lines;
}
