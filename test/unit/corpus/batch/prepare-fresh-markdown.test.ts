import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  prepareFreshMarkdown,
  tallyDispositions,
  type FreshDisposition,
  type FreshMarkdownDeps,
} from "../../../../scripts/corpus-lib/batch/prepare-fresh-markdown";
import type { MarkdownArticle } from "../../../../scripts/import-markdown-lib/parse";
import type { Manifest } from "../../../../src/schemas/manifest";

function article(over: Partial<MarkdownArticle> = {}): MarkdownArticle {
  const markdown = over.markdown ?? "# Title\n\n**Source:** https://example.com/a\n\nbody";
  return {
    filePath: `/tmp/${over.fileName ?? "a.md"}`,
    fileName: over.fileName ?? "a.md",
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    title: "Title",
    sourceUrl: "https://example.com/a",
    ...over,
  };
}

function hex(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

// In-memory deps: by-url pointers + manifests keyed the way R2 stores them.
// `cold` seeds the list-index cold lookup (the owner resolvable by URL when no
// live by-url pointer exists — e.g. a prior failed fresh ingest).
function deps(
  seed: {
    byUrl?: Record<string, { id: string; key_prefix: string } | "damaged">;
    manifests?: Record<string, Manifest>;
    cold?: Record<string, { id: string; key_prefix: string; manifest: Manifest }>;
  } = {},
): FreshMarkdownDeps & { ids: string[]; coldCalls: { url: string }[] } {
  const byUrl = seed.byUrl ?? {};
  const manifests = seed.manifests ?? {};
  const cold = seed.cold ?? {};
  let n = 0;
  const ids: string[] = [];
  const coldCalls: { url: string }[] = [];
  return {
    ids,
    coldCalls,
    async getByUrl(urlHash) {
      return byUrl[urlHash] ?? null;
    },
    async readManifest(keyPrefix) {
      return manifests[keyPrefix] ?? null;
    },
    async findReadingByUrl(url) {
      coldCalls.push({ url });
      return cold[url] ?? null;
    },
    newId() {
      const id = `rd_NEW${n++}`;
      ids.push(id);
      return id;
    },
    newAttemptId() {
      return "at_import_1";
    },
    now() {
      return "2026-06-22T00:00:00.000Z";
    },
  };
}

describe("prepareFreshMarkdown — unclaimed URL", () => {
  it("mints a new markdown ingest target with captured content descriptors", async () => {
    const a = article();
    const plan = await prepareFreshMarkdown([a], deps());

    expect(plan.toIngest).toHaveLength(1);
    const t = plan.toIngest[0]!;
    expect(t.target.readingId).toBe("rd_NEW0");
    expect(t.target.url).toBe("https://example.com/a");
    expect(t.target.urlHash).toBe(hex("https://example.com/a"));
    expect(t.target.createdAt).toBe("2026-06-22T00:00:00.000Z");
    expect(t.target).toMatchObject({
      attemptId: "at_import_1",
      attemptStartedAt: "2026-06-22T00:00:00.000Z",
      trigger: "import",
    });
    // key_prefix is the compact-timestamp layout the worker mints.
    expect(t.target.keyPrefix).toBe("readings/2026/06/22T000000Z-rd_NEW0");

    // The synthetic manifest the submit phase reads for source_type.
    expect(t.target.manifest.source_type).toBe("markdown");
    expect(t.target.manifest.status).not.toBe("ready"); // no roll-forward snapshot

    // Markdown is both the article text and the raw object to persist.
    expect(t.markdown).toBe(a.markdown);
    expect(t.title).toBe("Title");
    expect(t.fresh).toBeDefined();
    expect(t.fresh!.content_type).toBe("text/markdown; charset=utf-8");
    expect(t.fresh!.content_status).toBe("captured");
    expect(t.fresh!.content_bytes).toBe(a.bytes);
    expect(t.fresh!.content_sha256).toBe(
      createHash("sha256").update(a.markdown, "utf8").digest("hex"),
    );
    expect(new TextDecoder().decode(t.fresh!.raw)).toBe(a.markdown);

    expect(plan.dispositions).toHaveLength(1);
    expect(plan.dispositions[0]!.kind).toBe("ingest-new");
    expect(t.freshActivation).toEqual({ kind: "create-new" });
  });
});

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_OWNER",
    url: "https://example.com/a",
    url_hash: hex("https://example.com/a"),
    source_type: "markdown",
    status: "ready",
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

describe("prepareFreshMarkdown — existing owner", () => {
  it("skips a ready owner without re-summarizing", async () => {
    const a = article();
    const d = deps({
      byUrl: { [hex(a.sourceUrl!)]: { id: "rd_OWNER", key_prefix: "readings/kp-owner" } },
      manifests: { "readings/kp-owner": manifest({ status: "ready" }) },
    });
    const plan = await prepareFreshMarkdown([a], d);

    expect(plan.toIngest).toHaveLength(0);
    expect(d.ids).toHaveLength(0); // no new id minted
    expect(plan.dispositions).toEqual([
      { kind: "skip-ready", url: a.sourceUrl, id: "rd_OWNER", article: a },
    ]);
  });

  it("skips a pending owner, even a past-TTL one, to avoid racing an in-flight worker", async () => {
    const a = article();
    // A long-stale pending: still skipped — this offline path can't safely
    // supersede a queue worker that may still be running/redelivering.
    const d = deps({
      byUrl: { [hex(a.sourceUrl!)]: { id: "rd_OWNER", key_prefix: "readings/kp-owner" } },
      manifests: {
        "readings/kp-owner": manifest({
          status: "pending",
          created_at: "2025-12-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        }),
      },
    });
    const plan = await prepareFreshMarkdown([a], d);

    expect(plan.toIngest).toHaveLength(0);
    expect(d.ids).toHaveLength(0);
    expect(plan.dispositions[0]!.kind).toBe("skip-pending");
  });

  it("re-ingests a failed owner in place, preserving its id/key_prefix/created_at", async () => {
    const a = article();
    const d = deps({
      byUrl: { [hex(a.sourceUrl!)]: { id: "rd_OWNER", key_prefix: "readings/kp-owner" } },
      manifests: {
        "readings/kp-owner": manifest({
          id: "rd_OWNER",
          status: "failed",
          created_at: "2025-12-01T00:00:00.000Z",
        }),
      },
    });
    const plan = await prepareFreshMarkdown([a], d);

    expect(d.ids).toHaveLength(0); // reuse the claimed id, don't mint
    expect(plan.toIngest).toHaveLength(1);
    const t = plan.toIngest[0]!;
    expect(t.target.readingId).toBe("rd_OWNER");
    expect(t.target.keyPrefix).toBe("readings/kp-owner");
    expect(t.target.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect(plan.dispositions[0]!.kind).toBe("ingest-failed");
    expect(t.freshActivation).toMatchObject({
      kind: "verify-existing-failed",
      expected: {
        id: "rd_OWNER",
        keyPrefix: "readings/kp-owner",
        url: a.sourceUrl,
        urlHash: hex(a.sourceUrl!),
      },
    });
  });


  it("re-ingests a failed reading found only via the list index in place, not a duplicate", async () => {
    // A prior legacy failed ingest may have a by-id pointer + list row but no
    // by-url pointer. A rerun therefore sees getByUrl=null; without the cold
    // lookup it would mint a SECOND reading.
    const a = article();
    const d = deps({
      cold: {
        [a.sourceUrl!]: {
          id: "rd_OWNER",
          key_prefix: "readings/kp-owner",
          manifest: manifest({ id: "rd_OWNER", status: "failed", created_at: "2025-12-01T00:00:00.000Z" }),
        },
      },
    });
    const plan = await prepareFreshMarkdown([a], d);

    expect(d.ids).toHaveLength(0); // reuse the failed reading's id, don't mint
    expect(plan.toIngest).toHaveLength(1);
    const t = plan.toIngest[0]!;
    expect(t.target.readingId).toBe("rd_OWNER");
    expect(t.target.keyPrefix).toBe("readings/kp-owner");
    expect(t.target.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect(plan.dispositions[0]!.kind).toBe("ingest-failed");
    expect(t.freshActivation).toMatchObject({
      kind: "create-existing-failed",
      expected: {
        id: "rd_OWNER",
        keyPrefix: "readings/kp-owner",
        url: a.sourceUrl,
        urlHash: hex(a.sourceUrl!),
      },
    });
    // No pointer at all → plain cold lookup, no forced scan (a first-time URL
    // submit must not pay for a full bucket scan, matching the Worker).
    expect(d.coldCalls).toEqual([{ url: a.sourceUrl }]);
  });

  it("skips a ready reading found via the list index even without a by-url pointer", async () => {
    const a = article();
    const d = deps({
      cold: {
        [a.sourceUrl!]: {
          id: "rd_OWNER",
          key_prefix: "readings/kp-owner",
          manifest: manifest({ id: "rd_OWNER", status: "ready" }),
        },
      },
    });
    const plan = await prepareFreshMarkdown([a], d);

    expect(plan.toIngest).toHaveLength(0);
    expect(d.ids).toHaveLength(0);
    expect(plan.dispositions[0]!.kind).toBe("skip-ready");
  });

  it("mints a new reading when the cold lookup finds nothing", async () => {
    const a = article();
    const d = deps(); // findReadingByUrl returns null
    const plan = await prepareFreshMarkdown([a], d);

    expect(d.ids).toEqual(["rd_NEW0"]);
    expect(plan.dispositions[0]!.kind).toBe("ingest-new");
  });
});

describe("prepareFreshMarkdown — missing source", () => {
  it("skips an article with no source URL rather than minting", async () => {
    const a = article({ sourceUrl: undefined });
    const d = deps();
    const plan = await prepareFreshMarkdown([a], d);

    expect(plan.toIngest).toHaveLength(0);
    expect(d.ids).toHaveLength(0);
    expect(plan.dispositions).toEqual([{ kind: "skip-no-source", url: null, id: null, article: a }]);
  });
});

describe("tallyDispositions", () => {
  it("counts each disposition kind for plan reporting", () => {
    const a = article();
    const ds: FreshDisposition[] = [
      { kind: "ingest-new", url: "u", id: "1", article: a, target: {} as any },
      { kind: "ingest-new", url: "u", id: "2", article: a, target: {} as any },
      { kind: "ingest-failed", url: "u", id: "3", article: a, target: {} as any },
      { kind: "skip-ready", url: "u", id: "4", article: a },
      { kind: "skip-pending", url: "u", id: "5", article: a },
      { kind: "skip-occupied-needs-repair", url: "u", id: "7", article: a, reason: "occupied" },
      { kind: "skip-no-source", url: null, id: null, article: a },
    ];
    expect(tallyDispositions(ds)).toEqual({
      ingestNew: 2,
      ingestFailed: 1,
      skipReady: 1,
      skipPending: 1,
      skipInitializing: 0,
      skipOccupiedNeedsRepair: 1,
      skipNoSource: 1,
      toIngest: 3,
    });
  });
});
