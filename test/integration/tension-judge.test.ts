import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/index";
import { consumeRelationshipRefresh, type RefreshEnvelope } from "../../src/relationship-refresh";
import { processTensionJudge } from "../../src/tension-judge";
import { founderTenant, FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { PgReadingWriter } from "../../src/modules/stores/postgres/reading-writer";
import type { Manifest } from "../../src/schemas/manifest";
import type { TensionJudgement } from "../../src/schemas/reading-summary";
import type { Services } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";

const createdAt = "2026-09-01T00:00:00.000Z";
const runAt = "2026-09-06T03:07:00.000Z";
const A = "rd_0000000001";
const B = "rd_0000000002";
const job: Extract<RefreshEnvelope, { kind: "tension" }> = {
  version: 1, kind: "tension", tenantId: FOUNDER_TENANT_ID, runAt,
  a: { id: A, key_prefix: buildKeyPrefix(A, createdAt) }, b: { id: B, key_prefix: buildKeyPrefix(B, createdAt) },
};
let runtime: Env;
let services: Services;
let provider: ReturnType<typeof vi.fn<typeof fetch>>;
let readingA: Manifest;
let readingB: Manifest;

const readings = () => testReadingsFor(founderTenant());
const checkpoints = () => testControlPlane(env).all("SELECT * FROM tension_refresh_jobs");
function response(judgement: TensionJudgement = { verdict: "supersedes", side: "a", reason: "Newer figures replace the older estimate" }) {
  return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(judgement) }] }], usage: { input_tokens: 100, output_tokens: 30 } });
}
function reading(id: string): Manifest {
  return { id, url: `https://example.com/${id}`, url_hash: (id === A ? "a" : "c").repeat(64), status: "ready", title: `Reading ${id}`, tldr: `Summary ${id}`, summary_markdown: `Stored summary ${id}.`, tags: ["test"], keywords: ["alpha", "beta", "gamma"], novelty_verdict: "novel", connections: [], content_type: "text/html", content_status: "captured", content_bytes: 100, content_sha256: "b".repeat(64), created_at: createdAt, updated_at: createdAt };
}

beforeEach(async () => {
  provider = vi.fn<typeof fetch>(async () => response());
  runtime = { ...env, RELATIONSHIP_REFRESH: "1", SUMMARIZER_PROVIDER: "openai", OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra", OPENAI_SUMMARIZATION_REASONING_EFFORT: "low", RETRY_MAX_ATTEMPTS: "2", RETRY_BASE_DELAY_MS: "0", RETRY_MAX_DELAY_MS: "0",
  } as unknown as Env;
  services = { fetch: provider, now: () => new Date().toISOString(), newId: () => crypto.randomUUID(), lookup: async () => [] };
  readingA = reading(A);
  readingB = reading(B);
  for (const m of [readingA, readingB]) await readings().seed(m);
});
afterEach(() => vi.restoreAllMocks());

describe("hosted tension judge", () => {
  it("writes each side's directional entry and judged record, and does not rebill a duplicate", async () => {
    await processTensionJudge(job, runtime, services);
    const [a, b] = [await readings().manifest(A), await readings().manifest(B)];
    const computed_at = a!.tensions![0]!.computed_at;
    const reason = "Newer figures replace the older estimate";
    expect(a).toEqual({ ...readingA, tensions: [{ id: B, kind: "supersedes", reason, computed_at }], tensions_judged: [{ id: B, judged_at: computed_at }] });
    expect(b).toEqual({ ...readingB, tensions: [{ id: A, kind: "superseded_by", reason, computed_at }], tensions_judged: [{ id: A, judged_at: computed_at }] });
    await processTensionJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    const [checkpoint] = await testControlPlane(env).all<{ result_json: unknown }>("SELECT result_json FROM tension_refresh_jobs");
    expect(JSON.stringify(checkpoint!.result_json)).not.toContain("Stored summary");
  });

  it("remembers a none verdict, so a later night does not pay for the pair again", async () => {
    provider.mockResolvedValueOnce(response({ verdict: "none", side: null, reason: "" }));
    await processTensionJudge(job, runtime, services);
    expect((await readings().manifest(A))!.tensions).toBeUndefined();
    expect((await readings().manifest(B))!.tensions_judged).toEqual([{ id: A, judged_at: expect.any(String) }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processTensionJudge({ ...job, runAt: "2026-09-07T03:07:00.000Z" }, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toContain('"reason":"already_judged"');
  });

  it("does not pay for a pair that no longer clears the overlap filter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await readings().seed({ ...readingB, keywords: ["unrelated"] });
    await processTensionJudge(job, runtime, services);
    expect(provider).not.toHaveBeenCalled();
    expect(await checkpoints()).toEqual([]);
  });

  it("leaves both readings untouched on a provider error and does not repeat an uncertain dispatch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockRejectedValue(new Error("transport lost"));
    await expect(processTensionJudge(job, runtime, services)).rejects.toThrow("transport lost");
    const calls = provider.mock.calls.length;
    await processTensionJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledTimes(calls);
    expect(await readings().manifest(A)).toEqual(readingA);
    expect(await readings().manifest(B)).toEqual(readingB);
  });

  it("honors spend denial before dispatch and before creating a checkpoint", async () => {
    await testControlPlane(env).run("UPDATE tenant_limits SET daily_spend_microdollars = 1 WHERE tenant_id = ?", FOUNDER_TENANT_ID);
    await expect(processTensionJudge(job, runtime, services)).rejects.toThrow(/spend admission/);
    expect(provider).not.toHaveBeenCalled();
    expect(await checkpoints()).toEqual([]);
  });

  it("writes neither side when one side is reprocessed during the provider call", async () => {
    const reprocessed = { ...readingB, summary_markdown: "Reprocessed summary." };
    provider.mockImplementationOnce(async () => { await readings().seed(reprocessed); return response(); });
    await processTensionJudge(job, runtime, services);
    expect(await readings().manifest(A)).toEqual(readingA);
    expect(await readings().manifest(B)).toEqual(reprocessed);
  });

  it("abandons the whole pair when one side loses the compare-and-replace", async () => {
    const winner = { ...readingB, title: "Concurrent update" };
    const replace = PgReadingWriter.prototype.replacePublishedSetIf;
    let lost = false;
    vi.spyOn(PgReadingWriter.prototype, "replacePublishedSetIf").mockImplementation(async function (this: PgReadingWriter, ...args) {
      if (!lost) { lost = true; await readings().seed(winner); }
      return replace.apply(this, args);
    });
    await processTensionJudge(job, runtime, services);
    await processTensionJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect(await readings().manifest(A)).toEqual(readingA);
    expect(await readings().manifest(B)).toEqual(winner);
  });

  it("publishes a saved judgement on redelivery without another provider call", async () => {
    const replace = PgReadingWriter.prototype.replacePublishedSetIf;
    let fail = true;
    vi.spyOn(PgReadingWriter.prototype, "replacePublishedSetIf").mockImplementation(async function (this: PgReadingWriter, ...args) {
      if (fail) { fail = false; throw new Error("database unavailable"); }
      return replace.apply(this, args);
    });
    await expect(processTensionJudge(job, runtime, services)).rejects.toThrow("database unavailable");
    expect(await readings().manifest(A)).toEqual(readingA);
    await processTensionJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledOnce();
    expect((await readings().manifest(A))!.tensions).toEqual([expect.objectContaining({ id: B, kind: "supersedes" })]);
    expect((await readings().manifest(B))!.tensions).toEqual([expect.objectContaining({ id: A, kind: "superseded_by" })]);
  });

  it.each([A, B])("purging %s removes the pair's checkpoint", async (purged) => {
    provider.mockRejectedValue(new Error("transport lost"));
    await expect(processTensionJudge(job, runtime, services)).rejects.toThrow("transport lost");
    expect(await checkpoints()).toHaveLength(1);
    await readings().purge(purged);
    expect(await checkpoints()).toEqual([]);
  });

  it("re-enqueues the same pair identity when a side is running in TTL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const nowIso = "2026-09-06T03:07:00.000Z";
    services.now = () => nowIso;
    await readings().seed({ ...readingB, active_attempt: { id: "at_busy", trigger: "reprocess", stage: "queued", status: "running", started_at: nowIso } });
    const send = vi.fn(async () => {});
    runtime.RELATIONSHIP_REFRESH_JOBS = { send } as unknown as Queue;
    const ack = vi.fn(); const retry = vi.fn();
    await consumeRelationshipRefresh({ body: job, ack, retry } as unknown as Message<unknown>, runtime, undefined, services);
    expect(send).toHaveBeenCalledWith({ ...job, deferredAt: expect.any(String) }, { delaySeconds: 15 });
    expect(ack).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
    expect(await checkpoints()).toEqual([]);
    expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toContain(B);
  });

  it("retries a definitive 429 without treating it as an uncertain dispatch", async () => {
    provider.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }));
    await expect(processTensionJudge(job, runtime, services)).rejects.toThrow(/rate limited/);
    await processTensionJudge(job, runtime, services);
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await readings().manifest(A))!.tensions).toHaveLength(1);
  });

  it("ignores a pair that is not canonical", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await processTensionJudge({ ...job, a: job.b, b: job.a }, runtime, services);
    expect(provider).not.toHaveBeenCalled();
    expect(await readings().manifest(A)).toEqual(readingA);
  });
});
