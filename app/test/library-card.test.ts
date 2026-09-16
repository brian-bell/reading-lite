import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { libraryBadge } from "../src/library-card";
import { LibraryRowSchema, type LibraryRow } from "../src/library";

// Badge selection for a library card (#415; acceptance matrix, Library:
// "Pending or failed row" and "Reprocess failed on a ready reading"). The
// rules mirror the detail page's status card, so a card and the reading it
// opens never disagree about the reading's state.

function row(fields: Partial<LibraryRow> & { status: LibraryRow["status"] }): LibraryRow {
  return { id: "rd_1", url: "https://example.com/a", ...fields };
}

const running = { id: "at_1", trigger: "reprocess", status: "running", started_at: "2026-09-10T10:00:00.000Z" };
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
  it("gives a ready reading no badge", () => {
    expect(libraryBadge(row({ status: "ready", title: "T" }))).toBeUndefined();
  });

  it("marks a pending reading as processing", () => {
    expect(libraryBadge(row({ status: "pending" }))).toEqual({ kind: "pending", label: "Processing" });
    expect(libraryBadge(row({ status: "pending", active_attempt: { ...running, trigger: "submit" } }))).toEqual({
      kind: "pending",
      label: "Processing",
    });
  });

  it("marks a ready reading under a running reprocess as processing, not reprocess failed", () => {
    expect(libraryBadge(row({ status: "ready", active_attempt: running, last_attempt: failedReprocess }))).toEqual({
      kind: "pending",
      label: "Processing",
    });
  });

  it("marks a failed reading failed, with the failure's headline", () => {
    expect(
      libraryBadge(
        row({
          status: "failed",
          error: { code: "BadStatusError", message: "bad response status 403: Forbidden", stage: "fetch_source" },
        }),
      ),
    ).toEqual({ kind: "failed", label: "Failed", message: "The page couldn't be fetched." });
  });

  it("falls back to the last attempt's error, then to a plain sentence", () => {
    expect(libraryBadge(row({ status: "failed", last_attempt: failedReprocess }))).toEqual({
      kind: "failed",
      label: "Failed",
      message: "The page couldn't be fetched.",
    });
    expect(libraryBadge(row({ status: "failed" }))).toEqual({
      kind: "failed",
      label: "Failed",
      message: "Processing failed.",
    });
  });

  it("shows the backend's message for an unknown failure, as the detail page does", () => {
    expect(
      libraryBadge(row({ status: "failed", error: { code: "TypeError", message: "Cannot read 'score'", stage: "query_similar" } })),
    ).toEqual({ kind: "failed", label: "Failed", message: "Cannot read 'score'" });
  });

  it("marks a ready reading whose last attempt is a failed reprocess", () => {
    expect(libraryBadge(row({ status: "ready", title: "T", last_attempt: failedReprocess }))).toEqual({
      kind: "reprocess-failed",
      label: "Reprocess failed",
    });
  });

  it("does not mark a ready reading whose last attempt succeeded or was not a reprocess", () => {
    expect(libraryBadge(row({ status: "ready", last_attempt: { ...failedReprocess, status: "succeeded" } }))).toBeUndefined();
    expect(libraryBadge(row({ status: "ready", last_attempt: { ...failedReprocess, trigger: "submit" } }))).toBeUndefined();
  });

  it("agrees with the fixture pack's rows", () => {
    const rows = new Map(pack.list_index.items.map((item) => [item.id, LibraryRowSchema.parse(item)]));
    const byName = (name: string) => rows.get(pack.fixtures.find((f) => f.name === name)!.id)!;
    expect(libraryBadge(byName("attention"))).toBeUndefined();
    expect(libraryBadge(byName("pending"))).toEqual({ kind: "pending", label: "Processing" });
    expect(libraryBadge(byName("fail-source-unreachable"))).toEqual({
      kind: "failed",
      label: "Failed",
      message: "The page couldn't be fetched.",
    });
    expect(libraryBadge(byName("reprocess-failed"))).toEqual({ kind: "reprocess-failed", label: "Reprocess failed" });
  });
});
