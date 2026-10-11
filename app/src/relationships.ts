import { z } from "zod";
import type { AccountRead } from "./account-state";
import { ApiError } from "./api/errors";
import { ReadingStatusSchema, absent, actingTenantOf, messageOf, type Declared } from "./reading";
import { forwardedFrom, type BackendReads } from "./server/backend-reads";

// The tenant's relationship graph from GET /api/readings/relationships
// (reading-lite-kl7y.3), read through the backend entrypoint during the
// Threads pages' server render and from same-origin /api/readings/relationships
// in the browser, where the reading page asks for it after hydration. Both
// paths map the response here, as library.ts does for the list.
//
// The response (src/schemas/api.ts, GetReadingRelationshipsResponseSchema) is
// every ready reading plus any other reading at either end of a listed
// relationship, and every stored relationship row whose target is live. The
// derivations over it (threads, tension pairs) are threads.ts.

export const GraphReadingSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  status: ReadingStatusSchema,
  title: absent(z.string()),
  tags: absent(z.array(z.string())),
  created_at: z.string(),
});
export type GraphReading = Declared<z.output<typeof GraphReadingSchema>>;

/**
 * One stored row, from its source's point of view. `kind` and `tension_kind`
 * are closed enums in the backend, open here so a kind added later still
 * joins its readings rather than failing the page.
 */
export const GraphRowSchema = z.looseObject({
  source_id: z.string(),
  target_id: z.string(),
  kind: z.string(),
  tension_kind: absent(z.string()),
  reason: z.string(),
});
export type GraphRow = Declared<z.output<typeof GraphRowSchema>>;

export const RelationshipGraphSchema = z.looseObject({
  readings: z.array(GraphReadingSchema),
  relationships: z.array(GraphRowSchema),
});
export interface RelationshipGraph {
  readings: GraphReading[];
  relationships: GraphRow[];
}

/** Account-scoped like the reading's key, so sign-in and sign-out drop it (src/auth/session.ts). */
export const relationshipsQueryKey: readonly unknown[] = ["relationships"];

/** As an account read: the statuses with a page of their own are values; a 401 and anything unexpected throw. */
export type RelationshipsResult = AccountRead<RelationshipGraph>;

export function relationshipsFromResponse(status: number, body: unknown): RelationshipsResult {
  if (status === 200) {
    const parsed = RelationshipGraphSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "relationships returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `relationships returned ${status}`);
}

/** Server renders: forward the incoming Cookie header and host, pinned to this render's identity. */
export async function readRelationshipsFromBackend(
  backend: BackendReads,
  request: Request,
  expectedTenant: string | undefined,
): Promise<RelationshipsResult> {
  let result;
  try {
    result = await backend.relationships({
      ...forwardedFrom(request),
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    });
  } catch (err) {
    throw new ApiError(0, `backend entrypoint failed: ${String(err)}`);
  }
  return relationshipsFromResponse(result.status, result.body);
}
