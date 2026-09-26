import type { QueryClient } from "@tanstack/react-query";
import { reprocessFromResponse, type ReprocessOutcome } from "../reprocess";
import { postCapture } from "./capture";

// Browser path for Retry and Reprocess (#410): POST
// /api/readings/:id/reprocess through the shared capture request
// (api/capture.ts). The body is always `{}`: no `force`, no `email`, and no
// Markdown source, which is Import a copy's (#411).

export function reprocessReading(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
): Promise<ReprocessOutcome> {
  return postCapture(
    queryClient,
    `/api/readings/${encodeURIComponent(id)}/reprocess`,
    {},
    expectedTenant,
    reprocessFromResponse,
  );
}
