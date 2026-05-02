import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failedAttemptRecordsFromDiagnostics,
  newestRecordPerReading,
  readRecordInput,
  recordFileName,
  retryDecisionForAttempt,
  retryDecisionForRecord,
  type FailedAttemptRecord,
  type ReadingDiagnosticsLike,
} from "../../../scripts/reprocess-failed-lib/records";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reading-lite-reprocess-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function record(overrides: Partial<FailedAttemptRecord> = {}): FailedAttemptRecord {
  const base: FailedAttemptRecord = {
    version: 1,
    gathered_at: "2026-05-02T18:00:00.000Z",
    base_url: "http://127.0.0.1:8787",
    reading: {
      id: "rd_ONE",
      url: "https://example.com/one",
      status: "failed",
      error: { code: "BadStatusError", message: "bad response status 500: https://example.com/one" },
    },
    key_prefix: "readings/2026/05/02T180000Z-rd_ONE",
    attempt: {
      id: "at_ONE",
      trigger: "submit",
      status: "failed",
      stage: "fetch_source",
      started_at: "2026-05-02T18:00:00.000Z",
      finished_at: "2026-05-02T18:00:01.000Z",
      reading_id: "rd_ONE",
      url: "https://example.com/one",
      url_hash: "a".repeat(64),
      key_prefix: "readings/2026/05/02T180000Z-rd_ONE",
      error: { code: "BadStatusError", message: "bad response status 500: https://example.com/one" },
      events: [],
    },
    retry: { retry: true, reason: "http 500", source: "legacy" },
  };
  return { ...base, ...overrides };
}

describe("retryDecisionForAttempt", () => {
  it("trusts explicit retryable=false", () => {
    expect(
      retryDecisionForAttempt({
        error: { code: "AnthropicError", message: "bad request", retryable: false },
      }),
    ).toEqual({ retry: false, reason: "retryable=false", source: "explicit" });
  });

  it("does not retry legacy 404 source failures", () => {
    expect(
      retryDecisionForAttempt({
        error: {
          code: "BadStatusError",
          message: "bad response status 404: https://example.com/missing",
        },
      }),
    ).toEqual({ retry: false, reason: "http 404", source: "legacy" });
  });

  it("retries legacy 5xx source failures and stale attempts", () => {
    expect(
      retryDecisionForAttempt({
        error: {
          code: "BadStatusError",
          message: "bad response status 503: https://example.com/down",
        },
      }).retry,
    ).toBe(true);
    expect(
      retryDecisionForAttempt({
        error: { code: "stale_active_attempt", message: "active attempt > 300s" },
      }).retry,
    ).toBe(true);
  });

  it("defaults unknown failures to non-retryable", () => {
    expect(
      retryDecisionForAttempt({
        error: { code: "SomethingElse", message: "unexpected" },
      }),
    ).toEqual({ retry: false, reason: "unknown code SomethingElse", source: "unknown" });
  });
});

describe("record helpers", () => {
  it("synthesizes legacy failed manifests when persisted attempts are absent", () => {
    const diagnostics: ReadingDiagnosticsLike = {
      id: "rd_LEGACY",
      key_prefix: "readings/2026/05/02T180000Z-rd_LEGACY",
      manifest: {
        id: "rd_LEGACY",
        url: "https://example.com/missing",
        url_hash: "b".repeat(64),
        status: "failed",
        updated_at: "2026-05-02T18:00:02.000Z",
        error: {
          code: "BadStatusError",
          message: "bad response status 404: https://example.com/missing",
          stage: "fetch_source",
        },
      },
      attempts: [],
    };

    const records = failedAttemptRecordsFromDiagnostics(
      "http://127.0.0.1:8787",
      "2026-05-02T18:10:00.000Z",
      diagnostics,
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.attempt).toMatchObject({
      id: "legacy_rd_LEGACY",
      status: "failed",
      stage: "fetch_source",
      url_hash: "b".repeat(64),
    });
    expect(records[0]?.retry).toEqual({ retry: false, reason: "http 404", source: "legacy" });
  });

  it("does not add a legacy duplicate when a failed attempt exists", () => {
    const existing = record();
    const diagnostics: ReadingDiagnosticsLike = {
      id: existing.reading.id,
      key_prefix: existing.key_prefix,
      manifest: {
        ...existing.reading,
        url_hash: existing.attempt.url_hash,
        updated_at: "2026-05-02T18:00:02.000Z",
      },
      attempts: [existing.attempt],
    };

    const records = failedAttemptRecordsFromDiagnostics(
      "http://127.0.0.1:8787",
      "2026-05-02T18:10:00.000Z",
      diagnostics,
    );

    expect(records.map((r) => r.attempt.id)).toEqual(["at_ONE"]);
  });

  it("recomputes retryability from the record attempt", () => {
    const r = record({
      attempt: {
        ...record().attempt,
        error: { code: "BadStatusError", message: "bad response status 404: https://example.com/nope" },
      },
    });
    expect(retryDecisionForRecord(r).retry).toBe(false);
  });

  it("dedupes to the newest record per reading", () => {
    const oldRecord = record({
      attempt: { ...record().attempt, id: "at_old", started_at: "2026-05-02T18:00:00.000Z" },
    });
    const newRecord = record({
      attempt: { ...record().attempt, id: "at_new", started_at: "2026-05-02T18:05:00.000Z" },
    });
    expect(newestRecordPerReading([oldRecord, newRecord]).map((r) => r.attempt.id)).toEqual(["at_new"]);
  });

  it("loads all JSON records in a directory while ignoring index.json", async () => {
    const a = record();
    const b = record({
      reading: { ...record().reading, id: "rd_TWO", url: "https://example.com/two" },
      attempt: {
        ...record().attempt,
        id: "at_TWO",
        reading_id: "rd_TWO",
        url: "https://example.com/two",
        started_at: "2026-05-02T18:05:00.000Z",
      },
    });
    await fs.writeFile(path.join(tmpDir, recordFileName(a)), JSON.stringify(a), "utf8");
    await fs.writeFile(path.join(tmpDir, recordFileName(b)), JSON.stringify(b), "utf8");
    await fs.writeFile(path.join(tmpDir, "index.json"), JSON.stringify({ ignored: true }), "utf8");

    const records = await readRecordInput(tmpDir);
    expect(records.map((r) => r.reading.id).sort()).toEqual(["rd_ONE", "rd_TWO"]);
  });
});
