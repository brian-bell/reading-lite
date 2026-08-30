import { describe, expect, it } from "vitest";
import { buildSummarizeRequestBody } from "../../../src/modules/anthropic";
import type { SimilarContext } from "../../../src/modules/summarizer";

const input = (similar: SimilarContext[]) => ({
  url: "https://example.com/a",
  extractedText: "# Body\n\ntext",
  title: "A",
  similarReadings: similar,
});

function userText(similar: SimilarContext[]): string {
  const body = buildSummarizeRequestBody(input(similar), "claude-sonnet-5", "low");
  return JSON.stringify(body);
}

describe("similar-readings prompt block", () => {
  it("describes each neighbour with its tldr, not just its title", () => {
    const t = userText([
      { id: "rd_b", url: "https://b.com", title: "B", tldr: "B argues something specific." },
    ]);
    expect(t).toContain("B argues something specific.");
  });

  it("shows the measured similarity so closeness is not guessed from titles", () => {
    const t = userText([{ id: "rd_b", url: "https://b.com", title: "B", score: 0.82 }]);
    expect(t).toMatch(/0\.82/);
  });

  it("still renders a neighbour that has neither score nor tldr", () => {
    const t = userText([{ id: "rd_old", url: "https://old.com", title: "Old" }]);
    expect(t).toContain("rd_old");
    expect(t).toContain("Old");
  });

  it("keeps the no-neighbours branch reachable", () => {
    expect(userText([])).toContain("no prior readings");
  });
});
