import { describe, expect, it } from "vitest";
import {
  firstProblemField,
  MARKDOWN_TOO_LARGE,
  markdownImportBody,
  markdownImportBytes,
  markdownImportProblems,
  type MarkdownImportValues,
} from "../src/import-markdown";
import { MARKDOWN_IMPORT_BUDGET_BYTES } from "../src/markdown-import-limit";

// The Markdown import's rules and body, without a DOM. The field rules mirror
// the backend's PostReadingsImportMarkdownBodySchema (src/schemas/api.ts); the
// size rule is the queue limit the backend only meets after it has written.

const VALID: MarkdownImportValues = {
  sourceUrl: "https://fieldnotes.example/making-room-for-slow-work",
  title: "",
  markdown: "# Making room for slow work\n\nA paragraph.",
};

/** Markdown whose request body costs exactly `bytes` in the queue message. */
function markdownCosting(bytes: number, values: MarkdownImportValues = VALID): string {
  const framing = markdownImportBytes(markdownImportBody({ ...values, markdown: "" }));
  return "a".repeat(bytes - framing);
}

describe("markdownImportBody", () => {
  it("sends the source URL trimmed and the Markdown exactly as pasted", () => {
    expect(markdownImportBody({ sourceUrl: "  https://example.com/a\n", title: "", markdown: "  # A\n\n" })).toEqual({
      source_url: "https://example.com/a",
      markdown: "  # A\n\n",
    });
  });

  it("sends a title trimmed", () => {
    expect(markdownImportBody({ ...VALID, title: "  A title  " }).title).toBe("A title");
  });

  // The backend refuses a title that trims to nothing; a blank one is none.
  it.each(["", "   "])("leaves a blank title out (%j)", (title) => {
    expect(markdownImportBody({ ...VALID, title })).not.toHaveProperty("title");
  });
});

describe("markdownImportProblems", () => {
  it("has nothing to say about values that can be tried", () => {
    expect(markdownImportProblems(VALID)).toEqual({});
    expect(markdownImportProblems({ ...VALID, title: "A title" })).toEqual({});
  });

  it("asks for the source URL in its own words", () => {
    expect(markdownImportProblems({ ...VALID, sourceUrl: " " })).toEqual({
      sourceUrl: "Enter the URL the Markdown came from.",
    });
  });

  // The rest of the URL rule is the URL save's (save.test.ts owns its cases),
  // in the import's words.
  it("applies the URL save's rule to the source URL", () => {
    expect(markdownImportProblems({ ...VALID, sourceUrl: "ftp://example.com/a" })).toEqual({
      sourceUrl: "Only http and https source URLs can be imported.",
    });
  });

  it.each(["", " \n\t "])("asks for Markdown when there is none (%j)", (markdown) => {
    expect(markdownImportProblems({ ...VALID, markdown })).toEqual({
      markdown: "Paste the Markdown you want to import.",
    });
  });

  it("reports every field it refuses at once", () => {
    expect(markdownImportProblems({ sourceUrl: "", title: "", markdown: "" })).toEqual({
      sourceUrl: "Enter the URL the Markdown came from.",
      markdown: "Paste the Markdown you want to import.",
    });
  });

  describe("the queue limit", () => {
    it("accepts a body that costs exactly the budget", () => {
      expect(markdownImportProblems({ ...VALID, markdown: markdownCosting(MARKDOWN_IMPORT_BUDGET_BYTES) })).toEqual({});
    });

    it("refuses a body one byte over it", () => {
      expect(markdownImportProblems({ ...VALID, markdown: markdownCosting(MARKDOWN_IMPORT_BUDGET_BYTES + 1) })).toEqual({
        markdown: MARKDOWN_TOO_LARGE,
      });
    });

    // The queue carries the serialized message: multibyte characters and the
    // escapes JSON adds both count, which is why a character count is wrong.
    it.each([
      ["multibyte text", "é", 2],
      ["quotes, which JSON escapes", '"', 2],
      ["backslashes, which JSON escapes", "\\", 2],
    ])("measures %s at their serialized cost", (_, character, cost) => {
      const count = Math.ceil(MARKDOWN_IMPORT_BUDGET_BYTES / cost);
      // Under the budget by length, over it once serialized.
      expect(count).toBeLessThan(MARKDOWN_IMPORT_BUDGET_BYTES);
      expect(markdownImportProblems({ ...VALID, markdown: character.repeat(count) })).toEqual({
        markdown: MARKDOWN_TOO_LARGE,
      });
    });

    // The title and source URL travel in the same message.
    it("counts the title against the same budget", () => {
      const markdown = markdownCosting(MARKDOWN_IMPORT_BUDGET_BYTES);
      expect(markdownImportProblems({ ...VALID, title: "A title", markdown })).toEqual({
        markdown: MARKDOWN_TOO_LARGE,
      });
    });
  });
});

describe("firstProblemField", () => {
  it("is the first field the form shows that has a problem", () => {
    expect(firstProblemField({ markdown: "m", sourceUrl: "s" })).toBe("sourceUrl");
    expect(firstProblemField({ markdown: "m" })).toBe("markdown");
    expect(firstProblemField({})).toBeUndefined();
  });
});
