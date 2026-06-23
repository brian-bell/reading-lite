import { describe, expect, it, vi } from "vitest";
import {
  prepareFreshMarkdown,
  type FreshMarkdownArticle,
  type PrepareFreshDeps,
} from "../../../../scripts/corpus-lib/batch/prepare-fresh-markdown";
import { ManifestSchema, type Manifest } from "../../../../src/schemas/manifest";

const NOW = "2026-06-22T12:00:00.000Z";

// Deterministic, schema-valid (64 lowercase hex) stand-in for sha256. Shared by
// the fake deps and the manifest fixtures so a healthy owner satisfies the real
// invariant url_hash === sha256(url).
function fakeSha(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function article(over: Partial<FreshMarkdownArticle> = {}): FreshMarkdownArticle {
  return {
    sourceUrl: "https://example.com/a",
    markdown: "# A\n\n**Source:** https://example.com/a\n\nbody",
    title: "A",
    ...over,
  };
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  const url = over.url ?? "https://example.com/a";
  return {
    id: "rd_existing",
    url,
    url_hash: fakeSha(url),
    source_type: "url",
    status: "failed",
    content_type: "text/html",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...over,
  } as Manifest;
}

// Deterministic ids + a stable url-hash so assertions are simple.
function makeDeps(over: Partial<PrepareFreshDeps> = {}): PrepareFreshDeps {
  let n = 0;
  return {
    readByUrlPointer: vi.fn(async () => null),
    readManifest: vi.fn(async () => null),
    mintId: vi.fn(() => `rd_new${n++}`),
    now: () => NOW,
    sha256: vi.fn(async (input: string) => fakeSha(input)),
    ...over,
  };
}

describe("prepareFreshMarkdown", () => {
  it("mints a fresh target for an unclaimed URL", async () => {
    const deps = makeDeps();
    const { targets, skipped, dropped } = await prepareFreshMarkdown([article()], deps);

    expect(skipped).toHaveLength(0);
    expect(dropped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    const t = targets[0]!;
    expect(t.target.readingId).toBe("rd_new0");
    expect(t.target.url).toBe("https://example.com/a");
    expect(t.target.createdAt).toBe(NOW);
    expect(t.target.keyPrefix).toMatch(/^readings\/.*-rd_new0$/);
    expect(t.target.manifest.source_type).toBe("markdown");
    expect(t.markdown).toContain("body");
    expect(t.title).toBe("A");
  });

  it("builds a fresh ExtractedContent that carries the markdown as raw + extracted", async () => {
    const deps = makeDeps();
    const { targets } = await prepareFreshMarkdown([article({ markdown: "hello md" })], deps);
    const fresh = targets[0]!.fresh!;
    expect(fresh).toBeDefined();
    expect(fresh.content_type).toBe("text/markdown; charset=utf-8");
    expect(fresh.content_status).toBe("captured");
    expect(fresh.content_bytes).toBe(new TextEncoder().encode("hello md").byteLength);
    expect(new TextDecoder().decode(fresh.raw)).toBe("hello md");
    expect(fresh.markdown).toBe("hello md");
  });

  it("skips a ready owner (no re-summarize, no duplicate)", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      readManifest: vi.fn(async () => manifest({ status: "ready", content_status: "captured" })),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([
      { url: "https://example.com/a", reason: "already-ready" },
    ]);
  });

  it("skips a fresh pending owner (within TTL) with an in-flight warning", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      // updated_at == now, so well inside the pending TTL window.
      readManifest: vi.fn(async () => manifest({ status: "pending", updated_at: NOW })),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([
      { url: "https://example.com/a", reason: "pending-in-flight" },
    ]);
  });

  it("re-ingests a STALE pending owner in place (matches the worker's read-time staleness rule)", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_stranded", key_prefix: "readings/kp-stranded" })),
      // updated_at far in the past → past PENDING_TTL → stranded, must re-ingest.
      readManifest: vi.fn(async () =>
        manifest({
          id: "rd_stranded",
          status: "pending",
          updated_at: "2026-01-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    const t = targets[0]!.target;
    expect(t.readingId).toBe("rd_stranded");
    expect(t.keyPrefix).toBe("readings/kp-stranded");
    expect(t.urlHash).toBe(fakeSha("https://example.com/a"));
  });

  it("honors a custom pendingTtlSeconds when deciding pending staleness", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      // 10 minutes old; with a 5s TTL it is stale and re-ingests.
      readManifest: vi.fn(async () => manifest({ status: "pending", updated_at: "2026-06-22T11:50:00.000Z" })),
      pendingTtlSeconds: 5,
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
  });

  it("re-ingests a failed owner in place, reusing its id/key_prefix/created_at", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_existing", key_prefix: "readings/kp-existing" })),
      readManifest: vi.fn(async () =>
        manifest({ id: "rd_existing", status: "failed", created_at: "2025-12-01T00:00:00.000Z" }),
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    const t = targets[0]!.target;
    expect(t.readingId).toBe("rd_existing");
    expect(t.keyPrefix).toBe("readings/kp-existing");
    expect(t.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect(t.urlHash).toBe(fakeSha("https://example.com/a"));
    // re-ingest must flip source_type to markdown even over a url failure
    expect(t.manifest.source_type).toBe("markdown");
    expect(t.manifest.status).not.toBe("ready");
  });

  it("does not trust a damaged pointer that resolves to a DIFFERENT url's manifest", async () => {
    // index/by-url/{hash(A)} is damaged: it points at a manifest for URL B
    // (different id/url/url_hash). We must NOT skip A as ready, nor reuse B's
    // slot — mint a fresh slot for A so write-phase repairs the pointer.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_B", key_prefix: "readings/kp-B" })),
      readManifest: vi.fn(async () =>
        manifest({
          id: "rd_B",
          url: "https://example.com/OTHER",
          url_hash: "d".repeat(64),
          status: "ready",
        }),
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    const t = targets[0]!.target;
    // fresh id (minted), NOT rd_B; the by-url slot is A's own hash, not B's.
    expect(t.readingId).toBe("rd_new0");
    expect(t.keyPrefix).not.toBe("readings/kp-B");
    expect(t.urlHash).toBe(await deps.sha256("https://example.com/a"));
  });

  it("mints a fresh slot for an old/unparseable dangling pointer (manifest missing)", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_gone", key_prefix: "readings/kp-gone" })),
      readManifest: vi.fn(async () => null),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target.readingId).toBe("rd_new0");
  });

  it("skips a FRESH pointer-without-manifest as in-flight (worker grace window)", async () => {
    // pointer key prefix timestamp is ~1 min before NOW → still initializing.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_init", key_prefix: "readings/2026/06/22T115900Z-rd_init" })),
      readManifest: vi.fn(async () => null),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([{ url: "https://example.com/a", reason: "pending-in-flight" }]);
  });

  it("mints fresh for an OLD pointer-without-manifest (past the grace window)", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_old", key_prefix: "readings/2026/06/22T100000Z-rd_old" })),
      readManifest: vi.fn(async () => null),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
  });

  it("adopts (skips) a pointerless legacy READY reading from index/list.json", async () => {
    // No by-url pointer, but list.json resolves a ready reading for this URL —
    // and its manifest verifies (id/url/url_hash match), so we skip it.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => null),
      findListCandidates: vi.fn(async () => [{ id: "rd_legacy", key_prefix: "readings/kp-legacy" }]),
      readManifest: vi.fn(async () => manifest({ id: "rd_legacy", status: "ready" })),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([{ url: "https://example.com/a", reason: "already-ready" }]);
  });

  it("re-ingests a pointerless legacy FAILED reading in place (adopts, no duplicate)", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => null),
      findListCandidates: vi.fn(async () => [{ id: "rd_legacy", key_prefix: "readings/kp-legacy" }]),
      readManifest: vi.fn(async () => manifest({ id: "rd_legacy", status: "failed" })),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target.readingId).toBe("rd_legacy");
    expect(targets[0]!.target.keyPrefix).toBe("readings/kp-legacy");
  });

  it("mints fresh (does NOT skip) when a list.json row is stale — manifest deleted", async () => {
    // Finding: a stale index row whose manifest is gone must not silently drop the
    // import. The candidate's manifest read is null → no owner → mint.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => null),
      findListCandidates: vi.fn(async () => [{ id: "rd_legacy", key_prefix: "readings/kp-legacy" }]),
      readManifest: vi.fn(async () => null),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target.readingId).toBe("rd_new0");
  });

  it("mints fresh when a list.json row's manifest now points at a DIFFERENT url", async () => {
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => null),
      findListCandidates: vi.fn(async () => [{ id: "rd_legacy", key_prefix: "readings/kp-legacy" }]),
      readManifest: vi.fn(async () =>
        manifest({ id: "rd_legacy", status: "ready", url: "https://example.com/OTHER" }),
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target.readingId).toBe("rd_new0");
  });

  it("does not let a stale top candidate mask a valid lower-ranked owner", async () => {
    // Two list rows for the URL: the best-ranked (rd_stale) has a deleted manifest;
    // a lower-ranked (rd_valid) is a genuine ready owner. We must verify down the
    // list and skip on rd_valid rather than mint a duplicate.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => null),
      findListCandidates: vi.fn(async () => [
        { id: "rd_stale", key_prefix: "readings/kp-stale" },
        { id: "rd_valid", key_prefix: "readings/kp-valid" },
      ]),
      readManifest: vi.fn(async (kp: string) =>
        kp === "readings/kp-valid/manifest.json" || kp === "readings/kp-valid"
          ? manifest({ id: "rd_valid", status: "ready" })
          : null,
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([{ url: "https://example.com/a", reason: "already-ready" }]);
  });

  it("adopts a valid list owner when the by-url pointer is damaged (different url)", async () => {
    // index/by-url/{hash(A)} is damaged (points at URL B's manifest), but
    // index/list.json still has a genuine ready owner for A. The worker's repair
    // path deep-scans and adopts that legacy owner rather than minting a duplicate;
    // we must do the same — skip A as already-ready, never re-summarize.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_B", key_prefix: "readings/kp-B" })),
      findListCandidates: vi.fn(async () => [{ id: "rd_valid", key_prefix: "readings/kp-valid" }]),
      readManifest: vi.fn(async (kp: string) =>
        kp === "readings/kp-valid"
          ? manifest({ id: "rd_valid", status: "ready" })
          : manifest({ id: "rd_B", url: "https://example.com/OTHER", url_hash: "d".repeat(64), status: "ready" }),
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([{ url: "https://example.com/a", reason: "already-ready" }]);
  });

  it("re-ingests in place at a valid list owner's slot when the by-url pointer's manifest is missing", async () => {
    // Dangling by-url pointer (manifest gone), but list.json resolves a real failed
    // owner for the URL. Adopt that slot in place rather than mint a duplicate.
    const deps = makeDeps({
      readByUrlPointer: vi.fn(async () => ({ id: "rd_gone", key_prefix: "readings/2026/06/22T100000Z-rd_gone" })),
      findListCandidates: vi.fn(async () => [{ id: "rd_legacy", key_prefix: "readings/kp-legacy" }]),
      readManifest: vi.fn(async (kp: string) =>
        kp === "readings/kp-legacy" ? manifest({ id: "rd_legacy", status: "failed" }) : null,
      ),
    });
    const { targets, skipped } = await prepareFreshMarkdown([article()], deps);
    expect(skipped).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target.readingId).toBe("rd_legacy");
    expect(targets[0]!.target.keyPrefix).toBe("readings/kp-legacy");
  });

  it("produces a target whose synthetic manifest is schema-valid", async () => {
    const deps = makeDeps();
    const { targets } = await prepareFreshMarkdown([article()], deps);
    expect(() => ManifestSchema.parse(targets[0]!.target.manifest)).not.toThrow();
  });

  it("uses sha256(sourceUrl) for the by-url pointer lookup", async () => {
    const readByUrlPointer = vi.fn(async () => null);
    const deps = makeDeps({ readByUrlPointer });
    await prepareFreshMarkdown([article({ sourceUrl: "https://x.test/y" })], deps);
    const expectedHash = await deps.sha256("https://x.test/y");
    expect(readByUrlPointer).toHaveBeenCalledWith(expectedHash);
  });
});
