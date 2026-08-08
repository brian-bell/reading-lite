import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("checked-in summarizer provider configuration", () => {
  it("uses medium OpenAI effort in production while local and staging stay low", () => {
    const wrangler = read("wrangler.toml");

    expect(
      wrangler.match(/^SUMMARIZER_PROVIDER = "openai"$/gm),
    ).toHaveLength(3);
    expect(
      wrangler.match(
        /^OPENAI_SUMMARIZATION_MODEL = "gpt-5\.6-terra"$/gm,
      ),
    ).toHaveLength(3);
    expect(
      wrangler.match(
        /^OPENAI_SUMMARIZATION_REASONING_EFFORT = "low"$/gm,
      ),
    ).toHaveLength(2);
    expect(
      wrangler.match(
        /^OPENAI_SUMMARIZATION_REASONING_EFFORT = "medium"$/gm,
      ),
    ).toHaveLength(1);
    expect(
      wrangler.match(
        /\[env\.production\.vars\][\s\S]*?^OPENAI_SUMMARIZATION_REASONING_EFFORT = "medium"$/m,
      ),
    ).toHaveLength(1);
    expect(
      wrangler.match(/^ANTHROPIC_MODEL = "claude-sonnet-4-6"$/gm),
    ).toHaveLength(3);
  });

  it("keeps test and dotenv examples aligned with the provider variables", () => {
    const testConfig = read("wrangler.test.toml");
    expect(testConfig).toContain('SUMMARIZER_PROVIDER = "openai"');
    expect(testConfig).toContain(
      'OPENAI_SUMMARIZATION_MODEL = "gpt-5.6-terra"',
    );
    expect(testConfig).toContain(
      'OPENAI_SUMMARIZATION_REASONING_EFFORT = "low"',
    );

    for (const path of [".dev.vars.example", ".stg.vars.example"]) {
      const example = read(path);
      expect(example).toContain("SUMMARIZER_PROVIDER=openai");
      expect(example).toContain(
        "OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra",
      );
      expect(example).toContain(
        "OPENAI_SUMMARIZATION_REASONING_EFFORT=low",
      );
    }
  });
});
