// The local fixture pack as PostgreSQL rows, shared by `npm run seed:local` and
// the parity suite so both seed exactly what the R2 plan describes. URL
// ownership is read off the plan's by-url pointers rather than assumed.

import { localSeedEmbedding, type LocalSeedPlan } from "../../test/fixtures/local-seed";
import { ByUrlPointerSchema } from "../../src/schemas/manifest";
import { r2KeyLayout } from "../../src/modules/stores/layout";
import { manifestToRows, type ReadingRows } from "./manifest-rows";

export function localSeedRows(plan: LocalSeedPlan, tenantId: string): ReadingRows[] {
  const layout = r2KeyLayout("");
  const bodies = new Map(plan.objects.map((object) => [object.key, object.body]));
  return plan.fixtures.map((fixture) => {
    const pointer = bodies.get(layout.byUrlKey(fixture.manifest.url_hash));
    const ownsUrl = pointer !== undefined && ByUrlPointerSchema.parse(JSON.parse(pointer)).id === fixture.id;
    return manifestToRows(fixture.manifest, {
      tenantId,
      keyPrefix: fixture.keyPrefix,
      ownsUrl,
      embedding: fixture.manifest.status === "ready" ? localSeedEmbedding(fixture.id) : undefined,
    });
  });
}
