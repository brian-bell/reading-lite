import type { QueryClient } from "@tanstack/react-query";
import { filePath, type FileKind, type FileResult } from "../reading-files";
import { contentProblem } from "../reading-source";
import { apiFetch } from "./client";
import { EXPECTED_TENANT_HEADER } from "./readings";

// Browser path for "Open as file" (#373): same-origin GET of the extracted
// Markdown or the raw capture with the session cookie, pinned like the
// reading. Fetched on click, never cached in the QueryClient: a file is
// opened, not rendered, and the tab that opens it holds the bytes. The bytes
// are never decoded here: a raw capture may be a PDF or a legacy encoding.

export async function fetchFile(
  queryClient: QueryClient,
  id: string,
  kind: FileKind,
  expectedTenant: string | undefined,
): Promise<FileResult> {
  const response = await apiFetch(queryClient, filePath(id, kind), {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
  });
  if (response.status === 200) return { state: "ready", bytes: await response.arrayBuffer() };
  return contentProblem(response.status, await response.text(), "file");
}
