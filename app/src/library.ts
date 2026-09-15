import { z } from "zod";
import { ApiError } from "./api/errors";
import {
  ProcessingAttemptSchema,
  ReadingErrorSchema,
  ReadingStatusSchema,
  absent,
  actingTenantOf,
  type Declared,
  messageOf,
} from "./reading";
import { forwardedFrom, type BackendReads } from "./server/backend-reads";

// The library's rows from GET /api/readings (#413), read through the backend
// entrypoint during a server render and from same-origin /api/readings in the
// browser. Both paths map the response here, as reading.ts does for detail.
//
// The response is `{ readings, limit, offset, has_more }` with list-index rows
// (src/schemas/api.ts, ListReadingsResponseSchema). Like the reading
// projection, the row schema declares what the library renders or will render
// (status badges, tags, the reprocess-failed badge) and lets everything else
// through untouched. Only `id`, `url`, and `status` are load-bearing.

export const LibraryRowSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  status: ReadingStatusSchema,
  title: absent(z.string()),
  tldr: absent(z.string()),
  tags: absent(z.array(z.string())),
  created_at: absent(z.string()),
  error: absent(ReadingErrorSchema),
  active_attempt: absent(ProcessingAttemptSchema),
  last_attempt: absent(ProcessingAttemptSchema),
});
export type LibraryRow = Declared<z.output<typeof LibraryRowSchema>>;

export const LibraryPageSchema = z.looseObject({
  readings: z.array(LibraryRowSchema),
  limit: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
});
export interface LibraryPage {
  readings: LibraryRow[];
  limit: number;
  offset: number;
  has_more: boolean;
}

/**
 * What the library asks the backend for. Empty filters mean none. The page
 * size is the backend's: it is not a parameter here or on the entrypoint.
 */
export interface LibraryParams {
  q?: string;
  tag?: string;
  offset: number;
}

export function libraryQueryKey(params: LibraryParams): readonly unknown[] {
  return ["library", { q: params.q || undefined, tag: params.tag || undefined, offset: params.offset }];
}

/**
 * What a reader sees for one library page. As ReadingResult: the statuses
 * with a page of their own are values that dehydrate; a 401 and anything
 * unexpected throw.
 */
export type LibraryResult =
  | { state: "ready"; page: LibraryPage }
  | { state: "forbidden" }
  | { state: "account-changed"; acting_tenant?: string };

export function libraryFromResponse(status: number, body: unknown): LibraryResult {
  if (status === 200) {
    const parsed = LibraryPageSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "library returned an unexpected body");
    return { state: "ready", page: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `library returned ${status}`);
}

/** Server renders: forward the incoming Cookie header and host, pinned to this render's identity. */
export async function readLibraryFromBackend(
  backend: BackendReads,
  request: Request,
  params: LibraryParams,
  expectedTenant: string | undefined,
): Promise<LibraryResult> {
  let result;
  try {
    // The entrypoint's input schema is strict: absent values stay absent.
    result = await backend.list({
      ...forwardedFrom(request),
      ...(params.q ? { q: params.q } : {}),
      ...(params.tag ? { tag: params.tag } : {}),
      offset: params.offset,
      ...(expectedTenant === undefined ? {} : { expectedTenant }),
    });
  } catch (err) {
    throw new ApiError(0, `backend entrypoint failed: ${String(err)}`);
  }
  return libraryFromResponse(result.status, result.body);
}
