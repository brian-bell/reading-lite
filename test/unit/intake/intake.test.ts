import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readingIntakeFor,
  type ReadingIntakeDeps,
} from "../../../src/intake";
import {
  buildKeyPrefix,
  ReadingStore,
} from "../../../src/modules/stores/reading-store";
import type { ProcessReadingEnvelopeV1 } from "../../../src/control-plane/envelope";
import { createApiTokenPrincipal } from "../../../src/control-plane/principal";
import type { Manifest } from "../../../src/schemas/manifest";
import { sha256Hex, type Services } from "../../../src/services";

// Reading intake's own test surface: the three verbs against a real R2-backed
// store and a capturing queue, asserting domain outcomes — no Hono, no HTTP.

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

function makeIntake(overrides: Partial<ReadingIntakeDeps> = {}) {
  const reader = new ReadingStore(env.READINGS_BUCKET);
  const { queue, sent } = captureQueue();
  const deps: ReadingIntakeDeps = {
    reader,
    queue,
    services: seqServices(),
    pendingTtlSeconds: TTL,
    principal: PRINCIPAL,
    ...overrides,
  };
  return { intake: readingIntakeFor(deps), reader, sent };
}

// Writes a manifest at its canonical key_prefix plus its by-url and by-id
// pointers — a settled owner as submit/import/reprocess would find it.
async function writeOwnedReading(
  reader: ReadingStore,
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
  await reader.writeManifest(keyPrefix, manifest);
  await reader.writeByUrlPointer(urlHash, { id, key_prefix: keyPrefix });
  await reader.writeByIdPointer(id, { id, key_prefix: keyPrefix });
  return { id, urlHash, keyPrefix, manifest };
}

describe("ReadingIntake.submit", () => {
  it("activates a new reading for an unclaimed url and enqueues under the principal's envelope", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/new";

    const out = await intake.submit(url, { email: false });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    if (out.kind !== "activated") throw new Error("unreachable");
    const manifest = await reader.loadReadingById(out.id);
    expect(manifest?.manifest).toMatchObject({ status: "pending", url, source_type: "url" });
    await expect(reader.readByUrlPointer(await sha256Hex(url))).resolves.toMatchObject({
      id: out.id,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      version: 1,
      tenant: { tenantId: PRINCIPAL.tenantId },
      job: { url, trigger: "submit", email: false },
    });
  });

  it("reports queue_unbound without claiming the url slot", async () => {
    const { intake, reader } = makeIntake({ queue: null });
    const url = "https://example.com/no-queue";

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "unavailable", reason: "queue_unbound" });
    // The eager claim must not have happened — a retry after the queue binding
    // returns should start from a clean slot.
    await expect(reader.readByUrlPointer(await sha256Hex(url))).resolves.toBeNull();
  });

  it("returns the existing manifest for a ready owner and writes its by-id pointer", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/ready-owner";
    const owner = await writeOwnedReading(reader, url, { id: "rd_READY", status: "ready" });
    // Drop the by-id pointer to prove submit restores it.
    await env.READINGS_BUCKET.delete(`index/by-id/${owner.id}`);

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "existing", manifest: owner.manifest });
    await expect(reader.readByIdPointer(owner.id)).resolves.toEqual({
      id: owner.id,
      key_prefix: owner.keyPrefix,
    });
    expect(sent).toHaveLength(0);
  });

  it("reprocesses a failed owner in place (same reading id, reprocess trigger)", async () => {
    const { intake, reader, sent } = makeIntake();
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
    const manifest = await reader.readManifest(owner.keyPrefix);
    expect(manifest).toMatchObject({ status: "pending" });
    expect(manifest?.active_attempt?.status).toBe("running");
  });

  it("reports a still-initializing owner instead of activating", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/initializing";
    // Fresh pointer (key_prefix minted NOW) with no manifest behind it yet.
    const pointer = { id: "rd_FRESH", key_prefix: buildKeyPrefix("rd_FRESH", NOW) };
    await reader.writeByUrlPointer(await sha256Hex(url), pointer);

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "initializing", id: "rd_FRESH" });
    expect(sent).toHaveLength(0);
  });

  it("reports claim_contention when the slot CAS never converges", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/claim-contended";
    // Damaged pointer occupying the slot (manifest never written, past grace).
    await reader.writeByUrlPointer(await sha256Hex(url), {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    const cas = vi.spyOn(reader, "replaceByUrlPointerIfCurrent").mockResolvedValue(false);

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "unavailable", reason: "claim_contention" });
    expect(sent).toHaveLength(0);
    cas.mockRestore();
  });

  it("reports owner_resolution_contention when resolution itself never converges", async () => {
    const { intake, reader } = makeIntake();
    const url = "https://example.com/resolve-contended";
    const urlHash = await sha256Hex(url);
    // A legacy manifest exists for the URL, so resolution keeps trying to
    // CAS-repair the damaged pointer onto it — and every CAS loses.
    const legacyPrefix = buildKeyPrefix("rd_LEGACY", NOW);
    await reader.writeManifest(legacyPrefix, {
      id: "rd_LEGACY",
      url,
      url_hash: urlHash,
      source_type: "url",
      status: "ready",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: NOW,
      updated_at: NOW,
    });
    await reader.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    const cas = vi.spyOn(reader, "replaceByUrlPointerIfCurrent").mockResolvedValue(false);

    const out = await intake.submit(url, { email: true });

    expect(out).toEqual({ kind: "unavailable", reason: "owner_resolution_contention" });
    cas.mockRestore();
  });
});

describe("ReadingIntake.importMarkdown", () => {
  const MARKDOWN = "# Imported\n\nbody text";

  it("activates a markdown reading for an unclaimed url with eager artifacts", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/import-new";

    const out = await intake.importMarkdown(url, MARKDOWN, { title: "Imported", email: false });

    expect(out).toMatchObject({ kind: "activated", status: "pending" });
    if (out.kind !== "activated") throw new Error("unreachable");
    const found = await reader.loadReadingById(out.id);
    expect(found?.manifest).toMatchObject({
      source_type: "markdown",
      title: "Imported",
      content_type: "text/markdown; charset=utf-8",
    });
    const extracted = await reader.readExtracted(found!.keyPrefix);
    expect(await extracted?.text()).toBe(MARKDOWN);
    const raw = await reader.readRaw(found!.keyPrefix, "md");
    expect(await raw?.text()).toBe(MARKDOWN);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.job).toMatchObject({
      trigger: "import",
      source: { kind: "markdown", markdown: MARKDOWN, title: "Imported" },
    });
  });

  it("returns the existing manifest for a ready owner without re-importing", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/import-ready";
    const owner = await writeOwnedReading(reader, url, { id: "rd_READY", status: "ready" });

    const out = await intake.importMarkdown(url, MARKDOWN, { email: false });

    expect(out).toEqual({ kind: "existing", manifest: owner.manifest });
    expect(sent).toHaveLength(0);
  });

  it("re-imports a failed owner in place, clearing its error and falling back to the stored title", async () => {
    const { intake, reader, sent } = makeIntake();
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
    const manifest = await reader.readManifest(owner.keyPrefix);
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
    const { intake } = makeIntake();
    await expect(intake.reprocess("rd_MISSING", { email: false })).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("refuses a reading with a fresh running attempt unless forced", async () => {
    const { intake, reader, sent } = makeIntake();
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
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/reprocess-markdown";
    const owner = await writeOwnedReading(reader, url, {
      id: "rd_MD",
      status: "failed",
      source_type: "markdown",
      title: "Stored title",
    });
    await reader.writeExtracted(owner.keyPrefix, "# Stored\n\nstored body");

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toMatchObject({ kind: "activated", id: owner.id });
    expect(sent[0]!.job).toMatchObject({
      trigger: "reprocess",
      sourceTypeOnFailure: "markdown",
      source: { kind: "markdown", markdown: "# Stored\n\nstored body", title: "Stored title" },
    });
  });

  it("reports missing_markdown when a markdown reading has no stored extraction", async () => {
    const { intake, reader, sent } = makeIntake();
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

  it("snapshots a ready manifest into preserveReadyManifest and keeps the stored copy ready", async () => {
    const { intake, reader, sent } = makeIntake();
    const url = "https://example.com/reprocess-ready";
    const owner = await writeOwnedReading(reader, url, { id: "rd_READY", status: "ready" });

    const out = await intake.reprocess(owner.id, { email: false });

    expect(out).toMatchObject({ kind: "activated", id: owner.id, status: "ready" });
    expect(sent[0]!.job.preserveReadyManifest).toMatchObject({ id: owner.id, status: "ready" });
    const manifest = await reader.readManifest(owner.keyPrefix);
    expect(manifest?.status).toBe("ready");
    expect(manifest?.active_attempt?.status).toBe("running");
  });

  it("reports queue_unbound after the conflict checks", async () => {
    const { reader } = makeIntake();
    const url = "https://example.com/reprocess-no-queue";
    const owner = await writeOwnedReading(reader, url, { id: "rd_NOQ", status: "failed" });
    const { intake } = makeIntake({ reader, queue: null });

    await expect(intake.reprocess(owner.id, { email: false })).resolves.toEqual({
      kind: "unavailable",
      reason: "queue_unbound",
    });
  });
});
