import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("checked-in summarizer provider configuration", () => {
  it("uses medium OpenAI effort in staging and production; local stays low", () => {
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
    ).toHaveLength(1);
    expect(
      wrangler.match(
        /^OPENAI_SUMMARIZATION_REASONING_EFFORT = "medium"$/gm,
      ),
    ).toHaveLength(2);
    expect(
      wrangler.match(
        /\[env\.staging\.vars\][\s\S]*?^OPENAI_SUMMARIZATION_REASONING_EFFORT = "medium"$/m,
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

    const devExample = read(".dev.vars.example");
    expect(devExample).toContain("SUMMARIZER_PROVIDER=openai");
    expect(devExample).toContain("OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra");
    expect(devExample).toContain("OPENAI_SUMMARIZATION_REASONING_EFFORT=low");

    const stgExample = read(".stg.vars.example");
    expect(stgExample).toContain("SUMMARIZER_PROVIDER=openai");
    expect(stgExample).toContain("OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra");
    expect(stgExample).toContain("OPENAI_SUMMARIZATION_REASONING_EFFORT=medium");
  });
});
