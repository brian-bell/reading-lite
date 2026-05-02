import { promises as fs } from "node:fs";
import path from "node:path";

export interface ManifestErrorLike {
  code: string;
  message: string;
  stage?: string;
  failed_at?: string;
  retryable?: boolean;
}

export interface AttemptSummaryLike {
  id: string;
  trigger: string;
  status: string;
  stage?: string;
  started_at: string;
  finished_at?: string;
  error?: ManifestErrorLike;
}

export interface ReadingListItemLike {
  id: string;
  url: string;
  status: string;
  title?: string;
  error?: ManifestErrorLike;
  active_attempt?: AttemptSummaryLike;
  last_attempt?: AttemptSummaryLike;
}

export interface ProcessingAttemptLike extends AttemptSummaryLike {
  reading_id: string;
  url: string;
  url_hash: string;
  key_prefix: string;
  events: Array<{
    stage: string;
    status: string;
    at: string;
    duration_ms?: number;
    error?: ManifestErrorLike;
  }>;
}

export interface ReadingDiagnosticsLike {
  id: string;
  key_prefix: string;
  manifest: ReadingListItemLike & Record<string, unknown>;
  attempts: ProcessingAttemptLike[];
}

export interface FailedAttemptRecord {
  version: 1;
  gathered_at: string;
  base_url: string;
  reading: ReadingListItemLike;
  key_prefix: string;
  attempt: ProcessingAttemptLike;
  retry: RetryDecision;
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
  source: "explicit" | "legacy" | "unknown";
}

export function retryDecisionForAttempt(
  attempt: Pick<AttemptSummaryLike, "error" | "stage">,
  fallbackError?: ManifestErrorLike,
): RetryDecision {
  const err = attempt.error ?? fallbackError;
  if (!err) return { retry: false, reason: "missing error", source: "unknown" };
  if (typeof err.retryable === "boolean") {
    return {
      retry: err.retryable,
      reason: `retryable=${err.retryable}`,
      source: "explicit",
    };
  }
  return legacyRetryDecision(err);
}

export function retryDecisionForRecord(record: FailedAttemptRecord): RetryDecision {
  return retryDecisionForAttempt(record.attempt, record.reading.error);
}

function legacyRetryDecision(err: ManifestErrorLike): RetryDecision {
  if (err.code === "FetchTimeoutError") {
    return { retry: true, reason: "timeout", source: "legacy" };
  }
  if (err.code === "AnthropicError") {
    return { retry: true, reason: "anthropic", source: "legacy" };
  }
  if (err.code === "OpenAIError") {
    return { retry: true, reason: "openai", source: "legacy" };
  }
  if (err.code === "stale_pending") {
    return { retry: true, reason: "stale pending", source: "legacy" };
  }
  if (err.code === "stale_active_attempt") {
    return { retry: true, reason: "stale active attempt", source: "legacy" };
  }

  if (err.code === "BadStatusError") {
    const status = statusFromBadStatusMessage(err.message);
    if (status !== null) {
      return { retry: status >= 500, reason: `http ${status}`, source: "legacy" };
    }
    return {
      retry: false,
      reason: "bad status without parseable status",
      source: "legacy",
    };
  }

  if (err.code === "BlockedHostError") {
    return { retry: false, reason: "blocked host", source: "legacy" };
  }
  if (err.code === "OversizedResponseError") {
    return { retry: false, reason: "oversized response", source: "legacy" };
  }

  return { retry: false, reason: `unknown code ${err.code}`, source: "unknown" };
}

function statusFromBadStatusMessage(message: string): number | null {
  const match = message.match(/(?:status\s+|returned\s+)(\d{3})\b/i);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

export function failedAttemptRecordsFromDiagnostics(
  baseUrl: string,
  gatheredAt: string,
  diagnostics: ReadingDiagnosticsLike,
): FailedAttemptRecord[] {
  return diagnostics.attempts
    .filter((attempt) => attempt.status === "failed")
    .map((attempt) => ({
      version: 1 as const,
      gathered_at: gatheredAt,
      base_url: baseUrl,
      reading: {
        id: diagnostics.manifest.id,
        url: diagnostics.manifest.url,
        status: diagnostics.manifest.status,
        title: diagnostics.manifest.title,
        error: diagnostics.manifest.error,
        active_attempt: diagnostics.manifest.active_attempt,
        last_attempt: diagnostics.manifest.last_attempt,
      },
      key_prefix: diagnostics.key_prefix,
      attempt,
      retry: retryDecisionForAttempt(attempt, diagnostics.manifest.error),
    }));
}

export function recordFileName(record: FailedAttemptRecord): string {
  return `${safeFileToken(record.reading.id)}--${safeFileToken(record.attempt.id)}.json`;
}

export function runStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function readRecordInput(inputPath: string): Promise<FailedAttemptRecord[]> {
  const stat = await fs.stat(inputPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(inputPath);
    const records: FailedAttemptRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json") || entry === "index.json") continue;
      const fullPath = path.join(inputPath, entry);
      const childStat = await fs.stat(fullPath);
      if (!childStat.isFile()) continue;
      records.push(await readRecordFile(fullPath));
    }
    return newestRecordPerReading(records);
  }
  return [await readRecordFile(inputPath)];
}

export async function readRecordFile(filePath: string): Promise<FailedAttemptRecord> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isFailedAttemptRecord(parsed)) {
    throw new Error(`invalid failed-attempt record: ${filePath}`);
  }
  return parsed;
}

export function newestRecordPerReading(records: FailedAttemptRecord[]): FailedAttemptRecord[] {
  const sorted = [...records].sort((a, b) =>
    a.attempt.started_at < b.attempt.started_at
      ? 1
      : a.attempt.started_at > b.attempt.started_at
        ? -1
        : a.attempt.id.localeCompare(b.attempt.id),
  );
  const seen = new Set<string>();
  const out: FailedAttemptRecord[] = [];
  for (const record of sorted) {
    if (seen.has(record.reading.id)) continue;
    seen.add(record.reading.id);
    out.push(record);
  }
  return out;
}

function isFailedAttemptRecord(value: unknown): value is FailedAttemptRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.version === 1 &&
    typeof r.gathered_at === "string" &&
    typeof r.base_url === "string" &&
    isObject(r.reading) &&
    typeof r.reading.id === "string" &&
    typeof r.reading.url === "string" &&
    isObject(r.attempt) &&
    typeof r.attempt.id === "string" &&
    typeof r.attempt.status === "string" &&
    typeof r.attempt.started_at === "string" &&
    isObject(r.retry) &&
    typeof r.retry.retry === "boolean" &&
    typeof r.retry.reason === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
