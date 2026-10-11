// The browser-evidence snapshot of the local fixture pack (issue #374).
//
// `app/`'s Playwright suite runs the built frontend Worker against a stub
// backend, so it needs the fixture pack (#366) without the backend Worker, R2,
// or PostgreSQL. This module projects the pack the way `GET /api/readings/:id` does —
// through the real `applyStaleness` and `projectRelationshipTargets` — into a
// plain JSON document that `scripts/emit-app-fixture-pack.ts` writes to
// app/e2e/fixtures/fixture-pack.json and the stub serves verbatim.
//
// The clock is fixed so the file is reproducible and its diffs are real
// changes; the Playwright suite pins the browser clock to the same instant, so
// the `pending` fixture never crosses the pending TTL mid-run (and
// `stale-pending`, 40 minutes older, is always past it).
//
// test/unit/operator-guards.test.ts fails when the committed file
// and this projection disagree, so adding a fixture state stays one edit in
// local-seed.ts plus `npm run fixtures:app`.

import {
  projectRelationshipGraph,
  projectRelationshipTargets,
  relationshipTargetIds,
} from "../../src/modules/relationship-targets";
import { applyStaleness } from "../../src/modules/staleness";
import { r2KeyLayout } from "../../src/modules/stores/layout";
import { manifestToRows } from "../../src/modules/stores/postgres/manifest-rows";
import { TensionKindSchema } from "../../src/schemas/manifest";
import type {
  GetReadingDiagnosticsResponse,
  GetReadingRelationshipsResponse,
  GetReadingResponse,
  InboxItem,
  ListIndex,
  RelationshipRow,
} from "../../src/schemas/api";
import { buildLocalSeed, LOCAL_SEED_REMOVED_TARGET_ID, type LocalSeedFixture } from "./local-seed";

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
   * Assembled the way src/router.ts assembles them from rows: the reading is
   * its own by-id pointer and its URL's owner, `objects` is its captured
   * content, and `attempts` its log, newest first. `uploaded` is the seed
   * clock, since local R2's upload time is whenever the seed ran.
   */
  diagnostics: Record<string, GetReadingDiagnosticsResponse>;
  /**
   * `GET /api/readings/:id/content/raw` bodies with their stored content
   * type, keyed by reading id (#373). Only ready fixtures have one; the
   * endpoint 404s for the rest, and so does the browser stub.
   */
  raws: Record<string, RawCapture>;
  /**
   * The tenant's list rows, newest first, as the list route serves them:
   * after read-time staleness, so `stale-pending` lists as failed, and with
   * each row's `connection_count` and `tension_count`.
   */
  list_index: ListIndex;
  /**
   * The `GET /api/readings/relationships` body, assembled as the store's
   * relationshipGraph query and the router assemble it from rows: the rows
   * whose target is a live reading, by source id, kind and position, and the
   * ready readings plus any reading at either end of one.
   */
  relationships: GetReadingRelationshipsResponse;
  /** Referenced by `attention` but never written: the removed-target card. */
  removed_target_id: string;
  /**
   * `GET /api/inbox/:id` bodies, newest first as `GET /api/inbox` lists
   * them; the list route serves each without its `markdown`.
   */
  inbox: InboxItem[];
}

export function buildAppFixturePack(nowIso: string = APP_FIXTURE_PACK_CLOCK): AppFixturePack {
  const plan = buildLocalSeed(nowIso);
  const readings: Record<string, GetReadingResponse> = {};
  const contents: Record<string, string> = {};
  const diagnostics: Record<string, GetReadingDiagnosticsResponse> = {};
  const raws: Record<string, RawCapture> = {};
  const fixtures: AppFixtureEntry[] = [];
  const bodyByKey = new Map(plan.objects.map((object) => [object.key, object.body]));
  const urlOwners = new Map(plan.fixtures.filter((f) => f.ownsUrl).map((f) => [f.manifest.url_hash, f]));
  const encoder = new TextEncoder();
  const rows = relationshipRows(plan.fixtures);
  const ends = new Set(rows.flatMap((row) => [row.source_id, row.target_id]));

  for (const fixture of plan.fixtures) {
    const extracted = bodyByKey.get(layout.extractedKey(fixture.keyPrefix));
    if (typeof extracted === "string") contents[fixture.id] = extracted;
    const targetIds = relationshipTargetIds(fixture.manifest);
    const body: GetReadingResponse = {
      ...applyStaleness(fixture.manifest, PENDING_TTL_SECONDS, nowIso),
      relationship_targets:
        targetIds.length === 0
          ? {}
          : projectRelationshipTargets(targetIds, plan.listIndex.items, PENDING_TTL_SECONDS, nowIso),
    };
    readings[fixture.id] = body;
    fixtures.push({ name: fixture.name, id: fixture.id, status: body.status, state: fixture.state });

    const objectsPrefix = layout.readingObjectsPrefix(fixture.keyPrefix);
    const owned = plan.objects.filter((object) => object.key.startsWith(objectsPrefix));
    // PgReadingWriter.listAttempts orders by started_at, newest first. Its
    // 20-attempt limit is not modelled: no fixture has more than two attempts.
    const attempts = [...fixture.attempts].sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
    );
    // As src/router.ts computes them: the row is its own by-id pointer, and
    // the by-url one is whichever reading owns the URL.
    const pointer = { id: fixture.id, key_prefix: fixture.keyPrefix };
    const owner = urlOwners.get(fixture.manifest.url_hash);
    const byUrl = owner === undefined ? undefined : { id: owner.id, key_prefix: owner.keyPrefix };
    const indexItem = plan.listIndex.items.find((item) => item.id === fixture.id);
    diagnostics[fixture.id] = {
      id: fixture.id,
      key_prefix: fixture.keyPrefix,
      manifest: applyStaleness(fixture.manifest, PENDING_TTL_SECONDS, nowIso),
      index_item: indexItem ? applyStaleness(indexItem, PENDING_TTL_SECONDS, nowIso) : null,
      pointers: {
        by_id: {
          exists: true,
          pointer,
          matches_manifest: fixture.manifest.id === fixture.id,
        },
        by_url: {
          exists: byUrl !== undefined,
          ...(byUrl ? { pointer: byUrl } : {}),
          matches_manifest: byUrl?.id === fixture.id && byUrl.key_prefix === fixture.keyPrefix,
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
    list_index: {
      ...plan.listIndex,
      items: plan.listIndex.items.map((item) => ({
        ...applyStaleness(item, PENDING_TTL_SECONDS, nowIso),
        connection_count: rows.filter((row) => row.source_id === item.id && row.kind === "connection").length,
        tension_count: rows.filter((row) => row.source_id === item.id && row.kind === "tension").length,
      })),
    },
    relationships: projectRelationshipGraph(
      {
        readings: [...plan.listIndex.items]
          .filter((item) => item.status === "ready" || ends.has(item.id))
          .sort((a, b) => byCodePoint(a.id, b.id)),
        relationships: rows,
      },
      PENDING_TTL_SECONDS,
      nowIso,
    ),
    removed_target_id: LOCAL_SEED_REMOVED_TARGET_ID,
    inbox: plan.inbox,
  };
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The rows seed:local writes for each fixture, by source id, kind and
// position, less those whose target is not a reading.
function relationshipRows(fixtures: readonly LocalSeedFixture[]): RelationshipRow[] {
  const live = new Set(fixtures.map((fixture) => fixture.id));
  return [...fixtures]
    .sort((a, b) => byCodePoint(a.id, b.id))
    .flatMap((fixture) =>
      manifestToRows(fixture.manifest, { tenantId: "usr_fixturepack", keyPrefix: fixture.keyPrefix, ownsUrl: fixture.ownsUrl })
        .relationships.sort((a, b) => byCodePoint(a.kind, b.kind) || a.position - b.position)
        .filter((row) => live.has(row.target_id))
        .map((row): RelationshipRow =>
          row.kind === "connection"
            ? { source_id: fixture.id, kind: "connection", target_id: row.target_id, reason: row.reason }
            : {
                source_id: fixture.id,
                kind: "tension",
                target_id: row.target_id,
                tension_kind: TensionKindSchema.parse(row.tension_kind),
                reason: row.reason,
              },
        ),
    );
}

/** The file's exact bytes, so the emitter and the drift test agree. */
export function serializeAppFixturePack(pack: AppFixturePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}
