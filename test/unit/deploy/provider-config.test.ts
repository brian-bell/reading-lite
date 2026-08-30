import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function envVar(
  wrangler: string,
  env: "staging" | "production",
  key: string,
): string | undefined {
  const re = new RegExp(
    `\\[env\\.${env}\\.vars\\][\\s\\S]*?^${key} = "([^"]*)"$`,
    "m",
  );
  return wrangler.match(re)?.[1];
}

describe("checked-in summarizer provider configuration", () => {
  it("uses high OpenAI effort in staging and production; local stays low", () => {
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
        /^OPENAI_SUMMARIZATION_REASONING_EFFORT = "high"$/gm,
      ),
    ).toHaveLength(2);
    expect(
      wrangler.match(
        /\[env\.staging\.vars\][\s\S]*?^OPENAI_SUMMARIZATION_REASONING_EFFORT = "high"$/m,
      ),
    ).toHaveLength(1);
    expect(
      wrangler.match(
        /\[env\.production\.vars\][\s\S]*?^OPENAI_SUMMARIZATION_REASONING_EFFORT = "high"$/m,
      ),
    ).toHaveLength(1);
    expect(
      wrangler.match(/^ANTHROPIC_MODEL = "claude-sonnet-5"$/gm),
    ).toHaveLength(3);
    expect(
      wrangler.match(
        /^ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low"$/gm,
      ),
    ).toHaveLength(1);
    expect(
      wrangler.match(
        /^ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "high"$/gm,
      ),
    ).toHaveLength(2);
    expect(
      wrangler.match(
        /\[env\.staging\.vars\][\s\S]*?^ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "high"$/m,
      ),
    ).toHaveLength(1);
    expect(
      wrangler.match(
        /\[env\.production\.vars\][\s\S]*?^ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "high"$/m,
      ),
    ).toHaveLength(1);
  });

  it("keeps staging summarizer knobs identical to production", () => {
    const wrangler = read("wrangler.toml");
    const keys = [
      "SUMMARIZER_PROVIDER",
      "OPENAI_SUMMARIZATION_MODEL",
      "OPENAI_SUMMARIZATION_REASONING_EFFORT",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SUMMARIZATION_REASONING_EFFORT",
    ] as const;
    for (const key of keys) {
      expect(envVar(wrangler, "staging", key)).toBe(
        envVar(wrangler, "production", key),
      );
    }
    expect(envVar(wrangler, "production", "SUMMARIZER_PROVIDER")).toBe(
      "openai",
    );
    expect(envVar(wrangler, "production", "OPENAI_SUMMARIZATION_MODEL")).toBe(
      "gpt-5.6-terra",
    );
    expect(
      envVar(wrangler, "production", "OPENAI_SUMMARIZATION_REASONING_EFFORT"),
    ).toBe("high");
    expect(envVar(wrangler, "production", "ANTHROPIC_MODEL")).toBe(
      "claude-sonnet-5",
    );
    expect(
      envVar(wrangler, "production", "ANTHROPIC_SUMMARIZATION_REASONING_EFFORT"),
    ).toBe("high");
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
    expect(testConfig).toContain('ANTHROPIC_MODEL = "claude-sonnet-5"');
    expect(testConfig).toContain(
      'ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low"',
    );

    const devExample = read(".dev.vars.example");
    expect(devExample).toContain("SUMMARIZER_PROVIDER=openai");
    expect(devExample).toContain("OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra");
    expect(devExample).toContain("OPENAI_SUMMARIZATION_REASONING_EFFORT=low");
    expect(devExample).toContain("ANTHROPIC_MODEL=claude-sonnet-5");
    expect(devExample).toContain("ANTHROPIC_SUMMARIZATION_REASONING_EFFORT=low");

    const stgExample = read(".stg.vars.example");
    expect(stgExample).toContain("SUMMARIZER_PROVIDER=openai");
    expect(stgExample).toContain("OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra");
    expect(stgExample).toContain("OPENAI_SUMMARIZATION_REASONING_EFFORT=high");
    expect(stgExample).toContain("ANTHROPIC_MODEL=claude-sonnet-5");
    expect(stgExample).toContain(
      "ANTHROPIC_SUMMARIZATION_REASONING_EFFORT=high",
    );
  });
});
