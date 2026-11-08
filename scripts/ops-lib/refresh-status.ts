import { z } from "zod";
import { REFRESH_CURSOR_KEY } from "../../src/modules/stores/layout";
import {
  RefreshCursorSchema,
  refreshCursorPhase,
  type RefreshPhase,
} from "../../src/refresh-cursor";
import { operatorKeyRoot, type OperatorTenant } from "../corpus-lib/tenant";

export type RefreshObservation<T> =
  | { status: "ok"; value: T }
  | { status: "missing"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export interface CursorObjectMeta {
  status: "ok";
  etag: string;
  last_modified: string | null;
}

export interface CursorView {
  version: 1;
  run_at: string;
  budget_at: string;
  rollover: { budget_at: string; limit: number; tension_limit: number | null } | null;
  token_present: true;
  phase: RefreshPhase;
  fields: { tensions_555: boolean; repairs_556: boolean };
  scan: { targets: number; offset: number; remaining: number };
  repairs: { candidates: number; offset: number; pending: number; remaining: number };
  judges: {
    candidates: number;
    offset: number;
    limit: number;
    dispatched: number;
    pending: number;
    remaining: number;
  };
  tensions: {
    candidates: number;
    offset: number;
    limit: number | null;
    dispatched: number;
    pending: number;
    remaining_unsent: number;
  };
  object: CursorObjectMeta | { status: "unavailable"; reason: string };
}

export interface CheckpointCounts {
  total: number;
  with_result: number;
  no_result: number;
  recent_retry: number;
}

export interface RunCount {
  run_at: string;
  n: number;
  with_result: number;
}

export interface ConnectionCheckpoint {
  counts: CheckpointCounts;
  by_run_at: RunCount[];
  uncertain: Array<{ reading_id: string; run_at: string; retry_at: string | null }>;
}

export interface TensionCheckpoint {
  counts: CheckpointCounts;
  by_run_at: RunCount[];
  verdicts: Array<{ verdict: string; n: number }>;
  uncertain: Array<{ reading_a: string; reading_b: string; run_at: string; retry_at: string | null }>;
}

export interface CorpusHealth {
  tension_rows: number;
  readings_with_tensions: number;
  dangling: number;
  one_sided: number;
  dangling_judged_records: number;
  dangling_sample: Array<{ source_id: string; target_id: string }>;
}

export interface RefreshStatusReport {
  tenant_id: string;
  bucket: string;
  local: boolean;
  cursor: RefreshObservation<CursorView> & { key: string };
  checkpoints: {
    connection: RefreshObservation<ConnectionCheckpoint>;
    tension: RefreshObservation<TensionCheckpoint>;
  };
  corpus: RefreshObservation<CorpusHealth>;
}

const CountsSchema = z.object({
  total: z.number().int().nonnegative(),
  with_result: z.number().int().nonnegative(),
  no_result: z.number().int().nonnegative(),
  recent_retry: z.number().int().nonnegative(),
}).strict();

const RunCountSchema = z.object({
  run_at: z.string().min(1),
  n: z.number().int().nonnegative(),
  with_result: z.number().int().nonnegative(),
}).strict();

const SECRET_NAME = /SECRET|ACCESS_KEY|API_TOKEN|PASSWORD|DATABASE_URL/i;

export function refreshCursorKey(tenant: OperatorTenant, local: boolean): string {
  return `${operatorKeyRoot(tenant, local)}${REFRESH_CURSOR_KEY}`;
}

export function redactOperatorText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/\b(secret|password|access[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redacted.length > 240 ? `${redacted.slice(0, 240)}...` : redacted;
}

export function secretValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    values.push(value);
  }
  return values;
}

export function cursorObservation(
  key: string,
  body: string | null,
  object: CursorView["object"] | null,
): RefreshStatusReport["cursor"] {
  if (body == null) return { key, status: "missing", reason: "object not found" };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { key, status: "invalid", reason: "cursor is not JSON" };
  }
  const parsed = RefreshCursorSchema.safeParse(raw);
  if (!parsed.success) {
    return { key, status: "invalid", reason: "cursor does not match the refresh cursor schema" };
  }
  const cursor = parsed.data;
  const fields = {
    tensions_555: isRecord(raw) && Object.hasOwn(raw, "tension_candidates"),
    repairs_556: isRecord(raw) && Object.hasOwn(raw, "repair_candidates"),
  };
  const meta = object ?? { status: "unavailable" as const, reason: "object metadata was not listed" };
  return {
    key,
    status: "ok",
    value: {
      version: 1,
      run_at: cursor.run_at,
      budget_at: cursor.budget_at,
      rollover: cursor.rollover
        ? {
          budget_at: cursor.rollover.budget_at,
          limit: cursor.rollover.limit,
          tension_limit: cursor.rollover.tension_limit ?? null,
        }
        : null,
      token_present: true,
      phase: refreshCursorPhase(cursor),
      fields,
      scan: {
        targets: cursor.targets.length,
        offset: cursor.scan_offset,
        remaining: cursor.targets.length - cursor.scan_offset,
      },
      repairs: {
        candidates: cursor.repair_candidates.length,
        offset: cursor.repair_offset,
        pending: cursor.repair_pending.length,
        remaining: cursor.repair_candidates.length - cursor.repair_offset,
      },
      judges: {
        candidates: cursor.candidates.length,
        offset: cursor.judge_offset,
        limit: cursor.limit,
        dispatched: cursor.dispatched,
        pending: cursor.pending.length,
        remaining: cursor.candidates.length - cursor.judge_offset,
      },
      tensions: {
        candidates: cursor.tension_candidates.length,
        offset: cursor.tension_offset,
        limit: cursor.tension_limit ?? null,
        dispatched: cursor.tension_dispatched,
        pending: cursor.tension_pending.length,
        remaining_unsent: cursor.tension_candidates.length - cursor.tension_offset,
      },
      object: meta,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCounts(row: unknown): CheckpointCounts {
  return CountsSchema.parse(row);
}

export function parseRunCounts(rows: unknown): RunCount[] {
  return z.array(RunCountSchema).parse(rows);
}

export function parseConnectionUncertain(rows: unknown): ConnectionCheckpoint["uncertain"] {
  return z.array(z.object({
    reading_id: z.string().min(1),
    run_at: z.string().min(1),
    retry_at: z.string().min(1).nullable(),
  }).strict()).parse(rows);
}

export function parseVerdicts(rows: unknown): TensionCheckpoint["verdicts"] {
  return z.array(z.object({
    verdict: z.string().min(1),
    n: z.number().int().nonnegative(),
  }).strict()).parse(rows);
}

export function parseTensionUncertain(rows: unknown): TensionCheckpoint["uncertain"] {
  return z.array(z.object({
    reading_a: z.string().min(1),
    reading_b: z.string().min(1),
    run_at: z.string().min(1),
    retry_at: z.string().min(1).nullable(),
  }).strict()).parse(rows);
}

export function parseCorpusRow(row: unknown): Omit<CorpusHealth, "dangling_judged_records" | "dangling_sample"> {
  return z.object({
    tension_rows: z.number().int().nonnegative(),
    readings_with_tensions: z.number().int().nonnegative(),
    dangling: z.number().int().nonnegative(),
    one_sided: z.number().int().nonnegative(),
  }).strict().parse(row);
}

export function parseJudgedCount(row: unknown): number {
  return z.object({ n: z.number().int().nonnegative() }).strict().parse(row).n;
}

export function parseDanglingSample(rows: unknown): CorpusHealth["dangling_sample"] {
  return z.array(z.object({
    source_id: z.string().min(1),
    target_id: z.string().min(1),
  }).strict()).parse(rows);
}

export function parseTablePresent(row: unknown): boolean {
  return z.object({ present: z.boolean() }).strict().parse(row).present;
}

function readFailed(status: string): boolean {
  return status === "unavailable" || status === "failed";
}

export function refreshStatusExit(report: RefreshStatusReport): number {
  const cursorMetadataFailed = report.cursor.status === "ok" && readFailed(report.cursor.value.object.status);
  const sectionFailed = [report.cursor, report.checkpoints.connection, report.checkpoints.tension, report.corpus]
    .some((section) => readFailed(section.status));
  return cursorMetadataFailed || sectionFailed ? 1 : 0;
}

export function formatRefreshStatus(report: RefreshStatusReport): string {
  const lines = [
    `tenant ${report.tenant_id}`,
    `bucket ${report.bucket}`,
    `local ${report.local}`,
    formatCursor(report.cursor),
    formatSection("checkpoints.connection", report.checkpoints.connection, (value) =>
      `total=${value.counts.total} with_result=${value.counts.with_result} no_result=${value.counts.no_result} recent_retry=${value.counts.recent_retry}`),
  ];
  if (report.checkpoints.connection.status === "ok") {
    for (const run of report.checkpoints.connection.value.by_run_at) {
      lines.push(`checkpoints.connection run_at=${run.run_at} n=${run.n} with_result=${run.with_result}`);
    }
    for (const row of report.checkpoints.connection.value.uncertain) {
      lines.push(`checkpoints.connection uncertain reading_id=${row.reading_id} run_at=${row.run_at} retry_at=${row.retry_at ?? "null"}`);
    }
  }
  lines.push(formatSection("checkpoints.tension", report.checkpoints.tension, (value) => {
    const mix = value.verdicts.map((item) => `${item.verdict}=${item.n}`).join(",") || "none";
    return `total=${value.counts.total} with_result=${value.counts.with_result} no_result=${value.counts.no_result} recent_retry=${value.counts.recent_retry} verdicts=${mix}`;
  }));
  if (report.checkpoints.tension.status === "ok") {
    for (const run of report.checkpoints.tension.value.by_run_at) {
      lines.push(`checkpoints.tension run_at=${run.run_at} n=${run.n} with_result=${run.with_result}`);
    }
    for (const row of report.checkpoints.tension.value.uncertain) {
      lines.push(`checkpoints.tension uncertain reading_a=${row.reading_a} reading_b=${row.reading_b} run_at=${row.run_at} retry_at=${row.retry_at ?? "null"}`);
    }
  }
  lines.push(formatSection("corpus", report.corpus, (value) =>
    `tension_rows=${value.tension_rows} readings_with_tensions=${value.readings_with_tensions} dangling=${value.dangling} one_sided=${value.one_sided} dangling_judged_records=${value.dangling_judged_records}`));
  if (report.corpus.status === "ok") {
    for (const row of report.corpus.value.dangling_sample) {
      lines.push(`corpus dangling source_id=${row.source_id} target_id=${row.target_id}`);
    }
  }
  return lines.join("\n");
}

function formatCursor(section: RefreshStatusReport["cursor"]): string {
  if (section.status !== "ok") return `cursor ${section.status} key=${section.key} reason=${section.reason}`;
  const value = section.value;
  const modified = value.object.status === "ok" ? (value.object.last_modified ?? "null") : "unavailable";
  const etag = value.object.status === "ok" ? value.object.etag : "unavailable";
  return [
    "cursor ok",
    `key=${section.key}`,
    `phase=${value.phase}`,
    `run_at=${value.run_at}`,
    `budget_at=${value.budget_at}`,
    `scan=${value.scan.offset}/${value.scan.targets}`,
    `repairs=${value.repairs.offset}/${value.repairs.candidates}`,
    `repair_pending=${value.repairs.pending}`,
    `judges=${value.judges.offset}/${value.judges.candidates}`,
    `dispatched=${value.judges.dispatched}/${value.judges.limit}`,
    `judge_pending=${value.judges.pending}`,
    `tensions=${value.tensions.offset}/${value.tensions.candidates}`,
    `tension_dispatched=${value.tensions.dispatched}/${value.tensions.limit ?? "null"}`,
    `tension_pending=${value.tensions.pending}`,
    `tensions_555=${value.fields.tensions_555}`,
    `repairs_556=${value.fields.repairs_556}`,
    `etag=${etag}`,
    `last_modified=${modified}`,
  ].join(" ");
}

function formatSection<T>(
  label: string,
  section: RefreshObservation<T>,
  summarize: (value: T) => string,
): string {
  if (section.status !== "ok") return `${label} ${section.status} reason=${section.reason}`;
  return `${label} ok ${summarize(section.value)}`;
}
