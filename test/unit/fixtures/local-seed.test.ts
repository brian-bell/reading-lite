import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLocalSeed,
  LOCAL_SEED_REMOVED_TARGET_ID,
  type LocalSeedFixture,
  type LocalSeedObject,
} from "../../fixtures/local-seed";
import {
  applyStaleness,
} from "../../../src/modules/staleness";
import { manifestToIndexItem } from "../../../src/modules/stores/list-items";
import {
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

  /** A fixture's attempt logs, newest first, as the diagnostics endpoint lists them. */
  function attemptLogsOf(fixture: LocalSeedFixture) {
    return [...fixture.attempts].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  }

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
        "reprocess-failed",
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
      "OpenAIError@embed_source",
      "OpenAIError@summarize",
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
  });

  it("writes each object key exactly once", () => {
    expect(new Set(plan.objects.map((o) => o.key)).size).toBe(plan.objects.length);
  });

  it("writes only captured content to R2: no manifests, attempt logs, pointers or list", () => {
    // Reading state is PostgreSQL rows (ADR 0005); R2 holds only the bytes a
    // row points at.
    const contentKeys = new Set(
      plan.fixtures.flatMap((f) => [`${f.keyPrefix}/extracted.md`, ...["html", "md", "pdf", "txt", "bin"].map((ext) => `${f.keyPrefix}/raw.${ext}`)]),
    );
    expect(plan.objects.filter((o) => !contentKeys.has(o.key)).map((o) => o.key)).toEqual([]);
    expect(plan.objects.length).toBeGreaterThan(0);
  });

  it("derives list rows that match their manifests, newest first", () => {
    const list = ListIndexSchema.parse(plan.listIndex);
    expect(list.items).toHaveLength(plan.fixtures.length);
    for (const fixture of plan.fixtures) {
      const row = list.items.find((i) => i.id === fixture.id);
      expect(row).toEqual(manifestToIndexItem(fixture.manifest, fixture.keyPrefix));
    }
  });

  it("gives every fixture its own URL, so each is its URL's owner", () => {
    for (const fixture of plan.fixtures) {
      expect(fixture.manifest.url_hash, fixture.name).toBe(urlHash(fixture.manifest.url));
    }
    expect(new Set(manifests.map((m) => m.url_hash)).size).toBe(plan.fixtures.length);
    expect(plan.fixtures.filter((f) => !f.ownsUrl).map((f) => f.name)).toEqual([]);
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
      const attempts = attemptLogsOf(fixture);
      // Oldest first, each one a valid attempt log.
      expect([...attempts].reverse(), fixture.name).toEqual(fixture.attempts);
      for (const attempt of attempts) {
        expect(ProcessingAttemptSchema.parse(attempt)).toEqual(attempt);
        expect(attempt.reading_id).toBe(fixture.id);
        expect(attempt.url).toBe(fixture.manifest.url);
        expect(attempt.url_hash).toBe(fixture.manifest.url_hash);
        expect(attempt.key_prefix).toBe(fixture.keyPrefix);
      }

      // The manifest's attempt is one of the logs, and agrees with it.
      const manifestAttempt = fixture.manifest.active_attempt ?? fixture.manifest.last_attempt;
      const attempt = attempts.find((a) => a.id === manifestAttempt?.id);
      expect(attempt, fixture.name).toBeDefined();
      expect(manifestAttempt?.status).toBe(attempt!.status);
      expect(manifestAttempt?.stage).toBe(attempt!.stage);
      expect(manifestAttempt?.finished_at).toBe(attempt!.finished_at);

      // A ready manifest names the attempt that made it ready, unless a
      // later reprocess failed and was rolled forward over it.
      if (fixture.manifest.status === "ready") {
        const rolledForward = manifestAttempt?.trigger === "reprocess" && manifestAttempt.status === "failed";
        expect(attempt!.status, fixture.name).toBe(rolledForward ? "failed" : "succeeded");
        expect(attempts.some((a) => a.status === "succeeded"), fixture.name).toBe(true);
      }
    }
  });

  it("represents the failed reprocess as a ready manifest whose last attempt is a failed reprocess", () => {
    const fixture = byId.get("rd_FXREPROC01")!;
    const manifest = fixture.manifest;
    expect(fixture.name).toBe("reprocess-failed");
    expect(manifest.status).toBe("ready");
    // rollForward keeps the ready data and clears the in-flight state: the
    // failure lives on the attempt, never on the manifest.
    expect(manifest.title).toBe("The tab that never closes");
    expect(manifest.tldr).toBeDefined();
    expect(manifest.error).toBeUndefined();
    expect(manifest.active_attempt).toBeUndefined();
    expect(manifest.last_attempt).toMatchObject({
      id: "at_FXREPROC02",
      trigger: "reprocess",
      status: "failed",
      stage: "fetch_source",
    });
    expect(manifest.last_attempt?.error).toMatchObject({ code: "BadStatusError", stage: "fetch_source" });
    expect(manifest.content_status).toBe("captured");

    const [reprocess, submit] = attemptLogsOf(fixture);
    expect(submit).toMatchObject({ id: "at_FXREPROC01", trigger: "submit", status: "succeeded" });
    expect(reprocess).toMatchObject({ id: "at_FXREPROC02", trigger: "reprocess", status: "failed" });
    expect(Date.parse(reprocess!.started_at)).toBeGreaterThan(Date.parse(submit!.finished_at!));
    // The list row carries the same signal the library badges from.
    const row = plan.listIndex.items.find((item) => item.id === fixture.id)!;
    expect(row.status).toBe("ready");
    expect(row.error).toBeUndefined();
    expect(row.last_attempt).toEqual(manifest.last_attempt);
  });

  it("derives every terminal timestamp from the generated attempt so manifest, summary, and event log share one chronology", () => {
    for (const fixture of plan.fixtures) {
      const attempts = attemptLogsOf(fixture);
      // The attempt that produced the terminal state: the one the manifest
      // names. A ready reading's data still dates from its succeeded attempt.
      const attempt = attempts.find(
        (a) => a.id === (fixture.manifest.active_attempt ?? fixture.manifest.last_attempt)?.id,
      )!;

      if (fixture.manifest.status === "ready") {
        const succeeded = attempts.find((a) => a.status === "succeeded")!;
        expect(succeeded).toBeDefined();
        // rollForward restamps updated_at at the failed reprocess; the
        // captured data and its dates are the succeeded attempt's.
        expect(fixture.manifest.updated_at).toBe(attempt.finished_at);
        expect(fixture.manifest.fetched_at).toBe(succeeded.finished_at);
        // similarity is measured when query_similar completes, mid-run. The
        // old-manifest fixture predates similarity and has none.
        const querySimilarAt = succeeded.events.find(
          (e) => e.stage === "query_similar" && e.status === "succeeded",
        )?.at;
        if (fixture.manifest.similarity !== undefined) {
          expect(fixture.manifest.similarity.computed_at).toBe(querySimilarAt);
          expect(Date.parse(querySimilarAt!)).toBeLessThanOrEqual(
            Date.parse(fixture.manifest.updated_at),
          );
        }
      }
      if (fixture.manifest.status === "failed") {
        expect(attempt.status).toBe("failed");
        expect(fixture.manifest.updated_at).toBe(attempt.finished_at);
        expect(fixture.manifest.error?.failed_at).toBe(attempt.finished_at);
      }
      // Every failed attempt, on a failed manifest or rolled forward under a
      // ready one, stamps its error at its own finish.
      for (const failed of attempts.filter((a) => a.status === "failed")) {
        expect(failed.error?.failed_at, failed.id).toBe(failed.finished_at);
        // Ordinary failures stamp finished_at at the failure event; the
        // dead-letter shape outlives its only event (retries exhausted later).
        expect(Date.parse(failed.finished_at!)).toBeGreaterThanOrEqual(
          Date.parse(failed.events.at(-1)!.at),
        );
      }
      if (fixture.manifest.status === "pending") continue;

      // Events never precede their attempt's own start.
      for (const log of attempts) {
        for (const event of log.events) {
          expect(Date.parse(event.at)).toBeGreaterThanOrEqual(Date.parse(log.started_at));
        }
      }
    }
  });

  it("gives the dead-lettered stopped fixture the DLQ attempt shape", () => {
    const stopped = byId.get("rd_FXERR00007")!;
    expect(stopped.attempts).toHaveLength(1);
    const attempt = stopped.attempts[0]!;
    expect(attempt.events).toEqual([
      { stage: "queued", status: "started", at: attempt.started_at },
    ]);
    expect(attempt.stage).toBe("summarize");
    // Retries exhausted 15 minutes after the attempt started.
    expect(Date.parse(attempt.finished_at!)).toBe(
      Date.parse(attempt.started_at) + 900_000,
    );
  });

  it("pins the non-obvious invariants of the named states", () => {
    // Sparse archive: an empty similarity result has a count and no stats.
    const sparse = byId.get("rd_FXSPARSE01")!.manifest;
    expect(sparse.similarity?.count).toBe(0);
    expect(sparse.similarity?.max).toBeUndefined();
    expect(sparse.similarity?.mean).toBeUndefined();
    expect(sparse.connections).toEqual([]);

    // Unavailable source: raw_only means no extracted.md object exists.
    const rawSrc = byId.get("rd_FXRAWSRC01")!;
    expect(rawSrc.manifest.content_status).toBe("raw_only");
    expect(plan.objects.some((o) => o.key === `${rawSrc.keyPrefix}/extracted.md`)).toBe(false);

    // Degraded YouTube: a transcript-tier degradation on a still-ready reading.
    const youtube = byId.get("rd_FXYTDEGRD1")!.manifest;
    expect(youtube.enrichment_degradation).toMatchObject({ source: "youtube", tier: "transcript" });
    expect(youtube.status).toBe("ready");

    // Old manifest: pre-similarity fields absent, usage on the legacy arm.
    const old = byId.get("rd_FXPAST0001")!.manifest;
    expect(old.similarity).toBeUndefined();
    expect(old.novelty_verdict).toBeUndefined();
    expect(old.connections_computed_at).toBeUndefined();
    expect(old.usage).toHaveProperty("anthropic_input_tokens");

    // Long title: past the summarizer's 120-char cap, kept verbatim.
    expect(byId.get("rd_FXMAXNAME1")!.manifest.title!.length).toBeGreaterThan(120);

    // Imported Markdown: a markdown source reached through an import attempt.
    const markdown = byId.get("rd_FXMDPAGE01")!.manifest;
    expect(markdown.source_type).toBe("markdown");
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
