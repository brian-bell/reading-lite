import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/index";
import type { RefreshEnvelope } from "../../src/relationship-refresh";
import { processTensionRepair } from "../../src/tension-repair";
import { founderTenant, FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { PgReadingWriter } from "../../src/modules/stores/postgres/reading-writer";
import type { Manifest, Tension } from "../../src/schemas/manifest";
import type { Services } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";

const createdAt = "2026-09-01T00:00:00.000Z";
const judgedAt = "2026-09-02T00:00:00.000Z";
const A = "rd_0000000001";
const B = "rd_0000000002";
const job: Extract<RefreshEnvelope, { kind: "repair" }> = {
  version: 1, kind: "repair", tenantId: FOUNDER_TENANT_ID, runAt: "2026-09-06T03:07:00.000Z", a: A, b: B,
};
const forward: Tension = { id: B, kind: "supersedes", reason: "Newer figures", computed_at: judgedAt };
let runtime: Env;
let services: Services;
let readingB: Manifest;

const readings = () => testReadingsFor(founderTenant());
function reading(id: string, extra: Partial<Manifest> = {}): Manifest {
  return { id, url: `https://example.com/${id}`, url_hash: (id === A ? "a" : "c").repeat(64), status: "ready", title: `Reading ${id}`, tldr: `Summary ${id}`, summary_markdown: `Stored summary ${id}.`, novelty_verdict: "novel", connections: [], content_type: "text/html", content_status: "captured", content_bytes: 100, content_sha256: "b".repeat(64), created_at: createdAt, updated_at: createdAt, ...extra };
}

beforeEach(async () => {
  runtime = { ...env, RELATIONSHIP_REFRESH: "1" } as unknown as Env;
  services = { fetch: vi.fn<typeof fetch>(), now: () => new Date().toISOString(), newId: () => crypto.randomUUID(), lookup: async () => [] };
  readingB = reading(B);
  // A judged the pair; the write that should have put the inverse on B was lost.
  await readings().seed(reading(A, { tensions: [forward], tensions_judged: [{ id: B, judged_at: judgedAt }] }));
  await readings().seed(readingB);
});
afterEach(() => vi.restoreAllMocks());

describe("hosted tension repair", () => {
  it("mirrors a one-sided judgement onto the partner, and a redelivery changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processTensionRepair(job, runtime, services);
    expect(await readings().manifest(B)).toEqual({ ...readingB,
      tensions: [{ ...forward, id: A, kind: "superseded_by" }], tensions_judged: [{ id: A, judged_at: judgedAt }] });
    const after = await readings().manifest(B);
    await processTensionRepair(job, runtime, services);
    expect(await readings().manifest(B)).toEqual(after);
    expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toContain('"reason":"nothing_to_repair"');
    expect(services.fetch).not.toHaveBeenCalled();
  });

  it("purges the tension and judged record a purged partner left behind", async () => {
    await readings().purge(B);
    await processTensionRepair(job, runtime, services);
    const a = await readings().manifest(A);
    expect(a!.tensions ?? []).toEqual([]);
    expect(a!.tensions_judged).toEqual([]);
  });

  it.each([
    { side: "destination", id: B },
    { side: "source it mirrors from", id: A },
  ])("writes nothing when the $side changes after it was read", async ({ id }) => {
    const before = (await readings().manifest(id))!;
    const winner = { ...before, title: "Concurrent update" };
    const replace = PgReadingWriter.prototype.replacePublishedSetIf;
    vi.spyOn(PgReadingWriter.prototype, "replacePublishedSetIf").mockImplementationOnce(async function (this: PgReadingWriter, ...args) {
      await readings().seed(winner);
      return replace.apply(this, args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await processTensionRepair(job, runtime, services);
    expect(await readings().manifest(id)).toEqual(winner);
    // Either way the mirror was not written onto B.
    expect((await readings().manifest(B))!.tensions).toBeUndefined();
  });

  it("defers while a side is running inside the pending TTL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowIso = "2026-09-06T03:07:00.000Z";
    services.now = () => nowIso;
    await readings().seed({ ...readingB, active_attempt: { id: "at_busy", trigger: "reprocess", stage: "queued", status: "running", started_at: nowIso } });
    await expect(processTensionRepair(job, runtime, services)).rejects.toMatchObject({ name: "DeferPaidWorkError" });
    expect((await readings().manifest(B))!.tensions).toBeUndefined();
  });

  it("does nothing for a suppressed founder or with the gate off", async () => {
    await processTensionRepair(job, { ...runtime, RELATIONSHIP_REFRESH: "0" } as Env, services);
    await testControlPlane(env).run("UPDATE users SET status = 'deleting' WHERE id = ?", FOUNDER_TENANT_ID);
    await processTensionRepair(job, runtime, services);
    expect(await readings().manifest(B)).toEqual(readingB);
  });
});
