import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { dispatchQueueMessage, type Env } from "../../src/index";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { PgReadingWriter, PublishCommitError } from "../../src/modules/stores/postgres/reading-writer";
import { sha256Hex, type Services } from "../../src/services";
import { founderTenant, FOUNDER_TENANT_ID, PUBLIC_LOOKUP, reserveReadingSlot } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { interceptSql, TENANT_STATUS_LOCK } from "../helpers/sql-faults";
import { beginAccountDeletion } from "../../src/control-plane/account-delete";
import { testControlPlane } from "../helpers/control-plane-db";
import { submitPending } from "../../src/modules/manifest-drafting";

const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function makeStubFetch() {
  const embedding = new Array(1536).fill(0.1);
  const toolInput = {
    title: "Test Article",
    tldr: "A short summary.",
    tags: ["test"],
    keywords: ["test", "article", "integration"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: "summary body",
  };
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.openai.com/v1/embeddings")) {
      return new Response(
        JSON.stringify({ data: [{ embedding }], usage: { prompt_tokens: 10, total_tokens: 10 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.openai.com/v1/responses")) {
      return new Response(
        JSON.stringify({
          id: "resp_01",
          object: "response",
          status: "completed",
          output: [
            {
              id: "msg_01",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: JSON.stringify(toolInput), annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 10,
            },
            output_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 150,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

function makeServices(fetchFn: typeof fetch): Services {
  return {
    fetch: fetchFn,
    lookup: PUBLIC_LOOKUP,
    now: () => "2026-04-26T20:00:00.000Z",
    newId: () => "rd_VIS",
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) await env.READINGS_BUCKET.delete(obj.key);
}

beforeEach(clearBucket);

afterEach(() => vi.restoreAllMocks());

const CREATED_AT = "2026-04-26T20:00:00.000Z";

// The state intake leaves for the consumer: a pending reading this job's
// attempt owns, and a reserved reading slot.
async function pendingJob(id: string, url: string) {
  const readings = testReadingsFor(founderTenant());
  const urlHash = await sha256Hex(url);
  const keyPrefix = buildKeyPrefix(id, CREATED_AT);
  const attemptId = `at_${id.slice(3)}`;
  const job: ProcessReadingArgs = {
    id,
    url,
    urlHash,
    createdAt: CREATED_AT,
    keyPrefix,
    attemptId,
    attemptStartedAt: CREATED_AT,
    trigger: "submit",
    email: false,
  };
  await readings.seed(
    {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      // The shape intake actually writes: a live `active_attempt` this job owns.
      // It is what lets a redelivery keep writing, and what publication clears —
      // so the fixture must carry it for a retry to mean anything.
      active_attempt: { id: attemptId, trigger: "submit", status: "running", started_at: CREATED_AT },
    },
    { keyPrefix },
  );
  await reserveReadingSlot(env, founderTenant(), job);
  return { readings, job, keyPrefix };
}

function summarizeCalls(fetchFn: ReturnType<typeof makeStubFetch>): number {
  return fetchFn.mock.calls.filter(([input]) => String(input).startsWith("https://api.openai.com/v1/responses")).length;
}

describe("processReading — the publish transaction", () => {
  it("fails closed on a database failure and the retry actually republishes", async () => {
    // Publication is one transaction, so a failure inside it leaves nothing
    // half-published. It must also propagate WITHOUT destroying anything and
    // WITHOUT stranding the reading: by publish time the summarization is paid
    // for, and a reading marked failed here would throw that away over a blip.
    //
    // So this test does not settle for "an error was thrown". It fails a real
    // transaction at its last statement, asserts nothing terminal happened,
    // then re-runs the very same job the queue would redeliver — and requires
    // that second pass to publish, without paying for a second summary.
    const fetchFn = makeStubFetch();
    const { readings, job } = await pendingJob("rd_PUBFAIL", "https://example.com/publish-fail-closed");

    // The embedding is the transaction's last write; a wrong dimension makes
    // PostgreSQL reject it after the revision, reading and relationships
    // were written, so the rollback is real.
    const publish = PgReadingWriter.prototype.publish;
    vi.spyOn(PgReadingWriter.prototype, "publish").mockImplementationOnce(function (this: PgReadingWriter, ref, ready, opts) {
      return publish.call(this, ref, ready, { ...opts, embedding: [1, 2, 3] });
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(job, env as unknown as Env, makeServices(fetchFn), founderTenant()),
    ).rejects.toThrow(PublishCommitError);
    consoleErr.mockRestore();

    // Nothing terminal happened: the reading is untouched and — the part that
    // makes the retry work at all — `active_attempt` is still this attempt's.
    const afterFailure = await readings.manifest(job.id);
    expect(afterFailure?.status).toBe("pending");
    expect(afterFailure?.error).toBeUndefined();
    expect(afterFailure?.active_attempt?.id).toBe(job.attemptId);
    expect(await readings.hasEmbedding(job.id)).toBe(false);
    expect(await readings.sql.query("SELECT 1 FROM reading_revisions WHERE reading_id = $1", [job.id])).toEqual([]);

    // The retry the queue performs: same message body, database healthy again.
    await processReading(job, env as unknown as Env, makeServices(fetchFn), founderTenant());

    const republished = await readings.manifest(job.id);
    expect(republished?.status).toBe("ready");
    expect(republished?.error).toBeUndefined();
    expect(await readings.hasEmbedding(job.id)).toBe(true);
    // The checkpoint carried the paid summary across the retry.
    expect(summarizeCalls(fetchFn)).toBe(1);
  });

  it("retries the delivery rather than acking it", async () => {
    // The consumer's default branch acks, because processReading normally
    // marks the reading failed before throwing. It does not here — nothing
    // terminal was written at all — so acking would abandon a paid-for reading
    // as pending with nothing to notice.
    const ack = vi.fn();
    const retry = vi.fn();
    await dispatchQueueMessage(
      { body: {}, ack, retry, attempts: 1 } as unknown as Message<unknown>,
      async () => {
        throw new PublishCommitError(new Error("database unavailable"));
      },
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

// Tenant eligibility joins the publish transaction (slice 1c.3). `users` is in
// the same database, so publish locks the tenant row FOR SHARE and reads
// `status` under that lock: there is no window between the check and the
// commit, and nothing to compensate for afterwards.
describe("processReading — tenant eligibility inside the publish transaction", () => {
  // An ineligible tenant's reading is still stored — the attempt paid for it —
  // but never becomes searchable. A `deleting` tenant's copy is left to the
  // account wipe, which sweeps rows again after its objects phase for exactly
  // this publisher; a `suspended` tenant runs no wipe, and a suspension can be
  // lifted, so the reading has to survive.
  it.each(["deleting", "suspended"])(
    "stores a %s tenant's reading without making it searchable",
    async (status) => {
      const fetchFn = makeStubFetch();
      const { readings, job } = await pendingJob("rd_INELIG", "https://example.com/ineligible-tenant");
      // Active for the pre-spend gate, ineligible by the time publish locks it.
      interceptSql(TENANT_STATUS_LOCK, () => [{ status }]);

      await expect(
        processReading(job, env as unknown as Env, makeServices(fetchFn), founderTenant()),
      ).resolves.toBeUndefined();

      const manifest = await readings.manifest(job.id);
      expect(manifest?.status).toBe("ready");
      expect(manifest?.error).toBeUndefined();
      expect(await readings.extractedText(job.id)).not.toBeNull();
      expect(await readings.hasEmbedding(job.id)).toBe(false);
    },
  );

  // The race the fence used to compensate for, run for real on two
  // connections: the deletion's status UPDATE waits on the tenant row this
  // transaction holds FOR SHARE, so the publish it raced completes whole.
  it("makes DELETE /api/account wait for an in-flight publish", async () => {
    const fetchFn = makeStubFetch();
    const { readings, job } = await pendingJob("rd_SERIAL", "https://example.com/publish-vs-delete");
    let deletion: Promise<unknown> | null = null;
    let deleted = false;

    // The reading lock is the publish transaction's second statement, so the
    // tenant lock is already held when this runs.
    interceptSql(/FROM readings WHERE tenant_id = \$1 AND id = \$2\s+FOR UPDATE/, async (): Promise<"pass"> => {
      if (!deletion) {
        deletion = beginAccountDeletion(testControlPlane(env), {
          userId: FOUNDER_TENANT_ID,
          nowMs: Date.parse("2026-04-26T20:01:00.000Z"),
        }).then((out) => {
          deleted = true;
          return out;
        });
        // Long enough for an unblocked UPDATE to have committed.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(deleted).toBe(false);
      }
      return "pass";
    });

    await processReading(job, env as unknown as Env, makeServices(fetchFn), founderTenant());

    expect(await deletion).toEqual({ kind: "started" });
    // The publish held the lock first, so it published in full.
    expect((await readings.manifest(job.id))?.status).toBe("ready");
    expect(await readings.hasEmbedding(job.id)).toBe(true);
    expect(
      await testControlPlane(env).first<{ status: string }>("SELECT status FROM users WHERE id = ?", FOUNDER_TENANT_ID),
    ).toEqual({ status: "deleting" });
  });

  // The other side of that race, and the reason claim takes the same lock: a
  // claim that lands after the status flipped must leave nothing at all.
  it("writes no rows for a claim that lands after the account is marked deleting", async () => {
    const readings = testReadingsFor(founderTenant());
    const url = "https://example.com/claim-after-delete";
    await beginAccountDeletion(testControlPlane(env), {
      userId: FOUNDER_TENANT_ID,
      nowMs: Date.parse("2026-04-26T20:01:00.000Z"),
    });
    const urlHash = await sha256Hex(url);
    const draft = submitPending(
      { id: "rd_LATECLM", url, urlHash, createdAt: CREATED_AT },
      { attemptId: "at_LATECLM", startedAt: CREATED_AT },
    );

    const claimed = await readings.writer.claimUrl(draft.manifest, buildKeyPrefix("rd_LATECLM", CREATED_AT), {
      summary: draft.attempt,
      payload: {},
    });

    expect(claimed).toEqual({ kind: "tenant_inactive" });
    expect(await readings.manifest("rd_LATECLM")).toBeNull();
    expect(await readings.urlOwnerId(url)).toBeNull();
    for (const table of ["reading_attempts", "reading_jobs"]) {
      expect(await readings.sql.query(`SELECT 1 FROM ${table} WHERE reading_id = $1`, ["rd_LATECLM"])).toEqual([]);
    }
  });
});
