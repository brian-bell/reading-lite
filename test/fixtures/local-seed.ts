// The local fixture pack (issue #366): the Connected prototype's authored
// samples turned into real manifests, list-index rows, pointers, content
// objects, and attempt logs, seeded into local R2 by
// `npm run seed:local` (scripts/seed-local-fixtures.ts).
//
// Every manifest is built through src/modules/manifest-drafting.ts — the same
// pure constructors the worker uses — so fixture state matches production
// placeholder conventions exactly (empty-content placeholders, attempt
// stamping, tag normalization). Keys are spelled by the single-homed layout
// module (src/modules/stores/layout.ts) at the local global root: local dev
// leaves TENANT_DATA_PLANE unset, so `tenantKeyRoot` is "" there and the
// local founder account reads global-rooted readings/.
//
// Each fixture has a stable `name` (used by Phase 3 slices and
// docs/design/connected/fixture-pack.md) and a one-line `state` describing the
// acceptance-matrix signal it represents. All content is authored fiction from
// the prototype; nothing here is real corpus content or credentials.
//
// The one clock-dependent fixture is `pending`: its timestamps come from the
// `nowIso` argument so the read-time staleness rule (PENDING_TTL_SECONDS,
// 900 locally) does not immediately flip it to failed. Re-run the seeder to
// refresh it once it goes stale.

import { createHash } from "node:crypto";
import {
  failedManifest,
  readyManifest,
  rollForward,
  submitPending,
} from "../../src/modules/manifest-drafting";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { manifestToIndexItem } from "../../src/modules/stores/list-index";
import {
  ManifestSchema,
  ProcessingAttemptSchema,
  ProcessingAttemptSummarySchema,
  type EnrichmentDegradation,
  type Manifest,
  type ManifestError,
  type ProcessingAttempt,
  type ProcessingAttemptEvent,
  type ProcessingAttemptSummary,
  type ProcessingStage,
  type ReadingSummary,
  type SimilaritySnapshot,
  type Tension,
  type TensionJudged,
} from "../../src/schemas/manifest";
import type { ListIndex, ListIndexItem } from "../../src/schemas/api";
import { urlHash } from "../../scripts/corpus-lib/url-hash";
import { FIXTURE_CONTENT, type FixtureContent } from "./local-seed-content";

const layout = r2KeyLayout("");

export interface LocalSeedObject {
  /** Bucket key at the local global root (no tenant prefix). */
  key: string;
  body: string;
  contentType: string;
}

export interface LocalSeedFixture {
  /** Stable slug slices and docs refer to. */
  name: string;
  /** The acceptance-matrix signal this fixture represents. */
  state: string;
  id: string;
  keyPrefix: string;
  manifest: Manifest;
  /** Ids of the attempt logs written under `attempts/`, oldest first. */
  attemptIds: string[];
}

export interface LocalSeedPlan {
  fixtures: LocalSeedFixture[];
  /** Every R2 object to write, including index/list.json. */
  objects: LocalSeedObject[];
  listIndex: ListIndex;
  /** Connection-target id referenced by fixtures but deliberately never written. */
  removedTargetId: string;
}

// Reading ids are minted rd_<10 chars of the Crockford-ish alphabet
// (src/services.ts mintReadingId), so fixture ids stay parseReadingId-valid:
// uppercase, no I/L/O/U, exactly ten characters. Attempt ids follow
// at_<same>, with the trailing digit counting the reading's attempts.
const IDS = {
  attention: "rd_FXATTENT01",
  gardens: "rd_FXGARDEN01",
  friction: "rd_FXFRICTN01",
  sparseArchive: "rd_FXSPARSE01",
  unavailable: "rd_FXRAWSRC01",
  longTitle: "rd_FXMAXNAME1",
  markdown: "rd_FXMDPAGE01",
  youtube: "rd_FXYTDEGRD1",
  old: "rd_FXPAST0001",
  reprocessFailed: "rd_FXREPROC01",
  pending: "rd_FXPENDNG01",
  failUnreachable: "rd_FXERR00001",
  failIncomplete: "rd_FXERR00002",
  failProviderLimit: "rd_FXERR00003",
  failProviderError: "rd_FXERR00004",
  failKeyProblem: "rd_FXERR00005",
  failHostingLimit: "rd_FXERR00006",
  failStopped: "rd_FXERR00007",
  failUnknown: "rd_FXERR00008",
} as const;

export const LOCAL_SEED_REMOVED_TARGET_ID = "rd_FXVANSHD01";

/** The reading's nth attempt id: every fixture id ends in a digit, which the ordinal replaces. */
function attemptIdOf(readingId: string, ordinal: number): string {
  return `at_${readingId.slice(3, -1)}${ordinal}`;
}

const CONNECTED_REFRESHED_AT = "2026-09-08T03:07:00.000Z";
const TENSIONS_JUDGED_AT = "2026-09-09T03:07:00.000Z";

const FRICTION_TENSION_REASON =
  "A stopping point protects attention; a deliberate interruption can deepen it. These essays disagree about where the default should sit.";

// ---------------------------------------------------------------------------
// Content facts

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function contentFacts(content: FixtureContent): {
  content_type: string;
  content_status: "captured" | "raw_only";
  content_bytes: number;
  content_sha256: string;
  extracted_bytes?: number;
} {
  return {
    content_type: content.raw.contentType,
    content_status: content.extractedMarkdown === null ? "raw_only" : "captured",
    content_bytes: bytesOf(content.raw.body),
    content_sha256: sha256Hex(content.raw.body),
    ...(content.extractedMarkdown === null
      ? {}
      : { extracted_bytes: bytesOf(content.extractedMarkdown) }),
  };
}

// ---------------------------------------------------------------------------
// Attempt logs

const STAGE_MS: Record<Exclude<ProcessingStage, "prepare_markdown">, number> = {
  queued: 2_000,
  fetch_source: 8_000,
  write_raw: 2_000,
  write_extracted: 2_000,
  embed_source: 4_000,
  query_similar: 2_000,
  summarize: 20_000,
  embed_summary: 3_000,
  upsert_vector: 2_000,
  write_manifest: 1_000,
  write_indexes: 2_000,
  send_email: 3_000,
};

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function stageMs(stage: ProcessingStage): number {
  return STAGE_MS[stage as Exclude<ProcessingStage, "prepare_markdown">] ?? 3_000;
}

/** When `stage` completes, walking the spec's stage list from the attempt start. */
function stageCompletionAt(
  startedAt: string,
  stages: readonly ProcessingStage[],
  stage: ProcessingStage,
): string {
  let ms = 0;
  for (const s of stages) {
    ms += stageMs(s);
    if (s === stage) return addMs(startedAt, ms);
  }
  throw new Error(`stageCompletionAt: stage ${stage} never runs in the given stage list`);
}

interface AttemptLogSpec {
  attemptId: string;
  trigger: "submit" | "import" | "reprocess";
  reading: { id: string; url: string; urlHash: string; keyPrefix: string };
  startedAt: string;
  /** Stages that ran to completion, in order (queued included). */
  stages: readonly ProcessingStage[];
  /**
   * Failing stage; events stop with a failed event and no further stages run.
   * The error arrives without `failed_at` — it is stamped here from the
   * failure event's time so the manifest, the attempt summary, and the event
   * log can never disagree about when the failure happened.
   */
  failAt?: { stage: ProcessingStage; error: Omit<ManifestError, "failed_at"> };
  /** Dead-letter shape: only the queued `started` event, stage copied forward. */
  dlq?: boolean;
  /** Dead-letter only: seconds from attempt start until retries exhausted. */
  dlqSeconds?: number;
}

function attemptLog(spec: AttemptLogSpec): ProcessingAttempt {
  const events: ProcessingAttemptEvent[] = [];
  let at = spec.startedAt;
  let stage: ProcessingStage = "queued";
  let failedError: ManifestError | undefined;
  // The worker stamps `succeeded`/`finished_at` right after the last processing
  // stage (embed_summary) — before the terminal write stages run — so the
  // terminal manifest's updated_at and the attempt's finished_at are the same
  // moment, with the write_manifest/write_indexes/send_email events following.
  let succeededAt: string | undefined;

  if (spec.dlq) {
    events.push({ stage: "queued", status: "started", at });
    stage = spec.failAt?.stage ?? "queued";
    at = addMs(spec.startedAt, (spec.dlqSeconds ?? 900) * 1000);
    failedError = { ...spec.failAt!.error, failed_at: at };
  } else {
    for (const s of spec.stages) {
      const ms = stageMs(s);
      const startedAt = at;
      events.push({ stage: s, status: "started", at: startedAt });
      if (spec.failAt !== undefined && s === spec.failAt.stage) {
        const failedAt = addMs(startedAt, ms);
        failedError = { ...spec.failAt.error, failed_at: failedAt };
        events.push({
          stage: s,
          status: "failed",
          at: failedAt,
          duration_ms: ms,
          error: failedError,
        });
        at = failedAt;
        stage = s;
        break;
      }
      const finishedAt = addMs(startedAt, ms);
      events.push({ stage: s, status: "succeeded", at: finishedAt, duration_ms: ms });
      at = finishedAt;
      stage = s;
      if (s === "embed_summary") succeededAt = finishedAt;
    }
  }

  const failed = spec.failAt !== undefined;
  const finishedAt = failed ? at : succeededAt;
  const attempt = {
    id: spec.attemptId,
    trigger: spec.trigger,
    status: failed ? ("failed" as const) : ("succeeded" as const),
    stage,
    started_at: spec.startedAt,
    ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
    ...(failedError === undefined ? {} : { error: failedError }),
    reading_id: spec.reading.id,
    url: spec.reading.url,
    url_hash: spec.reading.urlHash,
    key_prefix: spec.reading.keyPrefix,
    events,
  };
  return ProcessingAttemptSchema.parse(attempt);
}

function attemptSummary(attempt: ProcessingAttempt): ProcessingAttemptSummary {
  // The manifest keeps only the summary shape of the full attempt; the
  // drafter's parse strips reading_id/url/url_hash/key_prefix/events on the
  // way in, this mirrors that for a prebuilt attempt.
  return ProcessingAttemptSummarySchema.parse(attempt);
}

// ---------------------------------------------------------------------------
// Ready fixtures

interface ReadySpec {
  name: string;
  state: string;
  id: string;
  url: string;
  createdAt: string;
  trigger: "submit" | "import";
  summary: ReadingSummary;
  /** Without computed_at: it is derived from the attempt's query_similar stage. */
  similarity?: Omit<SimilaritySnapshot, "computed_at">;
  contentKey: keyof typeof FIXTURE_CONTENT;
  neighbourhoodIds: string[];
  usage: { summarization: ReadingSummaryUsage; openai_embedding_tokens: number };
  enrichmentDegradation?: EnrichmentDegradation;
  connectionsComputedAt?: string;
  tensions?: Tension[];
  tensionsJudged?: TensionJudged[];
  /** April-era manifest: no similarity, no novelty_verdict, legacy usage. */
  legacy?: { usage: Usage };
  /**
   * A later reprocess that failed: the ready manifest is rolled forward
   * (manifest-drafting rollForward) with the failed attempt as last_attempt
   * and no error of its own, and the failed attempt gets a second log.
   */
  failedReprocess?: FailureSpec & { startedAt: string };
}

/** How an attempt fails, shared by the failed fixtures and a ready fixture's failed reprocess. */
interface FailureSpec {
  /** Without failed_at: it is stamped from the attempt's failure event time. */
  error: Omit<ManifestError, "failed_at">;
  stage: ProcessingStage;
  /** Stages that ran before the failure (queued included). */
  stages: readonly ProcessingStage[];
  /** Dead-letter shape (queue retries exhausted). */
  dlq?: boolean;
}

type ReadingSummaryUsage = {
  provider: "openai";
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
};
type Usage = {
  anthropic_input_tokens: number;
  anthropic_output_tokens: number;
  openai_embedding_tokens: number;
};

const URL_STAGES: readonly ProcessingStage[] = [
  "queued",
  "fetch_source",
  "write_raw",
  "write_extracted",
  "embed_source",
  "query_similar",
  "summarize",
  "embed_summary",
  "upsert_vector",
  "write_manifest",
  "write_indexes",
  "send_email",
];
const RAW_ONLY_STAGES: readonly ProcessingStage[] = [
  "queued",
  "fetch_source",
  "write_raw",
  "embed_source",
  "query_similar",
  "summarize",
  "embed_summary",
  "upsert_vector",
  "write_manifest",
  "write_indexes",
  "send_email",
];
const MARKDOWN_STAGES: readonly ProcessingStage[] = [
  "queued",
  "write_raw",
  "write_extracted",
  "embed_source",
  "query_similar",
  "summarize",
  "embed_summary",
  "upsert_vector",
  "write_manifest",
  "write_indexes",
];

function openaiUsage(o: {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  cacheWrite: number;
}): ReadingSummaryUsage {
  return {
    provider: "openai",
    model: "gpt-5.6-terra",
    input_tokens: o.input,
    output_tokens: o.output,
    reasoning_tokens: o.reasoning,
    cached_input_tokens: o.cached,
    cache_write_tokens: o.cacheWrite,
  };
}

interface AssembledFixture {
  fixture: LocalSeedFixture;
  objects: LocalSeedObject[];
}

function assembleReady(spec: ReadySpec): AssembledFixture {
  const content = FIXTURE_CONTENT[spec.contentKey];
  const keyPrefix = buildKeyPrefix(spec.id, spec.createdAt);
  const urlHashValue = urlHash(spec.url);
  const startedAt = addMs(spec.createdAt, 4_000);
  const isMarkdownImport = spec.trigger === "import";
  const stages =
    content.extractedMarkdown === null
      ? RAW_ONLY_STAGES
      : isMarkdownImport
        ? MARKDOWN_STAGES
        : URL_STAGES;
  const attempt = attemptLog({
    attemptId: attemptIdOf(spec.id, 1),
    trigger: spec.trigger,
    reading: { id: spec.id, url: spec.url, urlHash: urlHashValue, keyPrefix },
    startedAt,
    stages,
  });
  // The terminal timestamp is the attempt's own finished_at (stamped after
  // embed_summary, exactly as the worker stamps it), and similarity is
  // measured when query_similar completes — both derived from the generated
  // attempt so manifest, summary, and event log share one chronology.
  const finishedAt = attempt.finished_at!;
  const similarity =
    spec.similarity === undefined
      ? undefined
      : { ...spec.similarity, computed_at: stageCompletionAt(startedAt, stages, "query_similar") };

  let manifest = readyManifest(
    {
      identity: {
        id: spec.id,
        url: spec.url,
        urlHash: urlHashValue,
        createdAt: spec.createdAt,
      },
      sourceType: isMarkdownImport ? "markdown" : "url",
      summary: spec.summary,
      ...(similarity === undefined ? {} : { similarity }),
      content: {
        ...contentFacts(content),
        ...(spec.enrichmentDegradation === undefined
          ? {}
          : { enrichment_degradation: spec.enrichmentDegradation }),
      },
      usage: spec.usage,
      neighbourhoodIds: spec.neighbourhoodIds,
      attempt: attemptSummary(attempt),
    },
    finishedAt,
  );

  // The nightly refresh stamps these post-ingest (relationship-judgement
  // refresh.ts); the legacy manifest predates both fields.
  if (spec.connectionsComputedAt !== undefined) {
    manifest = ManifestSchema.parse({
      ...manifest,
      connections_computed_at: spec.connectionsComputedAt,
    });
  }
  if (spec.tensions !== undefined) {
    manifest = ManifestSchema.parse({
      ...manifest,
      tensions: spec.tensions,
      ...(spec.tensionsJudged === undefined ? {} : { tensions_judged: spec.tensionsJudged }),
    });
  }
  if (spec.legacy !== undefined) {
    const { novelty_verdict: _verdict, similarity: _similarity, usage: _usage, ...rest } =
      manifest;
    manifest = ManifestSchema.parse({ ...rest, usage: spec.legacy.usage });
  }

  // A failed reprocess over a ready reading: the worker restores the ready
  // manifest it preserved before the pending overwrite (rollForward), so the
  // summary stays and only last_attempt and updated_at record the failure.
  let reprocessAttempt: ProcessingAttempt | undefined;
  if (spec.failedReprocess !== undefined) {
    reprocessAttempt = attemptLog({
      attemptId: attemptIdOf(spec.id, 2),
      trigger: "reprocess",
      reading: { id: spec.id, url: spec.url, urlHash: urlHashValue, keyPrefix },
      startedAt: spec.failedReprocess.startedAt,
      stages: spec.failedReprocess.stages,
      failAt: { stage: spec.failedReprocess.stage, error: spec.failedReprocess.error },
      dlq: spec.failedReprocess.dlq,
    });
    manifest = rollForward(
      manifest,
      attemptSummary(reprocessAttempt),
      reprocessAttempt.finished_at!,
    );
  }

  const objects: LocalSeedObject[] = [];
  objects.push(
    seedManifest(keyPrefix, manifest),
    seedPointer(layout.byIdKey(spec.id), keyPrefix, spec.id),
    seedPointer(layout.byUrlKey(urlHashValue), keyPrefix, spec.id),
    {
      key: layout.rawKey(keyPrefix, extFor(content.raw.contentType)),
      body: content.raw.body,
      contentType: content.raw.contentType,
    },
  );
  if (content.extractedMarkdown !== null) {
    objects.push({
      key: layout.extractedKey(keyPrefix),
      body: content.extractedMarkdown,
      contentType: "text/markdown; charset=utf-8",
    });
  }
  objects.push({
    key: layout.attemptKey(keyPrefix, attempt.id),
    body: JSON.stringify(attempt),
    contentType: "application/json",
  });
  if (reprocessAttempt !== undefined) {
    objects.push({
      key: layout.attemptKey(keyPrefix, reprocessAttempt.id),
      body: JSON.stringify(reprocessAttempt),
      contentType: "application/json",
    });
  }

  return {
    fixture: {
      name: spec.name,
      state: spec.state,
      id: spec.id,
      keyPrefix,
      manifest,
      attemptIds: [attempt.id, ...(reprocessAttempt === undefined ? [] : [reprocessAttempt.id])],
    },
    objects,
  };
}

function extFor(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "text/plain") return "txt";
  return "bin";
}

function seedManifest(keyPrefix: string, manifest: Manifest): LocalSeedObject {
  return {
    key: layout.manifestKey(keyPrefix),
    body: JSON.stringify(manifest),
    contentType: "application/json",
  };
}

function seedPointer(key: string, keyPrefix: string, id: string): LocalSeedObject {
  return {
    key,
    body: JSON.stringify({ id, key_prefix: keyPrefix }),
    contentType: "application/json",
  };
}

// ---------------------------------------------------------------------------
// Failed fixtures — one per acceptance-matrix failure category

interface FailedSpec extends FailureSpec {
  name: string;
  state: string;
  id: string;
  url: string;
  createdAt: string;
  /** Seconds from created_at until the attempt started. */
  queueSeconds: number;
}

function assembleFailed(spec: FailedSpec): AssembledFixture {
  const keyPrefix = buildKeyPrefix(spec.id, spec.createdAt);
  const urlHashValue = urlHash(spec.url);
  const startedAt = addMs(spec.createdAt, spec.queueSeconds * 1000);
  const attempt = attemptLog({
    attemptId: attemptIdOf(spec.id, 1),
    trigger: "submit",
    reading: { id: spec.id, url: spec.url, urlHash: urlHashValue, keyPrefix },
    startedAt,
    stages: spec.stages,
    failAt: { stage: spec.stage, error: spec.error },
    dlq: spec.dlq,
  });
  // Terminal time, error, and attempt all come from the generated attempt, so
  // updated_at, error.failed_at, and the failure event can never disagree.
  const finishedAt = attempt.finished_at!;
  const error = attempt.error!;
  // The worker failure path always drafts the empty-content placeholder with
  // content_status "failed" (process-reading markFailed), even when earlier
  // stages wrote objects, so failed fixtures carry no raw/extracted objects.
  const manifest = failedManifest(
    {
      id: spec.id,
      url: spec.url,
      urlHash: urlHashValue,
      createdAt: spec.createdAt,
    },
    { sourceType: "url", error, attempt: attemptSummary(attempt) },
    finishedAt,
  );
  return {
    fixture: {
      name: spec.name,
      state: spec.state,
      id: spec.id,
      keyPrefix,
      manifest,
      attemptIds: [attempt.id],
    },
    objects: [
      seedManifest(keyPrefix, manifest),
      seedPointer(layout.byIdKey(spec.id), keyPrefix, spec.id),
      seedPointer(layout.byUrlKey(urlHashValue), keyPrefix, spec.id),
      {
        key: layout.attemptKey(keyPrefix, attempt.id),
        body: JSON.stringify(attempt),
        contentType: "application/json",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The pack

const READY_SPECS: ReadySpec[] = [
  {
    name: "attention",
    state: "Ready baseline; refreshed connections (connections_computed_at present); tension pair with friction; removed and non-ready targets referenced",
    id: IDS.attention,
    url: "https://fieldnotes.example/2026/a-quieter-internet",
    createdAt: "2026-09-07T09:30:00.000Z",
    trigger: "submit",
    summary: {
      title: "A quieter internet is a choice we can make",
      tldr: "The best tools for thought give us somewhere to return, not another stream to keep up with. A personal library can turn the internet from a demand on our attention into a place for deliberate reading.",
      tags: ["Attention", "Design"],
      keywords: ["attention", "deliberate reading", "personal library", "return visit", "tools for thought"],
      people: ["Mara Ellis"],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [
        {
          id: IDS.gardens,
          reason:
            "Both treat revisiting as the work. Ellis adds a concrete test: does the tool help an old idea meet a new question?",
        },
        {
          id: LOCAL_SEED_REMOVED_TARGET_ID,
          reason:
            "This earlier reading linked infinite feeds with unfinished tasks. The reading has since been removed; this explanation remains for context.",
        },
      ],
      summary_markdown: [
        "The best tools for thought give us somewhere to return, not another stream to keep up with. A personal library can turn the internet from a demand on our attention into a place for deliberate reading.",
        "",
        "Saving is only the beginning. A library earns its place when it helps you return to an idea at the right moment — an old idea meeting a new question, or two writers whose disagreement you can finally name.",
        "",
        "Small, intentional interruptions can be useful: a connection to an older reading may matter more than another recommendation, as long as the reader stays in control of whether to follow it.",
        "",
        "The essay closes with a design criterion: measure a reading tool by the quality of its endings. A session that ends because you understood something is a success, not a failure to re-engage.",
      ].join("\n"),
    },
    similarity: { count: 2, max: 0.61, mean: 0.58 },
    contentKey: "attention",
    neighbourhoodIds: [IDS.gardens, IDS.friction, IDS.longTitle, IDS.sparseArchive],
    usage: {
      summarization: openaiUsage({ input: 8214, output: 642, reasoning: 318, cached: 6100, cacheWrite: 2114 }),
      openai_embedding_tokens: 2349,
    },
    connectionsComputedAt: CONNECTED_REFRESHED_AT,
    tensions: [
      {
        id: IDS.friction,
        kind: "contradicts",
        reason: FRICTION_TENSION_REASON,
        computed_at: TENSIONS_JUDGED_AT,
      },
    ],
    tensionsJudged: [{ id: IDS.friction, judged_at: TENSIONS_JUDGED_AT }],
  },
  {
    name: "gardens",
    state: "Ready baseline; refreshed connections; references a pending target and a failed target (non-ready relationship targets)",
    id: IDS.gardens,
    url: "https://commonplace.example/libraries-are-gardens",
    createdAt: "2026-09-04T10:00:00.000Z",
    trigger: "submit",
    summary: {
      title: "Libraries are gardens, not warehouses",
      tldr: "An archive grows more useful through care, not accumulation. Revisiting and connecting a small set of readings can do more for understanding than collecting a much larger set.",
      tags: ["Knowledge", "Attention"],
      keywords: ["digital gardens", "archives", "revisiting", "tags", "note-taking"],
      people: ["Julian Park"],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [
        {
          id: IDS.attention,
          reason:
            "Ellis turns the garden metaphor into a design principle: optimize for a useful return visit.",
        },
        {
          id: IDS.pending,
          reason:
            "The pending essay applies the return-visit principle to slow work; it will appear here once processing finishes.",
        },
        {
          id: IDS.failIncomplete,
          reason:
            "A related reading on curated queues failed to process; retry it to complete the connection.",
        },
      ],
      summary_markdown: [
        "An archive grows more useful through care, not accumulation. Revisiting and connecting a small set of readings can do more for understanding than collecting a much larger set.",
        "",
        "Tags work as paths back into a question rather than a perfect classification system; an imperfect collection you visit teaches more than a perfect one you maintain.",
        "",
        "The maintenance itself is thinking: letting older readings change meaning as your interests change is the work the garden metaphor names.",
      ].join("\n"),
    },
    similarity: { count: 2, max: 0.64, mean: 0.6 },
    contentKey: "gardens",
    neighbourhoodIds: [IDS.attention, IDS.friction, IDS.sparseArchive],
    usage: {
      summarization: openaiUsage({ input: 6908, output: 598, reasoning: 276, cached: 4800, cacheWrite: 2108 }),
      openai_embedding_tokens: 1976,
    },
    connectionsComputedAt: CONNECTED_REFRESHED_AT,
  },
  {
    name: "friction",
    state: "Ready baseline; the other side of the attention tension pair",
    id: IDS.friction,
    url: "https://adjacent.example/the-case-for-a-little-friction",
    createdAt: "2026-09-02T13:45:00.000Z",
    trigger: "submit",
    summary: {
      title: "The case for a little friction",
      tldr: "Not every interruption is a distraction. A deliberate pause or well-placed question can help a reader notice assumptions that a seamless interface would let pass.",
      tags: ["Design"],
      keywords: ["friction", "interruption", "reading interfaces", "user control"],
      people: ["Leah Chen"],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [],
      summary_markdown: [
        "Not every interruption is a distraction. A deliberate pause or well-placed question can help a reader notice assumptions that a seamless interface would let pass.",
        "",
        "Useful interruption has a shape: it is relevant, optional, and easy to return from. Friction is useful when the reader understands its purpose.",
        "",
        "Leave the starting point visible and let the reader choose — that is the difference between a deepening tangent and a lost thread.",
      ].join("\n"),
    },
    similarity: { count: 2, max: 0.57, mean: 0.55 },
    contentKey: "friction",
    neighbourhoodIds: [IDS.attention, IDS.gardens],
    usage: {
      summarization: openaiUsage({ input: 5433, output: 553, reasoning: 241, cached: 3900, cacheWrite: 1533 }),
      openai_embedding_tokens: 1892,
    },
    connectionsComputedAt: CONNECTED_REFRESHED_AT,
    tensions: [
      {
        id: IDS.attention,
        kind: "contradicts",
        reason: FRICTION_TENSION_REASON,
        computed_at: TENSIONS_JUDGED_AT,
      },
    ],
    tensionsJudged: [{ id: IDS.attention, judged_at: TENSIONS_JUDGED_AT }],
  },
  {
    name: "sparse-archive",
    state: "Sparse archive: similarity.count = 0, no connections; novelty says nothing close existed when processed",
    id: IDS.sparseArchive,
    url: "https://small-hours.example/against-the-endless-queue",
    createdAt: "2026-09-06T18:25:00.000Z",
    trigger: "submit",
    summary: {
      title: "Against the endless queue",
      tldr: "A reading queue can become a list of obligations. Rivera proposes keeping a small set of active interests and allowing the rest to remain an archive.",
      tags: ["Attention"],
      keywords: ["reading queue", "unread articles", "archives", "obligation"],
      people: ["Alex Rivera"],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: [
        "A reading queue can become a list of obligations. Rivera proposes keeping a small set of active interests and allowing the rest to remain an archive.",
        "",
        "An unread item does not have to be an unfinished task; a saved article can be available without being a commitment.",
      ].join("\n"),
    },
    similarity: { count: 0 },
    contentKey: "sparse-archive",
    neighbourhoodIds: [],
    usage: {
      summarization: openaiUsage({ input: 4211, output: 497, reasoning: 205, cached: 0, cacheWrite: 4211 }),
      openai_embedding_tokens: 1710,
    },
  },
  {
    name: "reprocess-failed",
    state: "Ready with a failed reprocess: last_attempt is a failed reprocess attempt (BadStatusError at fetch_source), the manifest keeps its summary and carries no error; two attempt logs",
    id: IDS.reprocessFailed,
    url: "https://fieldnotes.example/the-tab-that-never-closes",
    createdAt: "2026-09-05T08:40:00.000Z",
    trigger: "submit",
    summary: {
      title: "The tab that never closes",
      tldr: "An open tab is a promise, not a plan. Saving a reading gives it somewhere to wait without asking for attention, so the tab can close and the piece can come back when it matters.",
      tags: ["Attention"],
      keywords: ["browser tabs", "saving", "deferral", "reading later"],
      people: ["Mara Ellis"],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [
        {
          id: IDS.attention,
          reason: "Both essays treat saving as a way to end a session well rather than to defer it.",
        },
      ],
      summary_markdown: [
        "An open tab is a promise, not a plan. Saving a reading gives it somewhere to wait without asking for attention, so the tab can close and the piece can come back when it matters.",
        "",
        "The essay separates saving from deferring: a saved reading has a place to be, while an open tab is an unpaid debt in the corner of the screen.",
      ].join("\n"),
    },
    similarity: { count: 1, max: 0.59, mean: 0.59 },
    contentKey: "reprocess-failed",
    neighbourhoodIds: [IDS.attention],
    usage: {
      summarization: openaiUsage({ input: 3120, output: 412, reasoning: 160, cached: 2200, cacheWrite: 920 }),
      openai_embedding_tokens: 1180,
    },
    connectionsComputedAt: CONNECTED_REFRESHED_AT,
    failedReprocess: {
      startedAt: "2026-09-10T16:05:00.000Z",
      stages: ["queued", "fetch_source"],
      stage: "fetch_source",
      error: {
        code: "BadStatusError",
        message: "bad response status 503: Service Unavailable",
        stage: "fetch_source",
        retryable: true,
      },
    },
  },
  {
    name: "long-title",
    state: "Very long title (130 characters, over the summarizer's 120-char output cap; the manifest field has no cap) wrapping in library and detail",
    id: IDS.longTitle,
    url: "https://working-notes.example/tools-for-thinking",
    createdAt: "2026-08-29T15:20:00.000Z",
    trigger: "submit",
    summary: {
      title:
        "What we lose when every tool for thinking becomes a place to organize, optimize, and measure the work instead of actually doing it",
      tldr: "The systems around creative work can quietly become the work itself. A useful tool makes it easier to begin, and knows when to get out of the way.",
      tags: ["Knowledge", "Design"],
      keywords: ["productivity", "organization", "creative work", "maintenance", "tools"],
      people: [],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [],
      summary_markdown: [
        "The systems around creative work can quietly become the work itself. A useful tool makes it easier to begin, and knows when to get out of the way.",
        "",
        "Measure whether a system helps you begin the actual task, and reconsider routines that create more maintenance than insight.",
      ].join("\n"),
    },
    similarity: { count: 3, max: 0.72, mean: 0.66 },
    contentKey: "long-title",
    neighbourhoodIds: [IDS.attention, IDS.gardens, IDS.sparseArchive],
    usage: {
      summarization: openaiUsage({ input: 5529, output: 561, reasoning: 258, cached: 4100, cacheWrite: 1429 }),
      openai_embedding_tokens: 1786,
    },
  },
  {
    name: "unavailable-source",
    state: "Source unavailable: content_status raw_only (no extracted.md); summary, novelty, and relationships still usable; raw capture viewable",
    id: IDS.unavailable,
    url: "https://margin.example/the-web-we-can-no-longer-revisit",
    createdAt: "2026-08-25T11:05:00.000Z",
    trigger: "submit",
    summary: {
      title: "The web we can no longer revisit",
      tldr: "As pages disappear or move behind access restrictions, saved summaries become a partial memory of the web. They are useful, but cannot replace the original evidence.",
      tags: ["Knowledge"],
      keywords: ["link rot", "paywalls", "source durability", "preservation"],
      people: ["Nora Vale"],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [
        {
          id: IDS.gardens,
          reason: "Maintaining a library also means acknowledging what has been lost.",
        },
      ],
      summary_markdown: [
        "As pages disappear or move behind access restrictions, saved summaries become a partial memory of the web. They are useful, but cannot replace the original evidence.",
        "",
        "A saved summary and a captured source have different roles, and showing missing source content explicitly lets readers judge what is still available.",
      ].join("\n"),
    },
    similarity: { count: 1, max: 0.48, mean: 0.48 },
    contentKey: "unavailable-source",
    neighbourhoodIds: [IDS.gardens, IDS.sparseArchive],
    usage: {
      summarization: openaiUsage({ input: 4660, output: 502, reasoning: 219, cached: 3500, cacheWrite: 1160 }),
      openai_embedding_tokens: 1744,
    },
  },
  {
    name: "imported-markdown",
    state: "Imported Markdown: source_type markdown, text/markdown raw capture; metadata line says Imported Markdown",
    id: IDS.markdown,
    url: "https://notes.example/slow-reading-week",
    createdAt: "2026-08-28T08:30:00.000Z",
    trigger: "import",
    summary: {
      title: "Slow reading week",
      tldr: "A one-week experiment in reading three long pieces instead of thirty short ones, kept as a single log with one standing question.",
      tags: ["Notes", "Reading"],
      keywords: ["slow reading", "reading log", "single question", "note-taking"],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [
        {
          id: IDS.attention,
          reason: "The week's standing question came from Ellis's argument for deliberate reading.",
        },
      ],
      summary_markdown: [
        "A one-week experiment in reading three long pieces instead of thirty short ones, kept as a single log with one standing question.",
        "",
        "Starting was easier with the question already open; rereading replaced new tabs; and the Friday summary proved more useful than anything saved that week.",
      ].join("\n"),
    },
    similarity: { count: 1, max: 0.41, mean: 0.41 },
    contentKey: "imported-markdown",
    neighbourhoodIds: [IDS.attention, IDS.sparseArchive],
    usage: {
      summarization: openaiUsage({ input: 3987, output: 468, reasoning: 197, cached: 0, cacheWrite: 3987 }),
      openai_embedding_tokens: 1698,
    },
  },
  {
    name: "degraded-youtube",
    state: "Degraded YouTube: enrichment_degradation present (tier transcript), ready on the oEmbed floor with description but no transcript",
    id: IDS.youtube,
    url: "https://www.youtube.com/watch?v=FxFixture01",
    createdAt: "2026-08-20T16:40:00.000Z",
    trigger: "submit",
    summary: {
      title: "Building a quiet reading app — chapter 4",
      tldr: "Chapter 4 of a build log: why the reading queue is not a feed, and what it took to make the library feel like a place you can leave and come back to.",
      tags: ["Software", "Design"],
      keywords: ["reading app", "build log", "reading queue", "product design"],
      people: [],
      orgs: ["Quiet Build Studio"],
      novelty_verdict: "familiar",
      connections: [],
      summary_markdown: [
        "Chapter 4 of a build log: why the reading queue is not a feed, and what it took to make the library feel like a place you can leave and come back to.",
        "",
        "The video walks through the quiet-library idea, the queue-versus-feed distinction, and a demo of what broke along the way.",
      ].join("\n"),
    },
    similarity: { count: 1, max: 0.44, mean: 0.44 },
    contentKey: "degraded-youtube",
    neighbourhoodIds: [IDS.sparseArchive],
    usage: {
      summarization: openaiUsage({ input: 5122, output: 521, reasoning: 230, cached: 3700, cacheWrite: 1422 }),
      openai_embedding_tokens: 1803,
    },
    enrichmentDegradation: {
      source: "youtube",
      tier: "transcript",
      code: "YoutubeEnrichmentParseError",
      message: "timedtext response was empty or unparseable",
    },
  },
  {
    name: "old-manifest",
    state: "Old manifest: no similarity, no novelty_verdict, no connections_computed_at (omit the line, never show unclassified); legacy usage shape",
    id: IDS.old,
    url: "https://adjacent.example/before-the-archive",
    createdAt: "2026-04-14T09:15:00.000Z",
    trigger: "submit",
    summary: {
      title: "Before the archive",
      tldr: "An early note making the case for saving pages: an archive is a bet that a future question will want what a page said.",
      tags: ["Archives"],
      keywords: ["archiving", "saved pages", "future questions"],
      people: [],
      orgs: [],
      novelty_verdict: "familiar",
      connections: [],
      summary_markdown: [
        "An early note making the case for saving pages: an archive is a bet that a future question will want what a page said.",
        "",
        "Keep the original text beside whatever summary replaces it, so the record can still be checked.",
      ].join("\n"),
    },
    contentKey: "old-manifest",
    neighbourhoodIds: [],
    usage: {
      summarization: openaiUsage({ input: 5000, output: 500, reasoning: 250, cached: 0, cacheWrite: 5000 }),
      openai_embedding_tokens: 1902,
    },
    legacy: {
      usage: {
        anthropic_input_tokens: 12840,
        anthropic_output_tokens: 733,
        openai_embedding_tokens: 1902,
      },
    },
  },
];

const FAILED_SPECS: FailedSpec[] = [
  {
    name: "fail-source-unreachable",
    state: "Failed, source unreachable: BadStatusError at fetch_source",
    id: IDS.failUnreachable,
    url: "https://registration-wall.example/members-only-report",
    createdAt: "2026-09-10T14:10:00.000Z",
    queueSeconds: 3,
    stage: "fetch_source",
    stages: ["queued", "fetch_source"],
    error: {
      code: "BadStatusError",
      message: "bad response status 403: https://registration-wall.example/members-only-report",
      stage: "fetch_source",
      retryable: false,
    },
  },
  {
    name: "fail-source-incomplete",
    state: "Failed, source incomplete: SourceRejectedError at summarize",
    id: IDS.failIncomplete,
    url: "https://consent-walls.example/teaser-article",
    createdAt: "2026-09-09T16:42:00.000Z",
    queueSeconds: 3,
    stage: "summarize",
    stages: ["queued", "fetch_source", "write_raw", "write_extracted", "summarize"],
    error: {
      code: "SourceRejectedError",
      message:
        "the source did not contain a complete article; the page was a truncated teaser with a subscription prompt",
      stage: "summarize",
      retryable: false,
    },
  },
  {
    name: "fail-provider-limit",
    state: "Failed, provider limit: RateLimitedError at summarize",
    id: IDS.failProviderLimit,
    url: "https://fieldnotes.example/rate-limited-essay",
    createdAt: "2026-09-09T09:05:00.000Z",
    queueSeconds: 3,
    stage: "summarize",
    stages: ["queued", "fetch_source", "write_raw", "write_extracted", "summarize"],
    error: {
      code: "RateLimitedError",
      message: "rate limited by https://api.openai.com/v1/responses (status 429, retry after 1200ms)",
      stage: "summarize",
      retryable: true,
    },
  },
  {
    name: "fail-provider-error",
    state: "Failed, provider error: BadStatusError at embed_source",
    id: IDS.failProviderError,
    url: "https://commonplace.example/embedding-failure-essay",
    createdAt: "2026-09-08T22:18:00.000Z",
    queueSeconds: 3,
    stage: "embed_source",
    stages: ["queued", "fetch_source", "write_raw", "write_extracted", "embed_source"],
    error: {
      code: "BadStatusError",
      message: "bad response status 500: https://api.openai.com/v1/embeddings",
      stage: "embed_source",
      retryable: true,
    },
  },
  {
    name: "fail-key-problem",
    state: "Failed, key problem: provider 401 at summarize",
    id: IDS.failKeyProblem,
    url: "https://adjacent.example/expired-key-essay",
    createdAt: "2026-09-08T11:55:00.000Z",
    queueSeconds: 3,
    stage: "summarize",
    stages: ["queued", "fetch_source", "write_raw", "write_extracted", "summarize"],
    error: {
      code: "BadStatusError",
      message: "bad response status 401: https://api.openai.com/v1/responses",
      stage: "summarize",
      retryable: false,
    },
  },
  {
    name: "fail-hosting-limit",
    state: "Failed, hosting limit: SpendAdmissionError at summarize",
    id: IDS.failHostingLimit,
    url: "https://margin.example/spend-capped-essay",
    createdAt: "2026-09-05T21:30:00.000Z",
    queueSeconds: 3,
    stage: "summarize",
    stages: ["queued", "fetch_source", "write_raw", "write_extracted", "summarize"],
    error: {
      code: "SpendAdmissionError",
      message: "paid spend admission: monthly budget exhausted",
      stage: "summarize",
      retryable: true,
    },
  },
  {
    name: "fail-stopped",
    state: "Failed, stopped: QueueRetriesExhaustedError (dead-lettered; attempt log holds only the queued started event)",
    id: IDS.failStopped,
    url: "https://small-hours.example/queue-exhausted-essay",
    createdAt: "2026-09-04T07:12:00.000Z",
    queueSeconds: 3,
    stage: "summarize",
    stages: [],
    dlq: true,
    error: {
      code: "QueueRetriesExhaustedError",
      message: "queue delivery retries exhausted (upstream stayed rate-limited)",
      stage: "summarize",
      retryable: true,
    },
  },
  {
    name: "fail-unknown",
    state: "Failed, unknown category: unmapped error code and stage",
    id: IDS.failUnknown,
    url: "https://working-notes.example/unexpected-failure-essay",
    createdAt: "2026-08-30T19:47:00.000Z",
    queueSeconds: 3,
    stage: "query_similar",
    stages: ["queued", "fetch_source", "write_raw", "write_extracted", "embed_source", "query_similar"],
    error: {
      code: "TypeError",
      message: "Cannot read properties of undefined (reading 'score')",
      stage: "query_similar",
    },
  },
];

/**
 * Build the full seed plan. `nowIso` stamps only the pending fixture; every
 * other timestamp is static, so the plan (and its enforcing test) is
 * deterministic given the clock.
 */
export function buildLocalSeed(nowIso: string): LocalSeedPlan {
  const assembled: AssembledFixture[] = [
    ...READY_SPECS.map(assembleReady),
    ...FAILED_SPECS.map(assembleFailed),
  ];

  // Pending: a fresh submit, drafted exactly as intake writes it, stamped from
  // the seed clock so read-time staleness does not flip it on arrival.
  const pendingId = IDS.pending;
  const pendingUrl = "https://fieldnotes.example/making-room-for-slow-work";
  const pendingHash = urlHash(pendingUrl);
  const pendingPrefix = buildKeyPrefix(pendingId, nowIso);
  const pendingAttemptId = attemptIdOf(pendingId, 1);
  const { manifest: pendingManifest, attempt: pendingAttemptSummary } =
    submitPending(
      {
        id: pendingId,
        url: pendingUrl,
        urlHash: pendingHash,
        createdAt: nowIso,
      },
      { attemptId: pendingAttemptId, startedAt: nowIso },
    );
  const pendingAttempt: ProcessingAttempt = ProcessingAttemptSchema.parse({
    ...pendingAttemptSummary,
    reading_id: pendingId,
    url: pendingUrl,
    url_hash: pendingHash,
    key_prefix: pendingPrefix,
    events: [{ stage: "queued", status: "started", at: nowIso }],
  });
  assembled.push({
    fixture: {
      name: "pending",
      state: "Pending: fresh submit with a running attempt, staged from the seed clock (refreshes only by re-seeding once the 15-minute TTL passes)",
      id: pendingId,
      keyPrefix: pendingPrefix,
      manifest: pendingManifest,
      attemptIds: [pendingAttemptId],
    },
    objects: [
      seedManifest(pendingPrefix, pendingManifest),
      seedPointer(layout.byIdKey(pendingId), pendingPrefix, pendingId),
      seedPointer(layout.byUrlKey(pendingHash), pendingPrefix, pendingId),
      {
        key: layout.attemptKey(pendingPrefix, pendingAttemptId),
        body: JSON.stringify(pendingAttempt),
        contentType: "application/json",
      },
    ],
  });

  const objects: LocalSeedObject[] = [];
  // Newest first, matching the store's created_at sort, so a raw read of
  // index/list.json reads in library order.
  const sorted = [...assembled].sort((a, b) =>
    a.fixture.manifest.created_at < b.fixture.manifest.created_at ? 1 : -1,
  );
  for (const item of sorted) {
    objects.push(...item.objects);
  }
  const items: ListIndexItem[] = sorted.map((item) =>
    manifestToIndexItem(item.fixture.manifest, item.fixture.keyPrefix),
  );
  const listIndex: ListIndex = { version: 1, items };
  objects.push({
    key: layout.listIndexKey(),
    body: JSON.stringify(listIndex),
    contentType: "application/json",
  });

  return {
    fixtures: sorted.map((item) => item.fixture),
    objects,
    listIndex,
    removedTargetId: LOCAL_SEED_REMOVED_TARGET_ID,
  };
}
