import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { dispatchQueueMessage, type Env } from "../../src/index";
import { VectorLedgerWriteError } from "../../src/control-plane/vector-ledger";
import { sha256Hex, type Services } from "../../src/services";
import { buildKeyPrefix, ReadingStore } from "../../src/modules/stores/reading-store";
import { founderTenant, PUBLIC_LOOKUP, reserveReadingSlot, testReadingStore } from "../helpers/tenant-fixtures";

const HTML = `<!doctype html><html><head><title>Test Article</title></head><body>
<main><article><h1>Test Article</h1>
<p>This is a paragraph with enough words to be picked up by readability as the main content body of the article.</p>
<p>This is a second paragraph that adds more content so the article passes the readability character threshold.</p>
</article></main></body></html>`;

function installVectorizeStub() {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vs: VectorizeVector[]) => {
    for (const v of vs) {
      vectors.set(v.id, {
        values: v.values as number[],
        metadata: (v.metadata ?? {}) as Record<string, unknown>,
      });
    }
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const deleteByIds = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: "m" } as VectorizeAsyncMutation;
  });
  const query = vi.fn(async () => ({ count: 0, matches: [] }) as unknown as VectorizeMatches);
  (env as unknown as { READINGS_INDEX: VectorizeIndex }).READINGS_INDEX = {
    upsert,
    deleteByIds,
    query,
  } as unknown as VectorizeIndex;
  return { upsert, deleteByIds, query, vectors };
}

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

function statusLookupPlane(
  inner: D1Database,
  succeed: number,
  after: "throw" | { status: string } = "throw",
): D1Database {
  let remaining = succeed;
  return {
    // Delegated, not stubbed away: the publisher writes its vector-ledger row
    // through `batch` (issue #195 S3), and a double that omitted it would make
    // every publish throw for a reason the test is not about.
    batch: (statements: unknown[]) => (inner as D1Database).batch(statements as never),
    prepare(sql: string) {
      const stmt = inner.prepare(sql);
      if (!/SELECT\s+status\s+FROM\s+users\s+WHERE\s+id\s*=\s*\?/i.test(sql)) return stmt;
      return {
        bind(...params: unknown[]) {
          const bound = stmt.bind(...params);
          return {
            first: async () => {
              if (remaining <= 0) {
                if (after === "throw") throw new Error("D1 hiccup");
                return after;
              }
              remaining -= 1;
              return bound.first();
            },
            run: () => bound.run(),
            all: () => bound.all(),
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) await env.READINGS_BUCKET.delete(obj.key);
}

beforeEach(clearBucket);

describe("processReading — vector ledger at publish", () => {
  it("fails closed on a D1 outage and the retry actually republishes", async () => {
    // Every other visibility write on this path is reconciled defensively —
    // a list row or a vector that did not land is visible and self-heals. A
    // LEDGER row that did not land is neither: nothing repairs it and nothing
    // reports it, and what survives is a published reading missing from the one
    // record that says which vectors this tenant owns. So it must propagate.
    //
    // And it must propagate WITHOUT destroying anything and WITHOUT stranding
    // the reading. That is why the ledger write sits in `commitTerminalManifest`
    // ahead of the terminal manifest write rather than inside
    // `ReadingVisibility.publish`: the terminal `ready` manifest clears
    // `active_attempt`, and once it is cleared no redelivery can republish, so
    // a ledger throw from inside publish would requeue into a no-op and leave a
    // ready, listed reading with no vector and no ledger row forever.
    //
    // So this test does not settle for "an error was thrown". It fails the real
    // D1 INSERT, asserts nothing terminal happened, then heals D1 and re-runs
    // the very same job the queue would redeliver — and requires that second
    // pass to end with BOTH a live vector upserted AND a ledger row present.
    const vector = installVectorizeStub();
    const fetchFn = makeStubFetch();
    const reader = testReadingStore(env);
    const url = "https://example.com/ledger-fail-closed";
    const urlHash = await sha256Hex(url);
    const id = "rd_LEDGERX";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash,
      createdAt,
      keyPrefix,
      attemptId: "at_LEDGERX",
      attemptStartedAt: createdAt,
      trigger: "submit",
      email: false,
    };
    await reader.writeManifest(keyPrefix, {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
      // The shape intake actually writes: a live `active_attempt` this job owns.
      // It is what lets a redelivery write attempt artifacts, and what the
      // terminal `ready` manifest clears — so the fixture must carry it for the
      // retry half of this test to mean anything.
      active_attempt: {
        id: "at_LEDGERX",
        trigger: "submit",
        status: "running",
        started_at: createdAt,
      },
    });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reserveReadingSlot(env, founderTenant(), job);

    // Fail only the ledger INSERT, leaving every other control-plane read and
    // write alone, so this test is about the ledger and not about D1 generally.
    // `d1Down` is flipped between the two passes: a real outage, then recovery.
    let d1Down = true;
    const workerEnv = env as unknown as Env;
    const inner = workerEnv.CONTROL_PLANE;
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: {
        batch: (statements: unknown[]) => inner.batch(statements as never),
        prepare(sql: string) {
          if (d1Down && /INSERT INTO vector_ledger/i.test(sql)) {
            const boom = () => {
              throw new Error("D1 unavailable");
            };
            return { bind: () => ({ first: boom, run: boom, all: boom }) };
          }
          return inner.prepare(sql);
        },
      } as unknown as D1Database,
    };
    const ledgerRow = async () =>
      await inner
        .prepare("SELECT reading_id, state FROM vector_ledger WHERE reading_id = ?")
        .bind(id)
        .first<{ reading_id: string; state: string }>();

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(job, wrapped, makeServices(fetchFn), founderTenant()),
    ).rejects.toThrow(VectorLedgerWriteError);
    consoleErr.mockRestore();

    // Nothing terminal happened: the manifest is untouched and — the part that
    // makes the retry work at all — `active_attempt` is still this attempt's,
    // so the redelivery can still write attempt artifacts.
    const afterFailure = await reader.readManifest(keyPrefix);
    expect(afterFailure?.status).toBe("pending");
    expect(afterFailure?.error).toBeUndefined();
    expect(afterFailure?.active_attempt?.id).toBe(job.attemptId);
    // No vector, and no ledger row: row-before-upsert means a failure here
    // strands nothing on either side.
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(await ledgerRow()).toBeNull();

    // The retry the queue performs: same message body, D1 healthy again.
    d1Down = false;
    await processReading(job, wrapped, makeServices(fetchFn), founderTenant());

    const republished = await reader.readManifest(keyPrefix);
    expect(republished?.status).toBe("ready");
    expect(republished?.error).toBeUndefined();
    // Both halves landed on the retry — this is the claim the placement exists
    // to make true, not merely that an error propagated.
    expect(vector.upsert).toHaveBeenCalledTimes(1);
    expect([...vector.vectors.keys()].some((key) => key.endsWith(id))).toBe(true);
    expect(await ledgerRow()).toMatchObject({ reading_id: id, state: "live" });
  });

  it("retries the delivery rather than acking it", async () => {
    // The consumer's default branch acks, because processReading normally
    // writes a failed manifest before throwing. It does not here — nothing
    // terminal was written at all — so acking would abandon a paid-for reading
    // as pending with nothing to notice.
    const ack = vi.fn();
    const retry = vi.fn();
    await dispatchQueueMessage(
      { body: {}, ack, retry, attempts: 1 } as unknown as Message<unknown>,
      async () => {
        throw new VectorLedgerWriteError("usr_x", new Error("D1 unavailable"));
      },
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("processReading — tenant status lookup at publish", () => {
  it("fail-opens and publishes when the post-CAS tenant-status lookup throws", async () => {
    const vector = installVectorizeStub();
    const fetchFn = makeStubFetch();
    const reader = testReadingStore(env);
    const url = "https://example.com/pre-publish-lookup";
    const urlHash = await sha256Hex(url);
    const id = "rd_PREPUB";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash,
      createdAt,
      keyPrefix,
      attemptId: "at_PREPUB",
      attemptStartedAt: createdAt,
      trigger: "submit",
      email: false,
    };
    await reader.writeManifest(keyPrefix, {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reserveReadingSlot(env, founderTenant(), job);

    const workerEnv = env as unknown as Env;
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: statusLookupPlane(workerEnv.CONTROL_PLANE, 1),
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processReading(job, wrapped, makeServices(fetchFn), founderTenant()),
    ).resolves.toBeUndefined();

    consoleErr.mockRestore();
    expect(fetchFn).toHaveBeenCalled();
    const manifest = await reader.readManifest(keyPrefix);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.error).toBeUndefined();
    expect(await reader.findListIndexItem(id)).not.toBeNull();
    expect(vector.upsert).toHaveBeenCalled();
  });

  // The publisher-side deletion fence (S1 of #195). A consumer that publishes
  // against a tenant already `deleting` must delete its own vector directly,
  // without depending on the `index/list.json` row still being there — a
  // concurrent account wipe deletes that row, and R2 is the only source of the
  // reading ids the wipe's deleteByIds would need.
  it("deletes the vector it just upserted when the tenant is deleting and the list row is gone", async () => {
    const vector = installVectorizeStub();
    const fetchFn = makeStubFetch();
    const reader = testReadingStore(env);
    const url = "https://example.com/wiped-list-row";
    const urlHash = await sha256Hex(url);
    const id = "rd_FENCE";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash,
      createdAt,
      keyPrefix,
      attemptId: "at_FENCE",
      attemptStartedAt: createdAt,
      trigger: "submit",
      email: false,
    };
    await reader.writeManifest(keyPrefix, {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reserveReadingSlot(env, founderTenant(), job);
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });

    const workerEnv = env as unknown as Env;
    // Active for the pre-spend and pre-publish checks, `deleting` for the
    // post-publish recheck: the exact window this fence exists for.
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: statusLookupPlane(workerEnv.CONTROL_PLANE, 2, { status: "deleting" }),
    };
    // The wipe got there first: `index/list.json` is gone, so there is no row
    // for the ordinary removal path to find.
    const wipedListRow = vi
      .spyOn(ReadingStore.prototype, "removeListIndexItemIf")
      .mockResolvedValue(undefined);

    try {
      await expect(
        processReading(job, wrapped, makeServices(fetchFn), founderTenant()),
      ).resolves.toBeUndefined();
    } finally {
      wipedListRow.mockRestore();
    }

    expect(vector.upsert).toHaveBeenCalled();
    expect(vector.deleteByIds).toHaveBeenCalled();
    expect(vector.vectors.size).toBe(0);
  });

  // The fence is for `deleting` only. Any other reason the tenant stopped
  // allowing visibility — `suspended` here — keeps the ordinary gated removal,
  // which does nothing to the vector when there is no list row to remove. No
  // account wipe runs for a suspended tenant, so nothing has raced away the
  // state those gates read.
  it("does not delete the vector for a non-deleting inactive tenant", async () => {
    const vector = installVectorizeStub();
    const fetchFn = makeStubFetch();
    const reader = testReadingStore(env);
    const url = "https://example.com/suspended-not-deleting";
    const urlHash = await sha256Hex(url);
    const id = "rd_SUSPND";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash,
      createdAt,
      keyPrefix,
      attemptId: "at_SUSPND",
      attemptStartedAt: createdAt,
      trigger: "submit",
      email: false,
    };
    await reader.writeManifest(keyPrefix, {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reserveReadingSlot(env, founderTenant(), job);
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });

    const workerEnv = env as unknown as Env;
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: statusLookupPlane(workerEnv.CONTROL_PLANE, 2, { status: "suspended" }),
    };
    const noListRow = vi
      .spyOn(ReadingStore.prototype, "removeListIndexItemIf")
      .mockResolvedValue(undefined);

    try {
      await expect(
        processReading(job, wrapped, makeServices(fetchFn), founderTenant()),
      ).resolves.toBeUndefined();
    } finally {
      noListRow.mockRestore();
    }

    expect(vector.upsert).toHaveBeenCalled();
    expect(vector.deleteByIds).not.toHaveBeenCalled();
    expect(vector.vectors.size).toBe(1);
  });

  it("does not markFailed when tenant-fence visibility.remove throws after ready CAS", async () => {
    installVectorizeStub();
    const fetchFn = makeStubFetch();
    const reader = testReadingStore(env);
    const url = "https://example.com/hide-failure";
    const urlHash = await sha256Hex(url);
    const id = "rd_HIDE";
    const createdAt = "2026-04-26T20:00:00.000Z";
    const keyPrefix = buildKeyPrefix(id, createdAt);
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash,
      createdAt,
      keyPrefix,
      attemptId: "at_HIDE",
      attemptStartedAt: createdAt,
      trigger: "submit",
      email: false,
    };
    await reader.writeManifest(keyPrefix, {
      id,
      url,
      url_hash: urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: createdAt,
      updated_at: createdAt,
    });
    await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
    await reserveReadingSlot(env, founderTenant(), job);
    await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });

    const workerEnv = env as unknown as Env;
    const wrapped: Env = {
      ...workerEnv,
      CONTROL_PLANE: statusLookupPlane(workerEnv.CONTROL_PLANE, 1, { status: "deleting" }),
    };
    const hide = vi
      .spyOn(ReadingStore.prototype, "removeListIndexItemIf")
      .mockRejectedValue(new Error("R2 hide failure"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        processReading(job, wrapped, makeServices(fetchFn), founderTenant()),
      ).resolves.toBeUndefined();
    } finally {
      hide.mockRestore();
      consoleErr.mockRestore();
    }

    const manifest = await reader.readManifest(keyPrefix);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.error).toBeUndefined();
  });
});
