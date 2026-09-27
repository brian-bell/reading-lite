import { describe, expect, it } from "vitest";
import {
  MARKDOWN_IMPORT_BUDGET_BYTES as APP_BUDGET,
  MARKDOWN_IMPORT_MAX_BYTES as APP_MAX,
} from "../../../app/src/markdown-import-limit";
import { MARKDOWN_SUBMIT_BUDGET_BYTES } from "../../../scripts/extract-agent-lib/gates";
import { MARKDOWN_IMPORT_MAX_BYTES } from "../../../scripts/import-markdown-lib/parse";
import { INBOX_MARKDOWN_MAX_BYTES, INBOX_STAGE_BUDGET_BYTES } from "../../../src/schemas/api";

// The /save Markdown tab (#408) refuses an oversized paste before sending it,
// by its own copy of the queue limit: app/ cannot import the operator
// modules, which read the filesystem. This keeps the copy honest, so the
// browser and the operator gates refuse the same pastes.

describe("the app's Markdown import limit", () => {
  it("is the operator tooling's queue limit and submit budget", () => {
    expect(APP_MAX).toBe(MARKDOWN_IMPORT_MAX_BYTES);
    expect(APP_BUDGET).toBe(MARKDOWN_SUBMIT_BUDGET_BYTES);
  });

  it("is the Worker inbox's stage limit", () => {
    expect(INBOX_MARKDOWN_MAX_BYTES).toBe(MARKDOWN_IMPORT_MAX_BYTES);
    expect(INBOX_STAGE_BUDGET_BYTES).toBe(MARKDOWN_SUBMIT_BUDGET_BYTES);
  });
});
