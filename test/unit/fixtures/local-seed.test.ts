import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLocalSeed,
  LOCAL_SEED_REMOVED_TARGET_ID,
  type LocalSeedObject,
} from "../../fixtures/local-seed";
import {
  applyStaleness,
} from "../../../src/modules/staleness";
import { manifestToIndexItem } from "../../../src/modules/stores/list-index";
import {
  ByUrlPointerSchema,
  ManifestSchema,
  ProcessingAttemptSchema,
  type Manifest,
} from "../../../src/schemas/manifest";
import { ListIndexSchema } from "../../../src/schemas/api";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";

const NOW = "2026-09-11T10:00:00.000Z";
const PENDING_TTL = 900;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function indexObjectsBySuffix(objects: LocalSeedObject[]): Map<string, LocalSeedObject> {
  return new Map(objects.map((o) => [o.key, o]));
}

describe("local seed fixture pack", () => {
  const plan = buildLocalSeed(NOW);
  const byKey = indexObjectsBySuffix(plan.objects);
  const manifests = plan.fixtures.map((f) => f.manifest);
  const byId = new Map(plan.fixtures.map((f) => [f.id, f]));

  it("names every acceptance-matrix state the issue lists", () => {
    const names = plan.fixtures.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "attention",
        "gardens",
        "friction",
        "sparse-archive",
        "unavailable-source",
        "degraded-youtube",
        "old-manifest",
        "long-title",
        "imported-markdown",
        "pending",
        "fail-source-unreachable",
        "fail-source-incomplete",
        "fail-provider-limit",
        "fail-provider-error",
        "fail-key-problem",
        "fail-hosting-limit",
        "fail-stopped",
        "fail-unknown",
      ]),
    );
    // One failed fixture per acceptance-matrix failure category, each with a
    // distinct code+stage signature the frontend mapping can pin.
    const failed = plan.fixtures.filter((f) => f.manifest.status === "failed");
    expect(failed).toHaveLength(8);
    expect(failed.map((f) => f.name)).toEqual([
      "fail-source-unreachable",
      "fail-source-incomplete",
      "fail-provider-limit",
      "fail-provider-error",
      "fail-key-problem",
      "fail-hosting-limit",
      "fail-stopped",
      "fail-unknown",
    ]);
    expect(
      failed.map((f) => `${f.manifest.error?.code}@${f.manifest.error?.stage}`),
    ).toEqual([
      "BadStatusError@fetch_source",
      "SourceRejectedError@summarize",
      "RateLimitedError@summarize",
      "BadStatusError@embed_source",
      "BadStatusError@summarize",
      "SpendAdmissionError@summarize",
      "QueueRetriesExhaustedError@summarize",
      "TypeError@query_similar",
    ]);
    for (const fixture of failed) {
      expect(fixture.manifest.last_attempt?.status).toBe("failed");
    }
  });

  it("produces manifests that all parse with the manifest zod schema", () => {
    for (const fixture of plan.fixtures) {
      const parsed = ManifestSchema.parse(fixture.manifest);
      expect(parsed.id).toBe(fixture.id);
    }
    // Independently: every manifest.json object body parses too.
    for (const object of plan.objects.filter((o) => o.key.endsWith("/manifest.json"))) {
      expect(() => ManifestSchema.parse(JSON.parse(object.body))).not.toThrow();
    }
  });

  it("writes each object key exactly once", () => {
    expect(new Set(plan.objects.map((o) => o.key)).size).toBe(plan.objects.length);
  });

  it("builds a valid list index whose rows match their manifests", () => {
    const listObject = byKey.get("index/list.json");
    expect(listObject).toBeDefined();
    const list = ListIndexSchema.parse(JSON.parse(listObject!.body));
    expect(list.items).toHaveLength(plan.fixtures.length);
    for (const fixture of plan.fixtures) {
      const row = list.items.find((i) => i.id === fixture.id);
      expect(row).toEqual(manifestToIndexItem(fixture.manifest, fixture.keyPrefix));
    }
  });

  it("seeds by-id and by-url pointers that agree with each manifest", () => {
    for (const fixture of plan.fixtures) {
      const byIdObject = byKey.get(`index/by-id/${fixture.id}`);
      expect(byIdObject).toBeDefined();
      expect(ByUrlPointerSchema.parse(JSON.parse(byIdObject!.body))).toEqual({
        id: fixture.id,
        key_prefix: fixture.keyPrefix,
      });

      const byUrlObject = byKey.get(`index/by-url/${urlHash(fixture.manifest.url)}`);
      expect(byUrlObject).toBeDefined();
      expect(ByUrlPointerSchema.parse(JSON.parse(byUrlObject!.body))).toEqual({
        id: fixture.id,
        key_prefix: fixture.keyPrefix,
      });
    }
  });

  it("keeps content hashes, byte counts, and artifacts consistent with the manifest", () => {
    for (const fixture of plan.fixtures) {
      const manifest: Manifest = fixture.manifest;
      if (manifest.status !== "ready") continue;
      const raw = plan.objects.find((o) => o.key.startsWith(`${fixture.keyPrefix}/raw.`));
      expect(raw).toBeDefined();
      expect(manifest.content_bytes).toBe(bytesOf(raw!.body));
      expect(manifest.content_sha256).toBe(sha256Hex(raw!.body));
      expect(raw!.contentType).toBe(manifest.content_type);

      const extracted = byKey.get(`${fixture.keyPrefix}/extracted.md`);
      if (manifest.content_status === "captured") {
        expect(extracted).toBeDefined();
        expect(manifest.extracted_bytes).toBe(bytesOf(extracted!.body));
      } else {
        expect(extracted).toBeUndefined();
        expect(manifest.extracted_bytes).toBeUndefined();
      }
    }
  });

  it("seeds attempt logs that parse and agree with the manifest", () => {
    for (const fixture of plan.fixtures) {
      const attemptKeys = plan.objects
        .map((o) => o.key)
        .filter((k) => k.startsWith(`${fixture.keyPrefix}/attempts/`));
      expect(attemptKeys).toHaveLength(1);
      const attempt = ProcessingAttemptSchema.parse(
        JSON.parse(byKey.get(attemptKeys[0]!)!.body),
      );
      expect(attempt.reading_id).toBe(fixture.id);
      expect(attempt.url).toBe(fixture.manifest.url);
      expect(attempt.url_hash).toBe(fixture.manifest.url_hash);
      expect(attempt.key_prefix).toBe(fixture.keyPrefix);

      const manifestAttempt = fixture.manifest.active_attempt ?? fixture.manifest.last_attempt;
      expect(manifestAttempt?.id).toBe(attempt.id);
      expect(manifestAttempt?.status).toBe(attempt.status);
      expect(manifestAttempt?.stage).toBe(attempt.stage);
    }
  });

  it("represents the sparse archive as similarity.count = 0 with no connections", () => {
    const sparse = byId.get("rd_FXSPARSE01")!.manifest;
    expect(sparse.similarity).toEqual({ count: 0, computed_at: sparse.similarity?.computed_at });
    expect(sparse.similarity?.max).toBeUndefined();
    expect(sparse.similarity?.mean).toBeUndefined();
    expect(sparse.connections).toEqual([]);
    expect(sparse.novelty_verdict).toBe("novel");
  });

  it("represents the unavailable source as raw_only with no extracted artifact", () => {
    const unavailable = byId.get("rd_FXRAWSRC01")!.manifest;
    expect(unavailable.content_status).toBe("raw_only");
    expect(plan.objects.some((o) => o.key === `${byId.get("rd_FXRAWSRC01")!.keyPrefix}/extracted.md`)).toBe(false);
    expect(unavailable.title).toBeDefined();
    expect(unavailable.summary_markdown).toBeDefined();
  });

  it("represents degraded YouTube with a transcript-tier enrichment degradation", () => {
    const youtube = byId.get("rd_FXYTDEGRD1")!.manifest;
    expect(youtube.enrichment_degradation).toEqual({
      source: "youtube",
      tier: "transcript",
      code: "YoutubeEnrichmentParseError",
      message: "timedtext response was empty or unparseable",
    });
    expect(youtube.status).toBe("ready");
  });

  it("represents the old manifest without similarity, verdict, or connections date", () => {
    const old = byId.get("rd_FXPAST0001")!.manifest;
    expect(old.similarity).toBeUndefined();
    expect(old.novelty_verdict).toBeUndefined();
    expect(old.connections_computed_at).toBeUndefined();
    // Legacy usage arm (pre-v2 shape).
    expect(old.usage).toEqual({
      anthropic_input_tokens: 12840,
      anthropic_output_tokens: 733,
      openai_embedding_tokens: 1902,
    });
  });

  it("carries the 130-character long title verbatim, past the summarizer's 120-char cap", () => {
    const longTitle = byId.get("rd_FXMAXNAME1")!.manifest;
    expect(longTitle.title!.length).toBe(130);
    expect(longTitle.title).toBe(
      "What we lose when every tool for thinking becomes a place to organize, optimize, and measure the work instead of actually doing it",
    );
  });

  it("marks the imported Markdown fixture as a markdown source", () => {
    const markdown = byId.get("rd_FXMDPAGE01")!.manifest;
    expect(markdown.source_type).toBe("markdown");
    expect(markdown.content_type).toBe("text/markdown; charset=utf-8");
    expect(markdown.last_attempt?.trigger).toBe("import");
  });

  it("stamps the pending fixture from the seed clock so staleness does not flip it", () => {
    const pending = byId.get("rd_FXPENDNG01")!.manifest;
    expect(pending.status).toBe("pending");
    expect(pending.active_attempt?.status).toBe("running");
    expect(pending.created_at).toBe(NOW);
    expect(applyStaleness(pending, PENDING_TTL, NOW).status).toBe("pending");
    const row = manifestToIndexItem(pending, byId.get("rd_FXPENDNG01")!.keyPrefix);
    expect(applyStaleness(row, PENDING_TTL, NOW).status).toBe("pending");
  });

  it("references the removed target in a connection but never writes it", () => {
    const attention = byId.get("rd_FXATTENT01")!.manifest;
    expect(
      attention.connections?.some((c) => c.id === LOCAL_SEED_REMOVED_TARGET_ID),
    ).toBe(true);
    expect(byId.has(LOCAL_SEED_REMOVED_TARGET_ID)).toBe(false);
    expect(
      plan.objects.some(
        (o) => o.key === `index/by-id/${LOCAL_SEED_REMOVED_TARGET_ID}`,
      ),
    ).toBe(false);
    expect(
      plan.listIndex.items.some((i) => i.id === LOCAL_SEED_REMOVED_TARGET_ID),
    ).toBe(false);
  });

  it("points every relationship target at a seeded fixture or the removed id", () => {
    const seededIds = new Set(plan.fixtures.map((f) => f.id));
    for (const fixture of plan.fixtures) {
      for (const connection of fixture.manifest.connections ?? []) {
        expect(
          seededIds.has(connection.id) || connection.id === LOCAL_SEED_REMOVED_TARGET_ID,
        ).toBe(true);
      }
      for (const tension of fixture.manifest.tensions ?? []) {
        expect(seededIds.has(tension.id)).toBe(true);
      }
    }
    // Gardens targets one pending and one failed reading (non-ready targets).
    const gardens = byId.get("rd_FXGARDEN01")!.manifest;
    const targetStatuses = (gardens.connections ?? [])
      .map((c) => byId.get(c.id)?.manifest.status)
      .filter((s) => s !== undefined);
    expect(targetStatuses).toContain("pending");
    expect(targetStatuses).toContain("failed");
  });

  it("uses only fictional hosts and the reserved fixture video id", () => {
    for (const manifest of manifests) {
      const url = new URL(manifest.url);
      if (url.hostname === "www.youtube.com") {
        expect(url.searchParams.get("v")).toBe("FxFixture01");
        continue;
      }
      expect(url.hostname.endsWith(".example")).toBe(true);
    }
  });
});
