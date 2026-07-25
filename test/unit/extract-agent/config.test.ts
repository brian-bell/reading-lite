import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../../scripts/extract-agent-lib/config";

const REQUIRED = {
  READING_API_URL: "https://reading-lite-staging.example.workers.dev",
  READER_API_TOKEN: "tok_test",
};

describe("resolveAgentConfig", () => {
  it("applies documented defaults when only the required vars are set", () => {
    const config = resolveAgentConfig({ vars: { ...REQUIRED }, homedir: "/home/agent" });
    expect(config).toEqual({
      api: { base: "https://reading-lite-staging.example.workers.dev", token: "tok_test" },
      healthcheckUrl: undefined,
      maxPaidActions: 25,
      maxAttempts: 3,
      fetchMaxBytes: 20 * 1024 * 1024,
      minArticleChars: 350,
      statePath: "/home/agent/.reading-lite/extract-agent.state.json",
      email: false,
    });
  });

  it("strips a trailing slash off the API base", () => {
    const config = resolveAgentConfig({
      vars: { ...REQUIRED, READING_API_URL: "https://reading.example/" },
      homedir: "/home/agent",
    });
    expect(config.api.base).toBe("https://reading.example");
  });

  it("lets explicit vars override every default", () => {
    const config = resolveAgentConfig({
      vars: {
        ...REQUIRED,
        HEALTHCHECK_URL: "https://hc.example/ping",
        AGENT_MAX_PAID_ACTIONS: "5",
        AGENT_MAX_ATTEMPTS: "2",
        AGENT_FETCH_MAX_BYTES: "1048576",
        AGENT_MIN_ARTICLE_CHARS: "100",
        AGENT_STATE_PATH: "/var/lib/agent/state.json",
        AGENT_EMAIL: "true",
      },
      homedir: "/home/agent",
    });
    expect(config).toEqual({
      api: { base: REQUIRED.READING_API_URL, token: "tok_test" },
      healthcheckUrl: "https://hc.example/ping",
      maxPaidActions: 5,
      maxAttempts: 2,
      fetchMaxBytes: 1048576,
      minArticleChars: 100,
      statePath: "/var/lib/agent/state.json",
      email: true,
    });
  });

  it("fails loudly when READING_API_URL or READER_API_TOKEN is missing", () => {
    expect(() => resolveAgentConfig({ vars: { READER_API_TOKEN: "t" }, homedir: "/h" })).toThrow(
      /READING_API_URL/,
    );
    expect(() => resolveAgentConfig({ vars: { READING_API_URL: "https://x.example" }, homedir: "/h" })).toThrow(
      /READER_API_TOKEN/,
    );
  });

  it("rejects non-positive or non-numeric caps", () => {
    for (const bad of ["nope", "-1", "0"]) {
      expect(() =>
        resolveAgentConfig({ vars: { ...REQUIRED, AGENT_MAX_PAID_ACTIONS: bad }, homedir: "/h" }),
      ).toThrow(/AGENT_MAX_PAID_ACTIONS/);
    }
  });
});
