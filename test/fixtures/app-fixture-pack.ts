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
import type { GetReadingResponse, ListIndex } from "../../src/schemas/api";
import { buildLocalSeed, LOCAL_SEED_REMOVED_TARGET_ID } from "./local-seed";

/** Seed clock for the snapshot, and the browser clock the suite pins. */
export const APP_FIXTURE_PACK_CLOCK = "2026-09-11T10:00:00.000Z";

/** Repo-relative path of the generated file. */
export const APP_FIXTURE_PACK_PATH = "app/e2e/fixtures/fixture-pack.json";

/** Command that rewrites it. */
export const APP_FIXTURE_PACK_COMMAND = "npm run fixtures:app";

/** PENDING_TTL_SECONDS as wrangler.toml sets it; read-time staleness only. */
const PENDING_TTL_SECONDS = 900;

export interface AppFixtureEntry {
  /** The pack's stable slug (docs/design/connected/fixture-pack.md). */
  name: string;
  id: string;
  /** Status after read-time staleness, as the frontend sees it. */
  status: string;
  /** The acceptance-matrix signal this fixture represents. */
  state: string;
}

export interface AppFixturePack {
  generated_at: string;
  regenerate_with: string;
  /** Named states, in seed order. */
  fixtures: AppFixtureEntry[];
  /** `GET /api/readings/:id` bodies, keyed by reading id. */
  readings: Record<string, GetReadingResponse>;
  /** The tenant's `index/list.json`, as the list route reads it. */
  list_index: ListIndex;
  /** Referenced by `attention` but never written: the removed-target card. */
  removed_target_id: string;
}

export function buildAppFixturePack(nowIso: string = APP_FIXTURE_PACK_CLOCK): AppFixturePack {
  const plan = buildLocalSeed(nowIso);
  const readings: Record<string, GetReadingResponse> = {};
  const fixtures: AppFixtureEntry[] = [];

  for (const fixture of plan.fixtures) {
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
  }

  return {
    generated_at: nowIso,
    regenerate_with: APP_FIXTURE_PACK_COMMAND,
    fixtures,
    readings,
    list_index: plan.listIndex,
    removed_target_id: LOCAL_SEED_REMOVED_TARGET_ID,
  };
}

/** The file's exact bytes, so the emitter and the drift test agree. */
export function serializeAppFixturePack(pack: AppFixturePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}
