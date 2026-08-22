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

  it("keeps punctuation that carries meaning, wherever it sits in the tag", () => {
    // "c++" must not normalize to "c", nor "c#" to "c" -- either would silently
    // merge a language tag into a different, plausible-looking one.
    expect(normalizeTag("C++")).toBe("c++");
    expect(normalizeTag("C#")).toBe("c#");
  });

  it("keeps meaningful punctuation when a word boundary follows it", () => {
    // Regression: the old length-comparison guard inserted a hyphen per word
    // boundary, and those hyphens cancelled out the stripped characters, so the
    // fallback never fired. Trailing punctuation ("c++") was the only shape
    // that happened to work.
    expect(normalizeTag("f# music")).toBe("f#-music");
    expect(normalizeTag("c# developers")).toBe("c#-developers");
    expect(normalizeTag("c++ concurrency")).toBe("c++-concurrency");
  });

  it("keeps combining marks inside a word", () => {
    // \p{L} alone excludes combining marks, which shatters any script that
    // uses them: Devanagari vowel signs and the virama are marks, not letters.
    expect(normalizeTag("हिन्दी")).toBe("हिन्दी");
    // Decomposed "naive" + U+0308 must match the precomposed spelling, or two
    // visually identical tags stay distinct forever.
    expect(normalizeTag("nai\u0308ve")).toBe(normalizeTag("naïve"));
  });

  it("never keeps a partial sigil run", () => {
    // Regression: `[+#]+` backtracked to satisfy the lookahead, so "C++17"
    // became "c+-17" -- half a sigil, which is meaningless either way.
    // A run is kept whole or dropped whole.
    expect(normalizeTag("C++17")).toBe("c-17");
    expect(normalizeTag("c+++x")).toBe("c-x");
    expect(normalizeTag("ai##ml")).toBe("ai-ml");
  });

  it("only keeps a sigil that ends the token", () => {
    // "+"/"#" belong to c++ and f#, but between two words they are a boundary.
    // Otherwise "AI+ML" and "AI ML" would not collapse.
    expect(normalizeTag("AI+ML")).toBe("ai-ml");
    expect(normalizeTag("AI#ML")).toBe("ai-ml");
    expect(normalizeTag("AI+ML")).toBe(normalizeTag("AI ML"));
  });

  it("does not hyphenate inside a non-ASCII word", () => {
    // Regression: the old keep-list was /[a-z0-9]+/, so any accented or
    // non-Latin letter was treated as a separator.
    expect(normalizeTag("naïve")).toBe("naïve");
    expect(normalizeTag("Café Culture")).toBe("café-culture");
    expect(normalizeTag("日本語")).toBe("日本語");
  });

  it("returns empty for input that is only separators or punctuation", () => {
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTag("---")).toBe("");
    expect(normalizeTag("!!!")).toBe("");
  });

  it("treats ordinary punctuation as a word boundary, not as content", () => {
    // Otherwise "AI, ML" and "AI ML" would no longer collapse onto one tag,
    // which is the whole point of the module.
    expect(normalizeTag("AI, ML")).toBe("ai-ml");
    expect(normalizeTag("Node.js")).toBe("node-js");
    expect(normalizeTag("AI, ML")).toBe(normalizeTag("AI ML"));
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
