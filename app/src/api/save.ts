import type { QueryClient } from "@tanstack/react-query";
import type { MarkdownImportBody } from "../import-markdown";
import { submitFromResponse, type SubmitOutcome } from "../save";
import { postCapture } from "./capture";

// Browser path for saving a URL (#431) and importing Markdown (#408):
// POST /api/readings or /api/readings/import-markdown through the shared
// capture request (api/capture.ts). Both answer with the same intake outcomes
// (src/router.ts `respondIntake`), read by submitFromResponse.

export function submitReading(
  queryClient: QueryClient,
  url: string,
  expectedTenant: string | undefined,
): Promise<SubmitOutcome> {
  return postCapture(queryClient, "/api/readings", { url }, expectedTenant, submitFromResponse);
}

export function importMarkdown(
  queryClient: QueryClient,
  body: MarkdownImportBody,
  expectedTenant: string | undefined,
): Promise<SubmitOutcome> {
  return postCapture(queryClient, "/api/readings/import-markdown", body, expectedTenant, submitFromResponse);
}
