import { describe, expect, it } from "vitest";
import {
  failedManifest,
  importPending,
  queueSendRollback,
  readyManifest,
  reprocessPending,
  rollForward,
  submitPending,
  type ReadingIdentity,
} from "../../../src/modules/manifest-drafting";
import type { ReadingSummary } from "../../../src/schemas/reading-summary";
import type { Manifest } from "../../../src/schemas/manifest";

const NOW = "2026-08-22T11:00:00.000Z";

const READY_PRIOR: Manifest = {
  id: "rd_test1",
  url: "https://example.com/article",
  url_hash: "a".repeat(64),
  source_type: "url",
  status: "ready",
  title: "Ready title",
  tldr: "A summary.",
  tags: ["tag-a"],
  last_attempt: {
    id: "at_prev",
    trigger: "submit",
    status: "succeeded",
    started_at: "2026-08-20T09:00:00.000Z",
    finished_at: "2026-08-20T09:01:00.000Z",
  },
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 900,
  content_sha256: "e".repeat(64),
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-20T09:01:00.000Z",
};

const IDENTITY: ReadingIdentity = {
  id: "rd_test1",
  url: "https://example.com/article",
  urlHash: "a".repeat(64),
  createdAt: "2026-08-22T10:00:00.000Z",
};

const ATTEMPT_REF = { attemptId: "at_test1", startedAt: "2026-08-22T10:00:00.500Z" };

describe("submitPending", () => {
  it("drafts the url-sourced pending manifest with the empty-content placeholder and a running submit attempt", () => {
    const { manifest, attempt } = submitPending(IDENTITY, ATTEMPT_REF);

    expect(manifest).toEqual({
      id: "rd_test1",
      url: "https://example.com/article",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_test1",
        trigger: "submit",
        status: "running",
        stage: "queued",
        started_at: "2026-08-22T10:00:00.500Z",
      },
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-08-22T10:00:00.000Z",
      updated_at: "2026-08-22T10:00:00.000Z",
    });
    expect(attempt).toEqual(manifest.active_attempt);
  });
});

describe("importPending", () => {
  it("drafts a markdown-sourced pending with the supplied content facts, title, and a running import attempt", () => {
    const { manifest, attempt } = importPending(IDENTITY, ATTEMPT_REF, {
      bytes: 1234,
      sha256: "b".repeat(64),
      title: "Imported title",
    });

    expect(manifest).toEqual({
      id: "rd_test1",
      url: "https://example.com/article",
      url_hash: "a".repeat(64),
      source_type: "markdown",
      status: "pending",
      active_attempt: {
        id: "at_test1",
        trigger: "import",
        status: "running",
        stage: "queued",
        started_at: "2026-08-22T10:00:00.500Z",
      },
      title: "Imported title",
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: 1234,
      content_sha256: "b".repeat(64),
      created_at: "2026-08-22T10:00:00.000Z",
      updated_at: "2026-08-22T10:00:00.000Z",
    });
    expect(attempt).toEqual(manifest.active_attempt);
  });

  it("omits title when the markdown facts carry none", () => {
    const { manifest } = importPending(IDENTITY, ATTEMPT_REF, {
      bytes: 10,
      sha256: "b".repeat(64),
    });
    expect(manifest.title).toBeUndefined();
    expect("title" in manifest).toBe(false);
  });

  it("re-importing over a failed owner carries its fields forward, strips error and active_attempt, and moves updated_at to the attempt start", () => {
    const failedOwner = {
      id: IDENTITY.id,
      url: IDENTITY.url,
      url_hash: IDENTITY.urlHash,
      source_type: "url" as const,
      status: "failed" as const,
      error: { code: "FetchTimeoutError", message: "timed out" },
      last_attempt: {
        id: "at_old",
        trigger: "submit" as const,
        status: "failed" as const,
        started_at: "2026-08-20T09:00:00.000Z",
      },
      title: "Prior title",
      content_type: "text/html",
      content_status: "failed" as const,
      content_bytes: 500,
      content_sha256: "c".repeat(64),
      created_at: "2026-08-20T09:00:00.000Z",
      updated_at: "2026-08-20T09:05:00.000Z",
    };

    const { manifest } = importPending(
      IDENTITY,
      ATTEMPT_REF,
      { bytes: 42, sha256: "d".repeat(64) },
      { over: failedOwner },
    );

    expect("error" in manifest).toBe(false);
    expect(manifest.status).toBe("pending");
    expect(manifest.source_type).toBe("markdown");
    expect(manifest.active_attempt?.trigger).toBe("import");
    expect(manifest.last_attempt).toEqual(failedOwner.last_attempt);
    expect(manifest.title).toBe("Prior title"); // markdown carried no title — fallback
    expect(manifest.content_type).toBe("text/markdown; charset=utf-8");
    expect(manifest.content_bytes).toBe(42);
    expect(manifest.content_sha256).toBe("d".repeat(64));
    expect(manifest.created_at).toBe("2026-08-20T09:00:00.000Z");
    expect(manifest.updated_at).toBe(ATTEMPT_REF.startedAt);
  });

  it("a supplied markdown title wins over the failed owner's title", () => {
    const failedOwner = {
      id: IDENTITY.id,
      url: IDENTITY.url,
      url_hash: IDENTITY.urlHash,
      status: "failed" as const,
      title: "Prior title",
      content_type: "text/html",
      content_status: "failed" as const,
      content_bytes: 1,
      content_sha256: "c".repeat(64),
      created_at: "2026-08-20T09:00:00.000Z",
      updated_at: "2026-08-20T09:05:00.000Z",
    };
    const { manifest } = importPending(
      IDENTITY,
      ATTEMPT_REF,
      { bytes: 1, sha256: "d".repeat(64), title: "Fresh title" },
      { over: failedOwner },
    );
    expect(manifest.title).toBe("Fresh title");
  });

  it("throws when the failed owner's id disagrees with the identity", () => {
    const failedOwner = {
      id: "rd_other",
      url: IDENTITY.url,
      url_hash: IDENTITY.urlHash,
      status: "failed" as const,
      content_type: "text/html",
      content_status: "failed" as const,
      content_bytes: 1,
      content_sha256: "c".repeat(64),
      created_at: "2026-08-20T09:00:00.000Z",
      updated_at: "2026-08-20T09:05:00.000Z",
    };
    expect(() =>
      importPending(IDENTITY, ATTEMPT_REF, { bytes: 1, sha256: "d".repeat(64) }, { over: failedOwner }),
    ).toThrow(/over/);
  });
});

describe("reprocessPending", () => {
  it("a ready prior keeps its full summary visible under the running attempt", () => {
    const { manifest, attempt } = reprocessPending(READY_PRIOR, ATTEMPT_REF, NOW);

    expect(manifest).toEqual({
      ...READY_PRIOR,
      active_attempt: {
        id: "at_test1",
        trigger: "reprocess",
        status: "running",
        stage: "queued",
        started_at: ATTEMPT_REF.startedAt,
      },
      updated_at: NOW,
    });
    expect(manifest.status).toBe("ready");
    expect(attempt).toEqual(manifest.active_attempt);
  });

  it("a non-ready prior resets to a skeleton pending keeping identity, source_type, title, and last_attempt", () => {
    const failedPrior: Manifest = {
      ...READY_PRIOR,
      status: "failed",
      error: { code: "BadStatusError", message: "502" },
    };
    const { manifest } = reprocessPending(failedPrior, ATTEMPT_REF, NOW);

    expect(manifest).toEqual({
      id: "rd_test1",
      url: "https://example.com/article",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "pending",
      active_attempt: {
        id: "at_test1",
        trigger: "reprocess",
        status: "running",
        stage: "queued",
        started_at: ATTEMPT_REF.startedAt,
      },
      last_attempt: READY_PRIOR.last_attempt,
      title: "Ready title",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-08-20T09:00:00.000Z",
      updated_at: NOW,
    });
  });
});

describe("queueSendRollback", () => {
  const activeAttempt = {
    id: "at_test1",
    trigger: "submit" as const,
    status: "running" as const,
    stage: "queued" as const,
    started_at: ATTEMPT_REF.startedAt,
  };
  const expectedFailedAttempt = {
    ...activeAttempt,
    status: "failed" as const,
    finished_at: NOW,
    error: {
      code: "QueueSendError",
      message: "boom",
      stage: "queued" as const,
      failed_at: NOW,
      retryable: true,
    },
  };

  it("a ready target stays ready with the failed attempt stamped as last_attempt", () => {
    const rolled = queueSendRollback(READY_PRIOR, activeAttempt, new Error("boom"), NOW);

    expect(rolled.status).toBe("ready");
    expect(rolled.active_attempt).toBeUndefined();
    expect(rolled.last_attempt).toEqual(expectedFailedAttempt);
    expect(rolled.error).toBeUndefined();
    expect(rolled.tldr).toBe(READY_PRIOR.tldr);
    expect(rolled.updated_at).toBe(NOW);
  });

  it("a pending target flips to failed with a retryable QueueSendError and content_status failed", () => {
    const { manifest: pending } = submitPending(IDENTITY, ATTEMPT_REF);
    const rolled = queueSendRollback(pending, activeAttempt, new Error("boom"), NOW);

    expect(rolled.status).toBe("failed");
    expect(rolled.active_attempt).toBeUndefined();
    expect(rolled.error).toEqual(expectedFailedAttempt.error);
    expect(rolled.last_attempt).toEqual(expectedFailedAttempt);
    expect(rolled.content_status).toBe("failed");
    expect(rolled.updated_at).toBe(NOW);
  });

  it("an Error cause with an empty message falls back to the fixed message instead of failing activation rollback", () => {
    const { manifest: pending } = submitPending(IDENTITY, ATTEMPT_REF);
    const rolled = queueSendRollback(pending, activeAttempt, new Error(), NOW);
    expect(rolled.status).toBe("failed");
    expect(rolled.error?.message).toBe("queue send failed");
  });

  it("a non-pending failed target keeps its content_status and a non-Error cause gets the fixed message", () => {
    const failedTarget: Manifest = {
      ...READY_PRIOR,
      status: "failed",
      content_status: "raw_only",
    };
    const rolled = queueSendRollback(failedTarget, activeAttempt, "string cause", NOW);

    expect(rolled.status).toBe("failed");
    expect(rolled.content_status).toBe("raw_only");
    expect(rolled.error?.message).toBe("queue send failed");
  });
});

const SUMMARY: ReadingSummary = {
  title: "A Study of Things",
  tldr: "Things were studied.",
  tags: ["Developer Tools", "developer-tools", "AI ML"],
  keywords: ["things", "studies", "results"],
  people: ["Ada Lovelace"],
  orgs: ["ACME"],
  novelty_verdict: "novel",
  connections: [{ id: "rd_other", reason: "same topic" }],
  summary_markdown: "## Things\nStudied.",
};

const USAGE = {
  summarization: {
    provider: "openai" as const,
    model: "gpt-5.6-terra",
    input_tokens: 100,
    output_tokens: 50,
    reasoning_tokens: 10,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  },
  openai_embedding_tokens: 77,
};

describe("readyManifest", () => {
  it("builds the full ready manifest, normalizing tags and stripping a full ProcessingAttempt to its summary", () => {
    const fullAttempt = {
      id: "at_test1",
      trigger: "submit" as const,
      status: "succeeded" as const,
      stage: "write_indexes" as const,
      started_at: ATTEMPT_REF.startedAt,
      finished_at: NOW,
      // ProcessingAttempt extras the summary must not carry:
      reading_id: IDENTITY.id,
      url: IDENTITY.url,
      url_hash: IDENTITY.urlHash,
      key_prefix: "readings/2026/08/22T100000Z-rd_test1",
      events: [],
    };

    const manifest = readyManifest(
      {
        identity: IDENTITY,
        sourceType: "url",
        summary: SUMMARY,
        similarity: { count: 2, max: 0.7, mean: 0.6, computed_at: NOW },
        content: {
          content_type: "text/html",
          content_status: "captured",
          content_bytes: 900,
          content_sha256: "e".repeat(64),
          extracted_bytes: 400,
        },
        usage: USAGE,
        attempt: fullAttempt,
      },
      NOW,
    );

    expect(manifest).toEqual({
      id: "rd_test1",
      url: "https://example.com/article",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "ready",
      title: "A Study of Things",
      tldr: "Things were studied.",
      tags: ["developer-tools", "ai-ml"],
      keywords: ["things", "studies", "results"],
      people: ["Ada Lovelace"],
      orgs: ["ACME"],
      novelty_verdict: "novel",
      similarity: { count: 2, max: 0.7, mean: 0.6, computed_at: NOW },
      connections: [{ id: "rd_other", reason: "same topic" }],
      summary_markdown: "## Things\nStudied.",
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 900,
      content_sha256: "e".repeat(64),
      extracted_bytes: 400,
      fetched_at: NOW,
      created_at: IDENTITY.createdAt,
      updated_at: NOW,
      last_attempt: {
        id: "at_test1",
        trigger: "submit",
        status: "succeeded",
        stage: "write_indexes",
        started_at: ATTEMPT_REF.startedAt,
        finished_at: NOW,
      },
      usage: USAGE,
    });
  });

  it("attempt: null omits last_attempt — the writer states it has no attempt identity", () => {
    const manifest = readyManifest(
      {
        identity: IDENTITY,
        sourceType: "markdown",
        summary: SUMMARY,
        content: {
          content_type: "text/markdown; charset=utf-8",
          content_status: "captured",
          content_bytes: 10,
          content_sha256: "e".repeat(64),
        },
        usage: USAGE,
        attempt: null,
      },
      NOW,
    );
    expect("last_attempt" in manifest).toBe(false);
    expect("similarity" in manifest).toBe(false);
  });

  it("refuses a non-succeeded or unfinished attempt", () => {
    const base = {
      identity: IDENTITY,
      sourceType: "url" as const,
      summary: SUMMARY,
      content: {
        content_type: "text/html",
        content_status: "captured" as const,
        content_bytes: 1,
        content_sha256: "e".repeat(64),
      },
      usage: USAGE,
    };
    const running = {
      id: "at_x",
      trigger: "submit" as const,
      status: "running" as const,
      started_at: NOW,
    };
    const unfinished = { ...running, status: "succeeded" as const };
    expect(() => readyManifest({ ...base, attempt: running }, NOW)).toThrow(/succeeded/);
    expect(() => readyManifest({ ...base, attempt: unfinished }, NOW)).toThrow(/succeeded/);
  });
});

describe("failedManifest", () => {
  const error = {
    code: "FetchTimeoutError",
    message: "timed out",
    stage: "fetch_source" as const,
    failed_at: NOW,
    retryable: true,
  };
  const failedAttempt = {
    id: "at_test1",
    trigger: "submit" as const,
    status: "failed" as const,
    started_at: ATTEMPT_REF.startedAt,
    finished_at: NOW,
    error,
  };

  it("defaults content to the empty placeholder with content_status failed (the worker failure path)", () => {
    const manifest = failedManifest(
      IDENTITY,
      { sourceType: "url", error, attempt: failedAttempt },
      NOW,
    );

    expect(manifest).toEqual({
      id: "rd_test1",
      url: "https://example.com/article",
      url_hash: "a".repeat(64),
      source_type: "url",
      status: "failed",
      error,
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: IDENTITY.createdAt,
      updated_at: NOW,
      last_attempt: failedAttempt,
    });
  });

  it("carries supplied content facts and accepts attempt: null for a legacy batch", () => {
    const manifest = failedManifest(
      IDENTITY,
      {
        sourceType: "markdown",
        error,
        attempt: null,
        content: {
          content_type: "text/markdown; charset=utf-8",
          content_status: "raw_only",
          content_bytes: 33,
          content_sha256: "f".repeat(64),
          extracted_bytes: 12,
        },
      },
      NOW,
    );

    expect(manifest.content_type).toBe("text/markdown; charset=utf-8");
    expect(manifest.content_status).toBe("raw_only");
    expect(manifest.content_bytes).toBe(33);
    expect(manifest.extracted_bytes).toBe(12);
    expect("last_attempt" in manifest).toBe(false);
  });

  it("refuses a non-failed attempt", () => {
    const succeeded = { ...failedAttempt, status: "succeeded" as const };
    expect(() =>
      failedManifest(IDENTITY, { sourceType: "url", error, attempt: succeeded }, NOW),
    ).toThrow(/failed/);
  });

  it("sanitizes an empty error message and code instead of failing the failure path", () => {
    // new Error() has message "" — recovery drafting must not throw on it.
    const empty = { code: "", message: "" };
    const attemptWithEmpty = { ...failedAttempt, error: empty };
    const manifest = failedManifest(
      IDENTITY,
      { sourceType: "url", error: empty, attempt: attemptWithEmpty },
      NOW,
    );
    expect(manifest.error?.code).toBe("unknown_error");
    expect(manifest.error?.message).toBe("unknown error");
    expect(manifest.last_attempt?.error?.message).toBe("unknown error");
  });
});

describe("rollForward", () => {
  const failedAttempt = {
    id: "at_test1",
    trigger: "reprocess" as const,
    status: "failed" as const,
    started_at: ATTEMPT_REF.startedAt,
    finished_at: NOW,
    error: { code: "BadStatusError", message: "502" },
  };

  it("restores the preserved ready manifest, clearing active_attempt and stamping the failed attempt", () => {
    const preserved: Manifest = {
      ...READY_PRIOR,
      active_attempt: {
        id: "at_test1",
        trigger: "reprocess",
        status: "running",
        started_at: ATTEMPT_REF.startedAt,
      },
    };
    const rolled = rollForward(preserved, failedAttempt, NOW);

    expect(rolled).toEqual({
      ...READY_PRIOR,
      last_attempt: failedAttempt,
      updated_at: NOW,
    });
    expect("active_attempt" in rolled).toBe(false);
  });

  it("attempt: null keeps the preserved last_attempt for a legacy batch", () => {
    const rolled = rollForward(READY_PRIOR, null, NOW);
    expect(rolled.last_attempt).toEqual(READY_PRIOR.last_attempt);
    expect(rolled.updated_at).toBe(NOW);
  });

  it("sanitizes an empty message on the failed attempt's error", () => {
    const emptyError = { ...failedAttempt, error: { code: "", message: "" } };
    const rolled = rollForward(READY_PRIOR, emptyError, NOW);
    expect(rolled.last_attempt?.error?.message).toBe("unknown error");
    expect(rolled.last_attempt?.error?.code).toBe("unknown_error");
  });

  it("refuses a non-ready preserved manifest", () => {
    const notReady: Manifest = { ...READY_PRIOR, status: "failed" };
    expect(() => rollForward(notReady, failedAttempt, NOW)).toThrow(/ready/);
  });
});
