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
  url_hash?: string;
  created_at?: string;
  updated_at?: string;
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
  const failedAttempts = diagnostics.attempts.filter((attempt) => attempt.status === "failed");
  if (failedAttempts.length === 0 && hasLegacyFailedAttempt(diagnostics.manifest)) {
    failedAttempts.push(legacyFailedAttemptFromManifest(diagnostics, gatheredAt));
  }

  return failedAttempts.map((attempt) =>
    failedAttemptRecordFromAttempt(baseUrl, gatheredAt, diagnostics, attempt),
  );
}

function failedAttemptRecordFromAttempt(
  baseUrl: string,
  gatheredAt: string,
  diagnostics: ReadingDiagnosticsLike,
  attempt: ProcessingAttemptLike,
): FailedAttemptRecord {
  return {
    version: 1,
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
  };
}

function hasLegacyFailedAttempt(manifest: ReadingDiagnosticsLike["manifest"]): boolean {
  return manifest.status === "failed" || manifest.last_attempt?.status === "failed";
}

function legacyFailedAttemptFromManifest(
  diagnostics: ReadingDiagnosticsLike,
  gatheredAt: string,
): ProcessingAttemptLike {
  const manifest = diagnostics.manifest;
  const lastFailed = manifest.last_attempt?.status === "failed" ? manifest.last_attempt : undefined;
  const errorAt = lastFailed?.error?.failed_at ?? manifest.error?.failed_at;
  const finishedAt =
    lastFailed?.finished_at ??
    errorAt ??
    manifest.updated_at ??
    manifest.created_at ??
    gatheredAt;
  const startedAt = lastFailed?.started_at ?? finishedAt;
  const error =
    lastFailed?.error ??
    manifest.error ?? {
      code: "legacy_failed",
      message: "failed manifest has no persisted attempt or manifest error",
      failed_at: finishedAt,
    };
  const normalizedError = error.failed_at ? error : { ...error, failed_at: finishedAt };

  return {
    id: lastFailed?.id ?? `legacy_${safeFileToken(diagnostics.id)}`,
    trigger: lastFailed?.trigger ?? "submit",
    status: "failed",
    stage: lastFailed?.stage ?? normalizedError.stage,
    started_at: startedAt,
    finished_at: finishedAt,
    error: normalizedError,
    reading_id: diagnostics.id,
    url: manifest.url,
    url_hash: manifest.url_hash ?? "0".repeat(64),
    key_prefix: diagnostics.key_prefix,
    events: [],
  };
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

export function selectSingleRecord(
  records: FailedAttemptRecord[],
  readingId?: string,
): FailedAttemptRecord {
  const candidates = readingId
    ? records.filter((record) => record.reading.id === readingId)
    : records;
  const newest = newestRecordPerReading(candidates);

  if (newest.length === 1) return newest[0]!;
  if (newest.length === 0) {
    const suffix = readingId ? ` for reading ${readingId}` : "";
    throw new Error(`no failed-attempt records found${suffix}`);
  }

  const ids = newest.map((record) => record.reading.id).sort();
  throw new Error(
    `input contains ${ids.length} failed readings; pass --reading <id>. Candidates: ${ids.join(", ")}`,
  );
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
