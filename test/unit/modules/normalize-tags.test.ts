import { describe, expect, it } from "vitest";
import { normalizeTag, normalizeTags } from "../../../src/modules/tags";

describe("normalizeTag", () => {
  it("lowercases", () => {
    expect(normalizeTag("AI")).toBe("ai");
    expect(normalizeTag("Developer Tools")).toBe("developer-tools");
  });

  it("joins words with hyphens", () => {
    expect(normalizeTag("software engineering")).toBe("software-engineering");
  });

  it("leaves an already-canonical tag alone", () => {
    expect(normalizeTag("developer-tools")).toBe("developer-tools");
  });

  it("collapses the real corpus variants onto one form", () => {
    // These are the pairs actually splitting the corpus today.
    expect(normalizeTag("developer tools")).toBe(normalizeTag("developer-tools"));
    expect(normalizeTag("software engineering")).toBe(normalizeTag("software-engineering"));
  });

  it("trims and collapses runs of whitespace", () => {
    expect(normalizeTag("  spaced   out  ")).toBe("spaced-out");
  });

  it("collapses repeated and edge hyphens", () => {
    expect(normalizeTag("ai--agents")).toBe("ai-agents");
    expect(normalizeTag("-ai-")).toBe("ai");
  });

  it("treats underscores and slashes as word separators", () => {
    expect(normalizeTag("ai_agents")).toBe("ai-agents");
    expect(normalizeTag("ai/ml")).toBe("ai-ml");
  });

  it("keeps a tag whose characters would otherwise be stripped entirely", () => {
    // "c++" must not normalize to "c" -- that would silently merge it with a
    // different language, so fall back to the trimmed lowercase original.
    expect(normalizeTag("C++")).toBe("c++");
  });

  it("returns empty for input that is only separators", () => {
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTag("---")).toBe("");
  });
});

describe("normalizeTags", () => {
  it("normalizes each tag", () => {
    expect(normalizeTags(["AI", "Developer Tools"])).toEqual(["ai", "developer-tools"]);
  });

  it("dedupes tags that collapse onto the same form, keeping first-seen order", () => {
    expect(normalizeTags(["Developer Tools", "developer-tools", "ai"])).toEqual(["developer-tools", "ai"]);
  });

  it("drops tags that normalize to nothing", () => {
    expect(normalizeTags(["ai", "  ", "---"])).toEqual(["ai"]);
  });

  it("is idempotent", () => {
    const once = normalizeTags(["Software Engineering", "AI"]);
    expect(normalizeTags(once)).toEqual(once);
  });

  it("handles an empty list", () => {
    expect(normalizeTags([])).toEqual([]);
  });
});
