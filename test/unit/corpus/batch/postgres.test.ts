// Storage acceptance for both offline entry points. Providers and R2 are
// substituted; claims, revisions, relationships and embeddings use real SQL.
import { beforeEach, expect, it, vi } from "vitest";
import { batchCorpusFor } from "../../../../scripts/corpus-lib/batch/postgres";
import {
  runFreshMarkdownBatch,
  type FreshMarkdownRunDeps,
} from "../../../../scripts/corpus-lib/batch/run-fresh-markdown";
import { runBatch } from "../../../../scripts/corpus-lib/batch/run";
import { prepareFreshMarkdown } from "../../../../scripts/corpus-lib/batch/prepare-fresh-markdown";
import { activateFreshTargets } from "../../../../scripts/corpus-lib/batch/activation-phase";
import { writeResults } from "../../../../scripts/corpus-lib/batch/write-phase";
import { pgReadingStoreFor } from "../../../../src/modules/stores/postgres/reading-store";
import { EMIT_READING_TOOL_NAME } from "../../../../src/modules/anthropic";
import type {
  PersistedSidecar,
  Sidecar,
  SidecarTarget,
} from "../../../../scripts/corpus-lib/batch/types";
import type { BatchResult } from "../../../../scripts/corpus-lib/batch/clients";
import type { TenantContext } from "../../../../src/control-plane/ids";
import type { Sql } from "../../../../src/modules/db/sql";
import { batchSpendAuthority } from "../../../helpers/operator-spend";
import {
  seedTenant,
  seedReading,
  useCorpusDatabase,
  unitVector,
} from "../../../helpers/ops-corpus-e2e";
import { interceptSql } from "../../../helpers/sql-faults";
const sqlFor = useCorpusDatabase();
const now = () => "2026-06-02T00:00:00.000Z";
let sql: Sql;
let tenant: TenantContext;
beforeEach(async () => {
  sql = sqlFor();
  tenant = await seedTenant(sql);
});
const article = (id = "a") => ({
  sourceUrl: `https://example.com/${id}`,
  markdown: `article ${id}`,
  bytes: 9,
  filePath: `${id}.md`,
  fileName: `${id}.md`,
});
const summary = {
  title: "New title",
  tldr: "New summary.",
  tags: ["batch"],
  keywords: ["one", "two", "three"],
  people: [],
  orgs: [],
  novelty_verdict: "novel",
  connections: [],
  summary_markdown: "New body",
};
function succeeded(t: SidecarTarget): BatchResult {
  return {
    custom_id: t.customId,
    result: {
      type: "succeeded",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool",
            name: EMIT_READING_TOOL_NAME,
            input: summary,
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  };
}
function harness(who = tenant) {
  let sidecar: PersistedSidecar | null = null;
  const objects = new Map<string, string>();
  let next = 0;
  const events: string[] = [];
  const corpus = batchCorpusFor(sql, who);
  const r2 = {
    get: vi.fn(async (key: string) => objects.get(key) ?? null),
    put: vi.fn(async (key: string, body: string | Uint8Array) => {
      events.push(`content:${key}`);
      objects.set(
        key,
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
    }),
    putIfAbsent: vi.fn(async () => {
      throw new Error("no R2 claims");
    }),
    head: vi.fn(async () => false),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
    listKeys: vi.fn(async () => []),
  };
  const deps: FreshMarkdownRunDeps = {
    corpus,
    r2,
    spend: batchSpendAuthority().spend,
    newId: () => `rd_batch_${next++}`,
    newAttemptId: () => `batch_attempt_${next++}`,
    now,
    sleep: async () => {},
    model: "claude-opus-4-8",
    extract: vi.fn(async () => ({
      raw: new TextEncoder().encode("fresh"),
      markdown: "fresh",
      content_type: "text/html",
      content_status: "captured" as const,
      content_bytes: 5,
      content_sha256: "c".repeat(64),
    })),
    embed: {
      embedMany: vi.fn(async (inputs: string[]) => ({
        embeddings: inputs.map(unitVector),
        tokensByInput: inputs.map(() => 3),
      })),
    },
    batch: {
      create: vi.fn(async () => {
        events.push("create");
        return {
          id: "msgbatch_test",
          processing_status: "in_progress",
          results_url: null,
        };
      }),
      get: vi.fn(async () => ({
        id: "msgbatch_test",
        processing_status: "ended",
        results_url: "https://results",
      })),
      results: vi.fn(async () => (sidecar as Sidecar).targets.map(succeeded)),
    },
    loadSidecar: async () => sidecar,
    saveSidecar: async (s) => {
      events.push(`sidecar:${s.phase}`);
      sidecar = s;
    },
    clearSidecar: async () => {
      sidecar = null;
    },
  };
  return {
    deps,
    corpus,
    r2,
    objects,
    events,
    store: pgReadingStoreFor(sql, who),
    sidecar: () => sidecar as Sidecar,
  };
}
const audit = (r: { id: string; url: string; keyPrefix: string }) => ({
  reading_id: r.id,
  url: r.url,
  key_prefix: r.keyPrefix,
  short: "example",
  attempts: 1,
  category: "failed" as const,
});

it.each(["anthropic", "openai"] as const)(
  "ingests via %s into the library, with only immutable content in R2",
  async (provider) => {
    const h = harness();
    if (provider === "openai") {
      let input = "";
      h.deps.configuredProvider = "openai";
      h.deps.model = "gpt-5.6-terra";
      h.deps.saveInputJsonl = async (jsonl) => {
        input = jsonl;
      };
      h.deps.openaiBatch = {
        upload: vi.fn(async () => ({
          id: "file_input",
          filename: "batch.jsonl",
          purpose: "batch",
          bytes: 10,
        })),
        create: vi.fn(async () => ({
          id: "batch_test",
          status: "validating",
          input_file_id: "file_input",
          output_file_id: null,
          error_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 0 },
        })),
        get: vi.fn(async () => ({
          id: "batch_test",
          status: "completed",
          input_file_id: "file_input",
          output_file_id: "file_output",
          error_file_id: null,
          request_counts: { total: 1, completed: 1, failed: 0 },
        })),
        content: vi.fn(async () =>
          JSON.stringify({
            custom_id: JSON.parse(input.trim()).custom_id,
            response: {
              status_code: 200,
              body: {
                id: "resp_test",
                object: "response",
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: JSON.stringify(summary) },
                    ],
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 5 },
              },
            },
          }),
        ),
        listFiles: vi.fn(async () => ({ data: [], has_more: false })),
        listBatches: vi.fn(async () => ({
          data: [],
          raw: [],
          has_more: false,
        })),
      };
      h.deps.reconcileAcquireLock = async () => ({ release: async () => {} });
    }
    const result = await runFreshMarkdownBatch([article()], h.deps);
    expect(result.report[0]?.status).toBe("ready");
    const id = result.report[0]!.id;
    expect(
      (await h.store.listManifests({ offset: 0, limit: 10 })).readings,
    ).toMatchObject([{ id, title: "New title" }]);
    expect((await h.store.loadReadingById(id))?.manifest).toMatchObject({
      source_type: "markdown",
      status: "ready",
      summary_markdown: "New body",
    });
    expect(await h.corpus.query(unitVector(), { topK: 5 })).toMatchObject([
      { id },
    ]);
    expect([...h.objects.keys()]).toHaveLength(2);
    expect(
      [...h.objects.keys()].every((key) =>
        /\/revisions\/batch_attempt_\d+\/(raw\.md|extracted\.md)$/.test(key),
      ),
    ).toBe(true);
    expect(
      await sql.query("SELECT * FROM reading_jobs WHERE tenant_id = $1", [
        tenant.tenantId,
      ]),
    ).toEqual([]);
    expect(h.r2.putIfAbsent).not.toHaveBeenCalled();
    expect(h.events[0]).toBe("sidecar:activating");
  },
);

it("recovers a failed reading in place and exposes its revision content", async () => {
  const r = await seedReading(sql, tenant, "rd_failed", { status: "failed" });
  const h = harness();
  const result = await runBatch([audit(r)], h.deps);
  expect(result.report).toEqual([{ id: r.id, status: "ready" }]);
  expect(h.deps.extract).toHaveBeenCalledOnce();
  const keys = await h.store.contentKeys(r.id);
  expect(keys?.rawKey).toContain("/revisions/");
  expect(h.objects.get(keys!.extractedKey!)).toBe("fresh");
  expect(await h.corpus.getByUrl(r.manifest.url_hash)).toMatchObject({
    id: r.id,
  });
});

it("reads saved revision keys and preserves publication on a failed recovery", async () => {
  const r = await seedReading(sql, tenant, "rd_ready", {
    embedding: unitVector(),
    revision: {
      id: "old",
      rawKey: "readings/saved/raw.html",
      extractedKey: "readings/saved/text.md",
    },
  });
  const h = harness();
  h.objects.set("readings/saved/text.md", "saved body");
  h.deps.batch!.results = vi.fn(async () => [
    { custom_id: r.id, result: { type: "expired" as const } },
  ]);
  await runBatch([audit(r)], h.deps);
  expect(h.deps.extract).not.toHaveBeenCalled();
  expect(h.r2.put).not.toHaveBeenCalled();
  const current = (await h.store.loadReadingById(r.id))!.manifest;
  expect(current).toMatchObject({
    status: "ready",
    source_type: "url",
    title: r.manifest.title,
    summary_markdown: r.manifest.summary_markdown,
    last_attempt: { status: "failed" },
  });
  expect((await h.store.contentKeys(r.id))?.rawKey).toBe(
    "readings/saved/raw.html",
  );
  expect(await h.corpus.query(unitVector(), { topK: 5 })).toMatchObject([
    { id: r.id },
  ]);
});

it("keeps a failed ingest's URL claim and reprocesses it in place instead of creating a duplicate", async () => {
  const h = harness();
  h.deps.batch!.results = vi.fn(async () =>
    h.sidecar().targets.map((t) => ({
      custom_id: t.customId,
      result: { type: "expired" as const },
    })),
  );
  const first = await runFreshMarkdownBatch([article()], h.deps);
  const id = first.report[0]!.id;
  expect(first.report[0]!.status).toBe("failed");
  // The failed reading still owns its URL: intake and the batch alike find
  // it as the owner and reprocess it in place.
  expect(await h.corpus.getByUrl(h.sidecar().targets[0]!.urlHash)).toMatchObject({ id });
  await h.deps.clearSidecar();
  h.deps.batch!.results = vi.fn(async () => h.sidecar().targets.map(succeeded));
  const second = await runFreshMarkdownBatch([article()], h.deps);
  expect(second.report).toEqual([{ id, status: "ready" }]);
  expect(
    (await h.store.listManifests({ offset: 0, limit: 10 })).total_filtered,
  ).toBe(1);
});

it("keeps ready and pending owners out of a fresh batch, scoped per tenant", async () => {
  await seedReading(sql, tenant, "rd_a", { url: article("a").sourceUrl });
  await seedReading(sql, tenant, "rd_b", {
    url: article("b").sourceUrl,
    status: "pending",
  });
  const h = harness();
  expect(
    (
      await runFreshMarkdownBatch([article("a"), article("b")], h.deps)
    ).dispositions.map((d) => d.kind),
  ).toEqual(["skip-ready", "skip-pending"]);
  expect(h.deps.batch!.create).not.toHaveBeenCalled();
  const other = harness(await seedTenant(sql));
  expect(
    (await runFreshMarkdownBatch([article("a")], other.deps)).report[0]?.status,
  ).toBe("ready");
  expect(await h.corpus.query(unitVector(), { topK: 5 })).toEqual([]);
});

it("skips a plan whose URL was claimed before activation", async () => {
  const h = harness();
  const plan = await prepareFreshMarkdown([article()], {
    ...h.corpus,
    newId: () => "rd_new",
    newAttemptId: () => "batch_new",
    now,
  });
  await seedReading(sql, tenant, "rd_winner", { url: article().sourceUrl });
  const result = await activateFreshTargets(plan.toIngest, {
    ...h.deps,
    model: h.deps.model,
  });
  expect(result.skipped).toHaveLength(1);
  expect(h.r2.put).not.toHaveBeenCalled();
  expect(await h.store.loadReadingById("rd_new")).toBeNull();
});

it("rolls back a failed publication and resumes the same batch after partial completion", async () => {
  const h = harness();
  const fault = interceptSql(/INSERT INTO reading_embeddings/, (call) =>
    call === 2 ? new Error("embedding write failed") : "pass",
  );
  await expect(
    runFreshMarkdownBatch([article("a"), article("b")], h.deps),
  ).rejects.toThrow(/embedding write failed/);
  fault.mockRestore();
  const targets = h.sidecar().targets;
  expect((await h.store.loadReadingById(targets[0]!.id))!.manifest.status).toBe(
    "ready",
  );
  expect(
    (await h.store.loadReadingById(targets[1]!.id))!.manifest,
  ).toMatchObject({
    status: "pending",
    active_attempt: { id: targets[1]!.attemptId },
  });
  expect(
    await sql.query(
      "SELECT * FROM reading_revisions WHERE tenant_id = $1 AND reading_id = $2",
      [tenant.tenantId, targets[1]!.id],
    ),
  ).toEqual([]);
  vi.mocked(h.deps.embed.embedMany).mockClear();
  const resumed = await runFreshMarkdownBatch([], h.deps);
  expect(resumed.resumed).toBe(true);
  expect(resumed.report.map((r) => r.status)).toEqual(["skipped", "ready"]);
  expect(h.deps.batch!.create).toHaveBeenCalledOnce();
  expect(h.deps.embed.embedMany).toHaveBeenCalledWith(["New summary."]);
  expect(
    (await h.store.listManifests({ offset: 0, limit: 10 })).readings.every(
      (r) => r.status === "ready",
    ),
  ).toBe(true);
});

it.each(["purged", "superseded"] as const)(
  "never publishes results for a %s reading",
  async (kind) => {
    const h = harness();
    h.deps.batch!.get = vi.fn(async () => {
      throw new Error("interrupted");
    });
    await expect(runFreshMarkdownBatch([article()], h.deps)).rejects.toThrow(
      "interrupted",
    );
    const target = h.sidecar().targets[0]!;
    if (kind === "purged")
      await sql.execute(
        "DELETE FROM readings WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, target.id],
      );
    else
      await sql.execute(
        "UPDATE readings SET active_attempt = jsonb_set(active_attempt, '{id}', '\"newer\"') WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, target.id],
      );
    const embedMany = vi.fn(async () => ({
      embeddings: [],
      tokensByInput: [],
    }));
    const report = await writeResults(h.sidecar(), [succeeded(target)], {
      corpus: h.corpus,
      r2: h.r2,
      now,
      embedMany,
    });
    expect(report[0]!.status).toBe("skipped");
    expect(embedMany).not.toHaveBeenCalled();
    expect(
      await sql.query(
        "SELECT * FROM reading_revisions WHERE tenant_id = $1 AND reading_id = $2",
        [tenant.tenantId, target.id],
      ),
    ).toEqual([]);
  },
);

it("publishes legacy sidecars only onto vacant pending rows, without fabricating attempt summaries", async () => {
  const r = await seedReading(sql, tenant, "rd_legacy", { status: "pending" });
  const h = harness();
  const target: SidecarTarget = {
    id: r.id,
    customId: r.id,
    keyPrefix: r.keyPrefix,
    url: r.url,
    urlHash: r.manifest.url_hash,
    createdAt: r.manifest.created_at,
    sourceType: "url",
    contentType: r.manifest.content_type,
    contentStatus: "captured",
    contentBytes: 10,
    contentSha256: "0".repeat(64),
    queryEmbedTokens: 0,
  };
  const sc: Sidecar = {
    version: 2,
    provider: "anthropic",
    phase: "submitted",
    batchId: "old",
    model: "claude-opus-4-8",
    processingStatus: "ended",
    resultsUrl: "https://results",
    targets: [target],
  };
  expect(
    (
      await writeResults(sc, [succeeded(target)], {
        corpus: h.corpus,
        r2: h.r2,
        embedMany: h.deps.embed.embedMany,
        now,
      })
    )[0]!.status,
  ).toBe("ready");
  expect(
    (await h.store.loadReadingById(r.id))!.manifest.last_attempt,
  ).toBeUndefined();
  expect(
    (
      await writeResults(sc, [succeeded(target)], {
        corpus: h.corpus,
        r2: h.r2,
        embedMany: h.deps.embed.embedMany,
        now,
      })
    )[0]!.status,
  ).toBe("skipped");
});

it("commits relationships with the reading and rolls them back with an embedding failure", async () => {
  await seedReading(sql, tenant, "rd_peer", { embedding: unitVector() });
  const h = harness();
  h.deps.batch!.results = vi.fn(async () =>
    h.sidecar().targets.map((t) => ({
      custom_id: t.customId,
      result: {
        type: "succeeded" as const,
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool",
              name: EMIT_READING_TOOL_NAME,
              input: {
                ...summary,
                connections: [{ id: "rd_peer", reason: "shared idea" }],
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    })),
  );
  const fault = interceptSql(
    /INSERT INTO reading_embeddings/,
    () => new Error("rollback"),
  );
  await expect(runFreshMarkdownBatch([article()], h.deps)).rejects.toThrow(
    "rollback",
  );
  fault.mockRestore();
  const id = h.sidecar().targets[0]!.id;
  const relationships = () =>
    sql.query(
      "SELECT target_id FROM reading_relationships WHERE tenant_id = $1 AND source_id = $2",
      [tenant.tenantId, id],
    );
  expect(await relationships()).toEqual([]);
  await runFreshMarkdownBatch([], h.deps);
  expect(await relationships()).toEqual([{ target_id: "rd_peer" }]);
});

it("refuses offline activation for a deleting tenant before provider submission", async () => {
  const h = harness();
  await sql.execute("UPDATE users SET status = 'deleting' WHERE id = $1", [
    tenant.tenantId,
  ]);
  const result = await runFreshMarkdownBatch([article()], h.deps);
  expect(result.report[0]!.status).toBe("skipped");
  expect(h.deps.batch!.create).not.toHaveBeenCalled();
  expect(h.objects.size).toBe(0);
  expect(
    (await h.store.listManifests({ offset: 0, limit: 10 })).readings,
  ).toEqual([]);
});

it("discards only the losing attempt's bytes when URL ownership changes during capture", async () => {
  const h = harness();
  const put = h.r2.put.getMockImplementation()!;
  h.r2.put.mockImplementation(async (key, body) => {
    await put(key, body);
    if (key.endsWith("extracted.md"))
      await seedReading(sql, tenant, "rd_winner", { url: article().sourceUrl });
  });
  const result = await runFreshMarkdownBatch([article()], h.deps);
  expect(result.report[0]!.status).toBe("skipped");
  expect(h.objects.size).toBe(0);
  expect(h.deps.batch!.create).not.toHaveBeenCalled();
  expect((await h.store.loadReadingById("rd_winner"))!.manifest.status).toBe(
    "ready",
  );
});

it("cleans a partially written capture without submitting a provider batch", async () => {
  const h = harness();
  const put = h.r2.put.getMockImplementation()!;
  h.r2.put.mockImplementation(async (key, body) => {
    if (key.endsWith("extracted.md")) throw new Error("capture interrupted");
    await put(key, body);
  });
  await expect(runFreshMarkdownBatch([article()], h.deps)).rejects.toThrow(
    "capture interrupted",
  );
  expect(h.objects.size).toBe(0);
  expect(h.deps.batch!.create).not.toHaveBeenCalled();
  expect(h.sidecar().phase).toBe("activating");
});

it.each([false, true])(
  "discards a failed recovery's new capture, including cleanup retry=%s",
  async (retry) => {
    const r = await seedReading(sql, tenant, "rd_ready", {
      embedding: unitVector(),
      revision: {
        id: "old",
        rawKey: "readings/saved/raw.html",
        extractedKey: "readings/saved/text.md",
      },
    });
    const h = harness();
    // Missing saved markdown forces a new capture. The old raw object stays live.
    h.objects.set("readings/saved/raw.html", "old body");
    h.deps.batch!.results = vi.fn(async () => [
      { custom_id: r.id, result: { type: "expired" as const } },
    ]);
    if (retry) {
      h.r2.delete.mockRejectedValueOnce(new Error("R2 delete unavailable"));
      await expect(runBatch([audit(r)], h.deps)).rejects.toThrow(
        "R2 delete unavailable",
      );
      expect(
        (await h.store.loadReadingById(r.id))!.manifest.last_attempt?.status,
      ).toBe("failed");
      await runBatch([audit(r)], h.deps);
    } else await runBatch([audit(r)], h.deps);
    expect([...h.objects.keys()]).toEqual(["readings/saved/raw.html"]);
    expect(h.deps.batch!.create).toHaveBeenCalledOnce();
    expect((await h.store.loadReadingById(r.id))!.manifest).toMatchObject({
      status: "ready",
      title: r.manifest.title,
    });
  },
);

it("cleans the captured bytes if deletion wins during terminal embedding", async () => {
  const h = harness();
  const embed = h.deps.embed.embedMany;
  h.deps.embed.embedMany = async (inputs) => {
    const result = await embed(inputs);
    if (h.sidecar()?.phase === "submitted")
      await sql.execute("DELETE FROM readings WHERE tenant_id = $1", [
        tenant.tenantId,
      ]);
    return result;
  };
  const result = await runFreshMarkdownBatch([article()], h.deps);
  expect(result.report[0]!.status).toBe("skipped");
  expect(h.objects.size).toBe(0);
});
