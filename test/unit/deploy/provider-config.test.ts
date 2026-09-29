import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// Reads `key` from exactly one TOML table. The lookup is bounded to that
// table's body (up to the next `[...]` header) so a key missing from staging
// cannot fall through to production's value and pass the comparison below.
function envVar(
  wrangler: string,
  env: "local" | "staging" | "production",
  key: string,
): string | undefined {
  const table = env === "local" ? "vars" : `env\\.${env}\\.vars`;
  const body = wrangler.match(
    new RegExp(`^\\[${table}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"),
  )?.[1];
  return body?.match(new RegExp(`^${key} = "([^"]*)"$`, "m"))?.[1];
}

describe("envVar", () => {
  it("does not fall through to a later table when the key is absent", () => {
    const toml = [
      "[vars]",
      'A = "local"',
      "",
      "[env.staging.vars]",
      'B = "staging"',
      "",
      "[[env.staging.routes]]",
      'pattern = "x"',
      "",
      "[env.production.vars]",
      'A = "production"',
      'B = "production"',
      "",
    ].join("\n");
    expect(envVar(toml, "local", "A")).toBe("local");
    expect(envVar(toml, "local", "B")).toBeUndefined();
    expect(envVar(toml, "staging", "A")).toBeUndefined();
    expect(envVar(toml, "staging", "B")).toBe("staging");
    expect(envVar(toml, "production", "A")).toBe("production");
  });
});

describe("checked-in summarizer provider configuration", () => {
  it("keeps local (top-level [vars]) on low effort for both providers", () => {
    // Staging and production are owned by the test below.
    const wrangler = read("wrangler.toml");
    expect(envVar(wrangler, "local", "SUMMARIZER_PROVIDER")).toBe("openai");
    expect(envVar(wrangler, "local", "OPENAI_SUMMARIZATION_MODEL")).toBe("gpt-5.6-terra");
    expect(envVar(wrangler, "local", "OPENAI_SUMMARIZATION_REASONING_EFFORT")).toBe("low");
    expect(envVar(wrangler, "local", "ANTHROPIC_MODEL")).toBe("claude-sonnet-5-5");
    expect(envVar(wrangler, "local", "ANTHROPIC_SUMMARIZATION_REASONING_EFFORT")).toBe("low");
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
      "anthropic",
    );
    expect(envVar(wrangler, "production", "OPENAI_SUMMARIZATION_MODEL")).toBe(
      "gpt-5.6-terra",
    );
    expect(
      envVar(wrangler, "production", "OPENAI_SUMMARIZATION_REASONING_EFFORT"),
    ).toBe("high");
    expect(envVar(wrangler, "production", "ANTHROPIC_MODEL")).toBe(
      "claude-sonnet-5-5",
    );
    expect(
      envVar(wrangler, "production", "ANTHROPIC_SUMMARIZATION_REASONING_EFFORT"),
    ).toBe("medium");
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
    expect(testConfig).toContain('ANTHROPIC_MODEL = "claude-sonnet-5-5"');
    expect(testConfig).toContain(
      'ANTHROPIC_SUMMARIZATION_REASONING_EFFORT = "low"',
    );

    const devExample = read(".dev.vars.example");
    expect(devExample).toContain("SUMMARIZER_PROVIDER=openai");
    expect(devExample).toContain("OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra");
    expect(devExample).toContain("OPENAI_SUMMARIZATION_REASONING_EFFORT=low");
    expect(devExample).toContain("ANTHROPIC_MODEL=claude-sonnet-5-5");
    expect(devExample).toContain("ANTHROPIC_SUMMARIZATION_REASONING_EFFORT=low");

    const stgExample = read(".stg.vars.example");
    expect(stgExample).toContain("SUMMARIZER_PROVIDER=anthropic");
    expect(stgExample).toContain("OPENAI_SUMMARIZATION_MODEL=gpt-5.6-terra");
    expect(stgExample).toContain("OPENAI_SUMMARIZATION_REASONING_EFFORT=high");
    expect(stgExample).toContain("ANTHROPIC_MODEL=claude-sonnet-5-5");
    expect(stgExample).toContain(
      "ANTHROPIC_SUMMARIZATION_REASONING_EFFORT=medium",
    );
  });
});
