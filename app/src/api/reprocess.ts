import type { QueryClient } from "@tanstack/react-query";
import type { ReprocessMarkdownBody } from "../import-markdown";
import { reprocessFromResponse, type ReprocessOutcome } from "../reprocess";
import { postCapture } from "./capture";

// Browser path for Retry, Reprocess (#410), and Import a copy (#411): POST
// /api/readings/:id/reprocess through the shared capture request
// (api/capture.ts). The body is `{}`, or Import a copy's Markdown source; it
// never carries `force` or `email`.

export function reprocessReading(
  queryClient: QueryClient,
  id: string,
  expectedTenant: string | undefined,
  body: ReprocessMarkdownBody | Record<string, never> = {},
): Promise<ReprocessOutcome> {
  return postCapture(
    queryClient,
    `/api/readings/${encodeURIComponent(id)}/reprocess`,
    body,
    expectedTenant,
    reprocessFromResponse,
  );
}
