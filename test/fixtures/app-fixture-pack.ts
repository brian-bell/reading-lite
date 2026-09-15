// The browser-evidence snapshot of the local fixture pack (issue #374).
//
// `app/`'s Playwright suite runs the built frontend Worker against a stub
// backend, so it needs the fixture pack (#366) without the backend Worker, R2,
// or D1. This module projects the pack the way `GET /api/readings/:id` does —
// through the real `applyStaleness` and `projectRelationshipTargets` — into a
// plain JSON document that `scripts/emit-app-fixture-pack.ts` writes to
// app/e2e/fixtures/fixture-pack.json and the stub serves verbatim.
//
// The clock is fixed so the file is reproducible and its diffs are real
// changes; the Playwright suite pins the browser clock to the same instant, so
// the `pending` fixture never crosses the pending TTL mid-run.
//
// test/unit/fixtures/app-fixture-pack.test.ts fails when the committed file
// and this projection disagree, so adding a fixture state stays one edit in
// local-seed.ts plus `npm run fixtures:app`.

import { projectRelationshipTargets, relationshipTargetIds } from "../../src/modules/relationship-targets";
import { applyStaleness } from "../../src/modules/staleness";
import { r2KeyLayout } from "../../src/modules/stores/layout";
import type { GetReadingDiagnosticsResponse, GetReadingResponse, ListIndex } from "../../src/schemas/api";
import {
  ByUrlPointerSchema,
  ProcessingAttemptSchema,
  type ByUrlPointer,
  type ProcessingAttempt,
} from "../../src/schemas/manifest";
import { buildLocalSeed, LOCAL_SEED_REMOVED_TARGET_ID } from "./local-seed";

/** Seed clock for the snapshot, and the browser clock the suite pins. */
export const APP_FIXTURE_PACK_CLOCK = "2026-09-11T10:00:00.000Z";

/** Repo-relative path of the generated file. */
export const APP_FIXTURE_PACK_PATH = "app/e2e/fixtures/fixture-pack.json";

/** Command that rewrites it. */
export const APP_FIXTURE_PACK_COMMAND = "npm run fixtures:app";

/** PENDING_TTL_SECONDS as wrangler.toml sets it; read-time staleness only. */
const PENDING_TTL_SECONDS = 900;

/** The seed writes under the bucket root, as local R2 is laid out. */
const layout = r2KeyLayout("");

export interface AppFixtureEntry {
  /** The pack's stable slug (docs/design/connected/fixture-pack.md). */
  name: string;
  id: string;
  /** Status after read-time staleness, as the frontend sees it. */
  status: string;
  /** The acceptance-matrix signal this fixture represents. */
  state: string;
}

export interface RawCapture {
  content_type: string;
  body: string;
}

export interface AppFixturePack {
  generated_at: string;
  regenerate_with: string;
  /** Named states, in seed order. */
  fixtures: AppFixtureEntry[];
  /** `GET /api/readings/:id` bodies, keyed by reading id. */
  readings: Record<string, GetReadingResponse>;
  /**
   * `GET /api/readings/:id/content` bodies (extracted.md), keyed by reading
   * id, for the readings that have one; an id absent here 404s, as the
   * `unavailable-source` fixture does (#372).
   */
  contents: Record<string, string>;
  /**
   * `GET /api/readings/:id/diagnostics` bodies, keyed by reading id (#373).
   * Assembled the way src/router.ts assembles them, from the seed's pointers,
   * objects, and attempt logs; `uploaded` is the seed clock, since local R2's
   * upload time is whenever the seed ran.
   */
  diagnostics: Record<string, GetReadingDiagnosticsResponse>;
  /**
   * `GET /api/readings/:id/content/raw` bodies with their stored content
   * type, keyed by reading id (#373). Only ready fixtures have one; the
   * endpoint 404s for the rest, and so does the browser stub.
   */
  raws: Record<string, RawCapture>;
  /** The tenant's `index/list.json`, as the list route reads it. */
  list_index: ListIndex;
  /** Referenced by `attention` but never written: the removed-target card. */
  removed_target_id: string;
}

export function buildAppFixturePack(nowIso: string = APP_FIXTURE_PACK_CLOCK): AppFixturePack {
  const plan = buildLocalSeed(nowIso);
  const readings: Record<string, GetReadingResponse> = {};
  const contents: Record<string, string> = {};
  const diagnostics: Record<string, GetReadingDiagnosticsResponse> = {};
  const raws: Record<string, RawCapture> = {};
  const fixtures: AppFixtureEntry[] = [];
  const bodyByKey = new Map(plan.objects.map((object) => [object.key, object.body]));
  const encoder = new TextEncoder();

  for (const fixture of plan.fixtures) {
    const extracted = bodyByKey.get(layout.extractedKey(fixture.keyPrefix));
    if (typeof extracted === "string") contents[fixture.id] = extracted;
    const targetIds = relationshipTargetIds(fixture.manifest);
    const body: GetReadingResponse = {
      ...applyStaleness(fixture.manifest, PENDING_TTL_SECONDS, nowIso),
      relationship_targets:
        targetIds.length === 0
          ? {}
          : projectRelationshipTargets(targetIds, plan.listIndex, PENDING_TTL_SECONDS, nowIso),
    };
    readings[fixture.id] = body;
    fixtures.push({ name: fixture.name, id: fixture.id, status: body.status, state: fixture.state });

    const objectsPrefix = layout.readingObjectsPrefix(fixture.keyPrefix);
    const owned = plan.objects.filter((object) => object.key.startsWith(objectsPrefix));
    const attemptsPrefix = layout.attemptsPrefix(fixture.keyPrefix);
    // The endpoint's final ordering (ReadingStore.listAttempts sorts its
    // shortlist by started_at, newest first). Its 20-attempt shortlist by
    // upload time is not modelled: no fixture has more than one attempt.
    const attempts: ProcessingAttempt[] = owned
      .filter((object) => object.key.startsWith(attemptsPrefix))
      .map((object) => ProcessingAttemptSchema.parse(JSON.parse(object.body)))
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
    // Pointer verdicts as src/router.ts computes them, from the seed's own
    // pointer objects rather than assumed healthy.
    const byId = pointerAt(bodyByKey.get(layout.byIdKey(fixture.id)));
    const byUrl = pointerAt(bodyByKey.get(layout.byUrlKey(fixture.manifest.url_hash)));
    const indexItem = plan.listIndex.items.find((item) => item.id === fixture.id);
    diagnostics[fixture.id] = {
      id: fixture.id,
      key_prefix: fixture.keyPrefix,
      manifest: applyStaleness(fixture.manifest, PENDING_TTL_SECONDS, nowIso),
      index_item: indexItem ? applyStaleness(indexItem, PENDING_TTL_SECONDS, nowIso) : null,
      pointers: {
        by_id: {
          exists: byId !== undefined,
          ...(byId ? { pointer: byId } : {}),
          matches_manifest: byId?.id === fixture.id && fixture.manifest.id === fixture.id,
        },
        by_url: {
          exists: byUrl !== undefined,
          ...(byUrl ? { pointer: byUrl } : {}),
          matches_manifest: byUrl?.id === fixture.manifest.id && byUrl?.key_prefix === fixture.keyPrefix,
        },
      },
      objects: owned.map((object) => ({
        key: object.key,
        size: encoder.encode(object.body).byteLength,
        uploaded: nowIso,
      })),
      attempts,
    };

    const raw = owned.find((object) => object.key.startsWith(`${fixture.keyPrefix}/raw.`));
    if (raw) raws[fixture.id] = { content_type: raw.contentType, body: raw.body };
  }

  return {
    generated_at: nowIso,
    regenerate_with: APP_FIXTURE_PACK_COMMAND,
    fixtures,
    readings,
    contents,
    diagnostics,
    raws,
    list_index: plan.listIndex,
    removed_target_id: LOCAL_SEED_REMOVED_TARGET_ID,
  };
}

/** A seeded pointer object, when the seed wrote one. */
function pointerAt(body: string | undefined): ByUrlPointer | undefined {
  return body === undefined ? undefined : ByUrlPointerSchema.parse(JSON.parse(body));
}

/** The file's exact bytes, so the emitter and the drift test agree. */
export function serializeAppFixturePack(pack: AppFixturePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}
