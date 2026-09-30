import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readingIntakeFor,
  type ReadingIntakeDeps,
} from "../../../src/intake";
import { buildKeyPrefix } from "../../../src/modules/stores/layout";
import type { ProcessReadingEnvelopeV1 } from "../../../src/control-plane/envelope";
import { createApiTokenPrincipal } from "../../../src/control-plane/principal";
import type { Manifest } from "../../../src/schemas/manifest";
import { sha256Hex, type Services } from "../../../src/services";
import type { TenantUsage } from "../../../src/control-plane/tenant-usage-guard";
import { mintTenant } from "../../helpers/pg-fixtures";
import { testReadingsFor, type TestReadings } from "../../helpers/test-readings";

// Reading intake's own test surface: the three verbs against the real
// PostgreSQL stores and a capturing queue, asserting domain outcomes — no
// Hono, no HTTP. Each intake gets its own minted tenant, so tests never share
// rows.

const PRINCIPAL = createApiTokenPrincipal({
  tenantId: "usr_550e8400-e29b-41d4-a716-446655440000",
  userId: "usr_550e8400-e29b-41d4-a716-446655440000",
  tokenId: "tok_550e8400-e29b-41d4-a716-446655440000",
  scopes: ["readings:write", "readings:import"],
});

const NOW = "2026-04-26T20:00:00.000Z";
const TTL = 300;

function seqServices(): Services {
  let n = 0;
  return {
    fetch: vi.fn() as unknown as typeof fetch,
    lookup: async () => [{ address: "93.184.216.34" }],
    now: () => NOW,
    newId: () => `rd_TEST${(n++).toString().padStart(2, "0")}`,
  };
}

function captureQueue(): {
  queue: Queue<ProcessReadingEnvelopeV1>;
  sent: ProcessReadingEnvelopeV1[];
} {
  const sent: ProcessReadingEnvelopeV1[] = [];
  const queue = {
    send: vi.fn(async (msg: ProcessReadingEnvelopeV1) => {
      sent.push(msg);
    }),
  } as unknown as Queue<ProcessReadingEnvelopeV1>;
  return { queue, sent };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(clearBucket);
afterEach(clearBucket);

function allowAllUsage(): TenantUsage {
  return {
    admitRequest: async () => ({ ok: true }),
    reserveReading: async () => ({ ok: true }),
    releaseReading: async () => undefined,
    commitReading: async () => ({ok:true}),
    acquireLease: async () => ({ ok: true, fence: "test-fence", alreadyRunning: false, expiresAtMs: 0 }),
    renewLease: async () => ({ ok: true, fence: "test-fence", alreadyRunning: false, expiresAtMs: 0 }),
    pauseLease: async () => ({ ok: true, fence: "test-fence", alreadyRunning: false, expiresAtMs: 0 }),
    releaseLease: async () => undefined,
    refreshReading: async () => undefined,
  };
}

async function makeIntake(overrides: Partial<ReadingIntakeDeps> & { reader?: TestReadings } = {}) {
  const { reader = testReadingsFor(await mintTenant()), ...rest } = overrides;
  const { queue, sent } = captureQueue();
  const deps: ReadingIntakeDeps = {
    store: reader.store,
    writer: reader.writer,
    content: reader.content,
    queue,
    services: seqServices(),
    pendingTtlSeconds: TTL,
    principal: PRINCIPAL,
    usage: allowAllUsage(),
    providerKeyReady: async () => true,
    ...rest,
  };
  return { intake: readingIntakeFor(deps), reader, sent };
}

// Seeds a reading that owns its URL — a settled owner as
// submit/import/reprocess would find it.
async function writeOwnedReading(
  reader: TestReadings,
  url: string,
  overrides: Partial<Manifest> = {},
) {
  const urlHash = await sha256Hex(url);
  const id = overrides.id ?? "rd_OWNER";
  const createdAt = overrides.created_at ?? NOW;
  const keyPrefix = buildKeyPrefix(id, createdAt);
  const manifest: Manifest = {
    source_type: "url",
    status: "ready",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
    // Identity fields are authoritative; overrides must not desync them.
    id,
    url,
    url_hash: urlHash,
  };
  await reader.seed(manifest, { keyPrefix });
  return { id, urlHash, keyPrefix, manifest };
}

describe("ReadingIntake.submit", () => {
  it("activates a new reading for an unclaimed url and enqueues under the principal's envelope", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/new";

    const out = await intake.submit(url, { email: false });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    if (out.kind !== "activated") throw new Error("unreachable");
    const manifest = await reader.store.loadReadingById(out.id);
    expect(manifest?.manifest).toMatchObject({ status: "pending", url, source_type: "url" });
    await expect(reader.urlOwnerId(url)).resolves.toBe(out.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      version: 1,
      tenant: { tenantId: PRINCIPAL.tenantId },
      job: { url, trigger: "submit", email: false },
    });
  });

  it("reports queue_unbound without claiming the url slot", async () => {
    const { intake, reader } = await makeIntake({ queue: null });
    const url = "https://example.com/no-queue";

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "unavailable", reason: "queue_unbound" });
    // The eager claim must not have happened — a retry after the queue binding
    // returns should start from a clean slot.
    await expect(reader.urlOwnerId(url)).resolves.toBeNull();
  });

  it("returns the existing manifest for a ready owner", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/ready-owner";
    const owner = await writeOwnedReading(reader, url, { id: "rd_READY", status: "ready" });

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "existing", manifest: owner.manifest });
    expect(sent).toHaveLength(0);
  });

  it("reprocesses a failed owner in place (same reading id, reprocess trigger)", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/failed-owner";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_FAILED",
      status: "failed",
      content_status: "failed",
      error: { code: "FetchTimeoutError", message: "timeout", failed_at: NOW, retryable: true },
    });

    const out = await intake.submit(url, { email: true });

    expect(out).toMatchObject({ kind: "activated", id: owner.id });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.job).toMatchObject({
      id: owner.id,
      trigger: "reprocess",
      sourceTypeOnFailure: "url",
      email: true,
    });
    const manifest = await reader.manifest(owner.id);
    expect(manifest).toMatchObject({ status: "pending" });
    expect(manifest?.active_attempt?.status).toBe("running");
  });

  it("claims the url afresh when its failed owner is purged before the start", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/failed-owner-purged";
    const owner = await writeOwnedReading(reader, url, { id: "rd_PURGED", status: "failed", content_status: "failed" });
    const start = reader.writer.startAttempt.bind(reader.writer);
    vi.spyOn(reader.writer, "startAttempt").mockImplementationOnce(async (...args) => {
      await reader.writer.purge(owner.id, () => false);
      return start(...args);
    });

    const out = await intake.submit(url, { email: true });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    if (out.kind !== "activated") throw new Error("unreachable");
    expect(out.id).not.toBe(owner.id);
    await expect(reader.urlOwnerId(url)).resolves.toBe(out.id);
    expect(sent.map((m) => m.job.trigger)).toEqual(["submit"]);
  });

  it("reports claim_contention when the claim keeps losing to an owner that is gone by the next look", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/claim-contended";
    // Every claim loses the unique key, and every re-resolve finds no owner: a
    // submit racing a purge, forever. Bounded, and retryable.
    const claim = vi.spyOn(reader.writer, "claimUrl").mockResolvedValue({ kind: "owned", ownerId: null });

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "unavailable", reason: "claim_contention" });
    expect(sent).toHaveLength(0);
    claim.mockRestore();
  });

});

describe("ReadingIntake.importMarkdown", () => {
  const MARKDOWN = "# Imported\n\nbody text";

  it("activates a markdown reading for an unclaimed url with eager artifacts", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/import-new";

    const out = await intake.importMarkdown(url, MARKDOWN, { title: "Imported", email: false });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    if (out.kind !== "activated") throw new Error("unreachable");
    const found = await reader.store.loadReadingById(out.id);
    expect(found?.manifest).toMatchObject({
      source_type: "markdown",
      title: "Imported",
      content_type: "text/markdown; charset=utf-8",
    });
    // Captured eagerly, under the attempt's own revision keys.
    expect(await reader.extractedText(out.id)).toBe(MARKDOWN);
    expect(await reader.rawText(out.id)).toBe(MARKDOWN);
    expect((await reader.store.contentKeys(out.id))!.rawKey).toBe(`${found!.keyPrefix}/revisions/${out.attemptId}/raw.md`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.job).toMatchObject({
      trigger: "import",
      source: { kind: "markdown", markdown: MARKDOWN, title: "Imported" },
    });
  });

  // Ordering pin: the content is in R2 before the row that points at it
  // commits, so no reader ever resolves keys whose objects never landed.
  it("writes the artifacts under the attempt's keys before the claim commits", async () => {
    const { intake, reader } = await makeIntake();
    const url = "https://example.com/import-order";
    const seenAtClaim: string[] = [];
    const claim = reader.writer.claimUrl.bind(reader.writer);
    vi.spyOn(reader.writer, "claimUrl").mockImplementationOnce(async (pending, keyPrefix, attempt) => {
      for (const key of [attempt.content!.rawKey, attempt.content!.extractedKey!]) {
        seenAtClaim.push((await (await reader.content.get(key))?.text()) ?? "(missing)");
      }
      return claim(pending, keyPrefix, attempt);
    });

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out.kind).toBe("activated");
    expect(seenAtClaim).toEqual([MARKDOWN, MARKDOWN]);
  });

  it("reports activation_failed, claims nothing and leaves no objects when the content write throws", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/import-put-fails";
    const put = reader.content.put.bind(reader.content);
    // The raw object lands; the extracted one does not.
    vi.spyOn(reader.content, "put").mockImplementationOnce(put).mockRejectedValueOnce(new Error("R2 put failed"));
    const claim = vi.spyOn(reader.writer, "claimUrl");

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out).toEqual({ kind: "unavailable", reason: "activation_failed" });
    expect(claim).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    await expect(reader.urlOwnerId(url)).resolves.toBeNull();
    expect((await env.READINGS_BUCKET.list()).objects).toEqual([]);
  });

  it("sweeps the artifacts it wrote when the claim loses to a concurrent owner", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/import-lost-claim";
    const claim = reader.writer.claimUrl.bind(reader.writer);
    // Another submission of the same URL wins between the artifact writes
    // and this claim; the next pass finds that owner ready and returns it.
    vi.spyOn(reader.writer, "claimUrl").mockImplementationOnce(async (pending, keyPrefix, attempt) => {
      await writeOwnedReading(reader, url, { id: "rd_WINNER", status: "ready" });
      return claim(pending, keyPrefix, attempt);
    });

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out).toMatchObject({ kind: "existing", manifest: { id: "rd_WINNER" } });
    expect(sent).toHaveLength(0);
    expect((await env.READINGS_BUCKET.list()).objects).toEqual([]);
  });

  it("leaves a failed owner untouched when a re-import's content write throws", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/import-over-put-fails";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_FAILED",
      status: "failed",
      content_status: "failed",
      error: { code: "FetchTimeoutError", message: "timeout", failed_at: NOW, retryable: true },
    });
    vi.spyOn(reader.content, "put").mockRejectedValue(new Error("R2 put failed"));

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out).toEqual({ kind: "unavailable", reason: "activation_failed", id: owner.id });
    expect(sent).toHaveLength(0);
    expect(await reader.manifest(owner.id)).toEqual(owner.manifest);
    expect(await reader.content.list(owner.keyPrefix)).toEqual([]);
  });

  it("returns the existing manifest for a ready owner without re-importing", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/import-ready";
    const owner = await writeOwnedReading(reader, url, { id: "rd_READY", status: "ready" });

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out).toEqual({ kind: "existing", manifest: owner.manifest });
    expect(sent).toHaveLength(0);
  });

  it("re-imports a failed owner in place, clearing its error and falling back to the stored title", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/import-failed";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_FAILED",
      status: "failed",
      content_status: "failed",
      title: "Prior title",
      error: { code: "FetchTimeoutError", message: "timeout", failed_at: NOW, retryable: true },
    });

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out).toMatchObject({ kind: "activated", id: owner.id });
    const manifest = await reader.manifest(owner.id);
    expect(manifest).toMatchObject({
      status: "pending",
      source_type: "markdown",
      title: "Prior title",
    });
    expect(manifest?.error).toBeUndefined();
    expect(sent[0]!.job).toMatchObject({
      id: owner.id,
      trigger: "import",
      source: { kind: "markdown", markdown: MARKDOWN, title: "Prior title" },
    });
  });
});

describe("ReadingIntake.reprocess", () => {
  it("reports not_found for an unknown id", async () => {
    const { intake } = await makeIntake();
    await expect(intake.reprocess("rd_MISSING", { email: false })).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("refuses a reading with a fresh running attempt unless forced", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/reprocess-running";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_RUNNING",
      status: "pending",
      active_attempt: {
        id: "at_RUNNING",
        trigger: "submit",
        status: "running",
        stage: "summarize",
        started_at: NOW,
      },
    });

    await expect(intake.reprocess(owner.id, { email: false })).resolves.toEqual({
      kind: "conflict",
      reason: "active_attempt",
    });
    expect(sent).toHaveLength(0);

    const forced = await intake.reprocess(owner.id, { force: true, email: false });
    expect(forced).toMatchObject({ kind: "activated", id: owner.id });
    expect(sent).toHaveLength(1);
  });

  it("synthesizes the stored markdown for a source-less reprocess of a markdown reading", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/reprocess-markdown";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_MD",
      status: "failed",
      source_type: "markdown",
      title: "Stored title",
    });
    await reader.content.put(`${owner.keyPrefix}/extracted.md`, "# Stored\n\nstored body", "text/markdown; charset=utf-8");

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toMatchObject({ kind: "activated", id: owner.id });
    expect(sent[0]!.job).toMatchObject({
      trigger: "reprocess",
      sourceTypeOnFailure: "markdown",
      source: { kind: "markdown", markdown: "# Stored\n\nstored body", title: "Stored title" },
    });
  });

  it("reports missing_markdown when a markdown reading has no stored extraction", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/reprocess-markdown-missing";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_MDGONE",
      status: "failed",
      source_type: "markdown",
    });

    await expect(intake.reprocess(owner.id, { email: false })).resolves.toEqual({
      kind: "conflict",
      reason: "missing_markdown",
    });
    expect(sent).toHaveLength(0);
  });

  it("keeps a ready reading ready while it reprocesses, carrying no snapshot in the message", async () => {
    const { intake, reader, sent } = await makeIntake();
    const url = "https://example.com/reprocess-ready";
    const owner = await writeOwnedReading(reader, url, { id: "rd_READY", status: "ready" });

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toMatchObject({ kind: "activated", id: owner.id, status: "ready" });
    // Revisions keep the published state; the queue message has none to carry.
    expect(sent[0]!.job).not.toHaveProperty("preserveReadyManifest");
    const manifest = await reader.manifest(owner.id);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.active_attempt?.status).toBe("running");
  });

  it("reports queue_unbound after the conflict checks", async () => {
    const { reader } = await makeIntake();
    const url = "https://example.com/reprocess-no-queue";
    const owner = await writeOwnedReading(reader, url, { id: "rd_NOQ", status: "failed" });
    const { intake } = await makeIntake({ reader, queue: null });

    await expect(intake.reprocess(owner.id, { email: false })).resolves.toEqual({
      kind: "unavailable",
      reason: "queue_unbound",
    });
  });
});

// The extractor's safe-fetch guard (assertSafeUrl) rejects some URLs
// categorically — userinfo, blocked literal hosts — as its first step.
// Intake applies the same predicate before claiming a by-url slot or
// starting an attempt, so a doomed URL never takes the slot (issue #262).
describe("ReadingIntake safe-url guard", () => {
  const CREDS_URL = "https://user:secretpass@example.com/creds";

  it("rejects a userinfo url on submit without claiming the by-url slot", async () => {
    const { intake, reader, sent } = await makeIntake();

    const out = await intake.submit(CREDS_URL, { email: false });

    expect(out).toMatchObject({
      kind: "invalid_url",
      reason: expect.stringContaining("userinfo"),
    });
    expect(sent).toHaveLength(0);
    // Nothing was written: no row, no URL ownership, no object.
    expect(await reader.ids()).toEqual([]);
    const { objects } = await env.READINGS_BUCKET.list();
    expect(objects).toHaveLength(0);
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://localhost/x",
    "http://[::1]/x",
    "http://10.0.0.5/x",
  ])("rejects the blocked literal host %s on submit before any claim", async (url) => {
    const { intake, sent } = await makeIntake();

    const out = await intake.submit(url, { email: false });

    expect(out).toMatchObject({
      kind: "invalid_url",
      reason: expect.stringContaining("private/loopback"),
    });
    expect(sent).toHaveLength(0);
    const { objects } = await env.READINGS_BUCKET.list();
    expect(objects).toHaveLength(0);
  });

  it("still activates a safe url with a port", async () => {
    const { intake, sent } = await makeIntake();

    const out = await intake.submit("https://example.com:8443/ported", { email: false });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    expect(sent).toHaveLength(1);
  });

  it("rejects a URL-backed reprocess of a stored userinfo url without flipping the manifest", async () => {
    const { intake, reader, sent } = await makeIntake();
    const owner = await writeOwnedReading(reader, CREDS_URL, { id: "rd_CREDS", status: "ready" });

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toMatchObject({
      kind: "invalid_url",
      reason: expect.stringContaining("userinfo"),
    });
    expect(sent).toHaveLength(0);
    const manifest = await reader.manifest(owner.id);
    expect(manifest).toMatchObject({ status: "ready" });
    expect(manifest?.active_attempt).toBeUndefined();
  });

  it("allows a markdown-supplied reprocess of a stored userinfo url", async () => {
    const { intake, reader, sent } = await makeIntake();
    const owner = await writeOwnedReading(reader, CREDS_URL, { id: "rd_CREDS2", status: "ready" });

    const out = await intake.reprocess(owner.id, {
      email: false,
      source: { kind: "markdown", markdown: "# Fresh\n\nsupplied body" },
    });

    expect(out).toMatchObject({ kind: "activated", id: owner.id });
    expect(sent[0]!.job).toMatchObject({ source: { kind: "markdown" } });
  });

  it("allows a stored-markdown reprocess of a userinfo url", async () => {
    const { intake, reader, sent } = await makeIntake();
    const owner = await writeOwnedReading(reader, CREDS_URL, {
      id: "rd_CREDS3",
      status: "failed",
      source_type: "markdown",
      title: "Stored title",
    });
    await reader.content.put(`${owner.keyPrefix}/extracted.md`, "# Stored\n\nstored body", "text/markdown; charset=utf-8");

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toMatchObject({ kind: "activated", id: owner.id });
    expect(sent[0]!.job).toMatchObject({ source: { kind: "markdown" } });
  });

  it("accepts a userinfo source_url on import because imports never fetch it", async () => {
    const { intake, reader, sent } = await makeIntake();

    const out = await intake.importMarkdown(CREDS_URL, "# Imported\n\nbody", { email: false });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    if (out.kind !== "activated") throw new Error("unreachable");
    expect(sent).toHaveLength(1);
    const found = await reader.store.loadReadingById(out.id);
    expect(found?.manifest).toMatchObject({ url: CREDS_URL, source_type: "markdown" });
  });

  it("returns the existing manifest when a ready userinfo owner already holds the url", async () => {
    const { intake, reader, sent } = await makeIntake();
    const owner = await writeOwnedReading(reader, CREDS_URL, {
      id: "rd_CREDS_READY",
      status: "ready",
      source_type: "markdown",
    });

    const out = await intake.submit(CREDS_URL, { email: false });

    expect(out).toEqual({ kind: "existing", manifest: owner.manifest });
    expect(sent).toHaveLength(0);
  });

  it("returns the existing pending manifest for a userinfo import owner, not 400", async () => {
    const { intake, sent } = await makeIntake();
    const imported = await intake.importMarkdown(CREDS_URL, "# Imported\n\nbody", { email: false });
    if (imported.kind !== "activated") throw new Error("unreachable");

    const out = await intake.submit(CREDS_URL, { email: false });

    expect(out).toMatchObject({
      kind: "existing",
      manifest: { id: imported.id, status: "pending" },
    });
    expect(sent).toHaveLength(1);
  });

  it("returns invalid_url when a failed URL-backed userinfo owner is resubmitted, without a doomed reprocess", async () => {
    const { intake, reader, sent } = await makeIntake();
    const owner = await writeOwnedReading(reader, CREDS_URL, {
      id: "rd_CREDS_FAILED",
      status: "failed",
      content_status: "failed",
      error: { code: "BadStatusError", message: "bad response status 404", failed_at: NOW, retryable: false },
    });

    const out = await intake.submit(CREDS_URL, { email: false });

    expect(out).toMatchObject({ kind: "invalid_url", reason: expect.stringContaining("userinfo") });
    expect(sent).toHaveLength(0);
    const manifest = await reader.manifest(owner.id);
    expect(manifest?.status).toBe("failed");
  });

  it("counts a rejected submit against the request-rate admission", async () => {
    const usage = recordingUsage();
    const { intake } = await makeIntake({ usage });

    const out = await intake.submit(CREDS_URL, { email: false });

    expect(out).toMatchObject({ kind: "invalid_url" });
    expect(usage.ops).toEqual(["admit"]);
  });
});

function recordingUsage(): TenantUsage & { ops: string[] } {
  const ops: string[] = [];
  return {
    ops,
    admitRequest: async () => {
      ops.push("admit");
      return { ok: true };
    },
    reserveReading: async (opId) => {
      ops.push(`reserve:${opId}`);
      return { ok: true };
    },
    releaseReading: async (opId) => {
      ops.push(`release:${opId}`);
    },
    commitReading: async (opId) => {
      ops.push(`commit:${opId}`);
      return {ok:true};
    },
    acquireLease: async () => ({ ok: true, fence: "test-fence", alreadyRunning: false, expiresAtMs: 0 }),
    renewLease: async () => ({ ok: true, fence: "test-fence", alreadyRunning: false, expiresAtMs: 0 }),
    pauseLease: async () => ({ ok: true, fence: "test-fence", alreadyRunning: false, expiresAtMs: 0 }),
    releaseLease: async () => undefined,
    refreshReading: async () => undefined,
  };
}

describe("ReadingIntake usage quotas", () => {
  it("does not reserve a reading slot for a ready or pending owner", async () => {
    const usage = recordingUsage();
    const { intake, reader } = await makeIntake({ usage });
    const url = "https://example.com/quota-ready";
    await writeOwnedReading(reader, url, { id: "rd_QREADY", status: "ready" });

    const out = await intake.submit(url, { email: false });

    expect(out.kind).toBe("existing");
    expect(usage.ops).toEqual(["admit"]);
  });

  it("does not reserve a reading slot for an active-attempt conflict", async () => {
    const usage = recordingUsage();
    const { intake, reader } = await makeIntake({ usage });
    const url = "https://example.com/quota-conflict";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_QBUSY",
      status: "pending",
      active_attempt: {
        id: "at_QBUSY",
        trigger: "submit",
        status: "running",
        stage: "summarize",
        started_at: NOW,
      },
    });

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toEqual({ kind: "conflict", reason: "active_attempt" });
    expect(usage.ops).toEqual(["admit"]);
  });

  it("reserves a reading slot when re-activating a failed owner in place", async () => {
    const usage = recordingUsage();
    const { intake, reader } = await makeIntake({ usage });
    const url = "https://example.com/quota-failed";
    await writeOwnedReading(reader, url, {
      id: "rd_QFAIL",
      status: "failed",
      content_status: "failed",
      error: { code: "FetchTimeoutError", message: "timeout", failed_at: NOW, retryable: true },
    });

    const out = await intake.submit(url, { email: false });

    expect(out.kind).toBe("activated");
    expect(usage.ops[0]).toBe("admit");
    expect(usage.ops.some((op) => op.startsWith("reserve:"))).toBe(true);
    expect(usage.ops.some((op) => op.startsWith("release:"))).toBe(false);
  });

  it("releases a reserved slot when queue send fails", async () => {
    const usage = recordingUsage();
    const queue = {
      send: async () => {
        throw new Error("queue send failed");
      },
    } as unknown as Queue<ProcessReadingEnvelopeV1>;
    const { intake } = await makeIntake({ usage, queue });

    const out = await intake.submit("https://example.com/quota-send-fail", { email: false });

    expect(out).toMatchObject({ kind: "unavailable", reason: "queue_send_failed" });
    expect(usage.ops.some((op) => op.startsWith("reserve:"))).toBe(true);
    expect(usage.ops.some((op) => op.startsWith("release:"))).toBe(true);
  });

  it("releases a reserved slot when the activation rollback write throws", async () => {
    const usage = recordingUsage();
    const queue = {
      send: async () => {
        throw new Error("queue send failed");
      },
    } as unknown as Queue<ProcessReadingEnvelopeV1>;
    const { intake, reader } = await makeIntake({ usage, queue });
    vi.spyOn(reader.writer, "failActivation").mockRejectedValue(new Error("rollback write failed"));

    await expect(
      intake.submit("https://example.com/quota-rollback-throw", { email: false }),
    ).rejects.toThrow("rollback write failed");
    expect(usage.ops.some((op) => op.startsWith("reserve:"))).toBe(true);
    expect(usage.ops.some((op) => op.startsWith("release:"))).toBe(true);
  });

  it("returns rate_limited without claiming when admitRequest denies, before url validation", async () => {
    const usage: TenantUsage = {
      ...allowAllUsage(),
      admitRequest: async () => ({ ok: false, reason: "request_rate", resetAtMs: Date.parse(NOW) + 60_000 }),
    };
    const { intake, reader } = await makeIntake({ usage });
    // Credentialed (unfetchable) url: admission is denied before the url would
    // have been rejected as invalid_url.
    const url = "https://user:secretpass@example.com/quota-rate";

    const out = await intake.submit(url, { email: false });

    expect(out).toEqual({
      kind: "rate_limited",
      limit: "request_rate",
      resetAtMs: Date.parse(NOW) + 60_000,
    });
    await expect(reader.urlOwnerId(url)).resolves.toBeNull();
  });

  it("returns quota_exhausted without claiming when reserve denies", async () => {
    const usage: TenantUsage = {
      ...allowAllUsage(),
      reserveReading: async () => ({ ok: false, reason: "monthly", resetAtMs: Date.parse(NOW) + 86_400_000 }),
    };
    const { intake, reader } = await makeIntake({ usage });
    const url = "https://example.com/quota-month";

    const out = await intake.submit(url, { email: false });

    expect(out).toEqual({
      kind: "quota_exhausted",
      limit: "monthly",
      resetAtMs: Date.parse(NOW) + 86_400_000,
    });
    await expect(reader.urlOwnerId(url)).resolves.toBeNull();
  });

  it("releases a reserved slot when claim stays contended", async () => {
    const usage = recordingUsage();
    const { intake, reader } = await makeIntake({ usage });
    const url = "https://example.com/quota-contended";
    const cas = vi.spyOn(reader.writer, "claimUrl").mockResolvedValue({ kind: "owned", ownerId: null });

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "unavailable", reason: "claim_contention" });
    const reserved = usage.ops.filter((op) => op.startsWith("reserve:"));
    const released = usage.ops.filter((op) => op.startsWith("release:"));
    expect(reserved.length).toBeGreaterThan(0);
    expect(released).toEqual(reserved.map((op) => op.replace("reserve:", "release:")));
    cas.mockRestore();
  });

  it("fails closed when the usage guard is unavailable", async () => {
    const usage: TenantUsage = {
      ...allowAllUsage(),
      admitRequest: async () => ({ ok: false, reason: "unavailable" }),
    };
    const { intake } = await makeIntake({ usage });
    await expect(intake.submit("https://example.com/quota-guard", { email: false })).resolves.toEqual({
      kind: "guard_unavailable",
    });
  });
});

describe("ReadingIntake provider key gate", () => {
  it.each(["submit", "importMarkdown"] as const)(
    "refuses %s of a new url without claiming or reserving it when no key is ready",
    async (verb) => {
      const usage = recordingUsage();
      const { intake, reader, sent } = await makeIntake({ usage, providerKeyReady: async () => false });
      const url = `https://example.com/no-key-${verb}`;

      const out =
        verb === "submit"
          ? await intake.submit(url, { email: false })
          : await intake.importMarkdown(url, "# Supplied\n\nBody.", { email: false });

      expect(out).toEqual({ kind: "provider_key_required" });
      expect(usage.ops).toEqual(["admit"]);
      expect(sent).toHaveLength(0);
      await expect(reader.urlOwnerId(url)).resolves.toBeNull();
    },
  );

  it("refuses a reprocess without starting an attempt when no key is ready", async () => {
    const usage = recordingUsage();
    const { intake, reader, sent } = await makeIntake({ usage, providerKeyReady: async () => false });
    const owner = await writeOwnedReading(reader, "https://example.com/no-key-reprocess", {
      id: "rd_NOKEY",
      status: "failed",
      content_status: "failed",
      error: { code: "provider_key_required", message: "connect a key, then retry", failed_at: NOW, retryable: false },
    });

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toEqual({ kind: "provider_key_required" });
    expect(usage.ops).toEqual(["admit"]);
    expect(sent).toHaveLength(0);
    const after = await reader.store.loadReadingById(owner.id);
    expect(after?.manifest).toMatchObject({ status: "failed", error: { code: "provider_key_required" } });
    expect(after?.manifest.active_attempt).toBeUndefined();
  });
});
