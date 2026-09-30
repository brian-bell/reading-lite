import { describe, expect, it } from "vitest";
import { libraryBadge } from "../src/library-card";
import type { LibraryRow } from "../src/library";

// A library card's badge words (#415; acceptance matrix, Library: "Pending or
// failed row" and "Reprocess failed on a ready reading"). Which state a row is
// in is readingState's, owned by test/reading-state.test.ts.

function row(fields: Partial<LibraryRow> & { status: LibraryRow["status"] }): LibraryRow {
  return { id: "rd_1", url: "https://example.com/a", ...fields };
}

const failedReprocess = {
  id: "at_2",
  trigger: "reprocess",
  status: "failed",
  stage: "fetch_source",
  started_at: "2026-09-10T10:00:00.000Z",
  finished_at: "2026-09-10T10:00:10.000Z",
  error: { code: "BadStatusError", message: "bad response status 503: Service Unavailable", stage: "fetch_source" },
};

describe("libraryBadge", () => {
  it.each<{ name: string; row: LibraryRow; badge: ReturnType<typeof libraryBadge> }>([
    { name: "no badge for a ready reading", row: row({ status: "ready", title: "T" }), badge: undefined },
    { name: "Processing for a pending reading", row: row({ status: "pending" }), badge: { kind: "pending", label: "Processing" } },
    {
      name: "the failure's headline for a failed reading",
      row: row({
        status: "failed",
        error: { code: "BadStatusError", message: "bad response status 403: Forbidden", stage: "fetch_source" },
      }),
      badge: { kind: "failed", label: "Failed", message: "The page couldn't be fetched." },
    },
    {
      name: "the last attempt's headline when the manifest has no error",
      row: row({ status: "failed", last_attempt: failedReprocess }),
      badge: { kind: "failed", label: "Failed", message: "The page couldn't be fetched." },
    },
    {
      name: "a plain sentence for a failure with no error at all",
      row: row({ status: "failed" }),
      badge: { kind: "failed", label: "Failed", message: "Processing failed." },
    },
    {
      name: "the backend's message for an unknown failure, as the detail page does",
      row: row({ status: "failed", error: { code: "TypeError", message: "Cannot read 'score'", stage: "query_similar" } }),
      badge: { kind: "failed", label: "Failed", message: "Cannot read 'score'" },
    },
    {
      name: "Reprocess failed for a ready reading with a failed reprocess",
      row: row({ status: "ready", title: "T", last_attempt: failedReprocess }),
      badge: { kind: "reprocess-failed", label: "Reprocess failed" },
    },
  ])("gives $name", ({ row: input, badge }) => {
    expect(libraryBadge(input)).toEqual(badge);
  });
});
