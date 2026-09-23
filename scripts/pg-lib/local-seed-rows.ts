// The local fixture pack as PostgreSQL rows, shared by `npm run seed:local` and
// the seed-rows suite so both seed exactly what the plan describes, URL
// ownership included.

import { localSeedEmbedding, type LocalSeedPlan } from "../../test/fixtures/local-seed";
import type { ProcessingAttempt } from "../../src/schemas/manifest";
import { manifestToRows, type ReadingRows } from "./manifest-rows";

export function localSeedRows(plan: LocalSeedPlan, tenantId: string): ReadingRows[] {
  return plan.fixtures.map((fixture) =>
    manifestToRows(fixture.manifest, {
      tenantId,
      keyPrefix: fixture.keyPrefix,
      ownsUrl: fixture.ownsUrl,
      embedding: fixture.manifest.status === "ready" ? localSeedEmbedding(fixture.id) : undefined,
    }),
  );
}

export function localSeedAttempts(plan: LocalSeedPlan): ProcessingAttempt[] {
  return plan.fixtures.flatMap((fixture) => fixture.attempts);
}
