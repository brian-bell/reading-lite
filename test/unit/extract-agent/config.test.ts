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
      maxRenders: 10,
      fetchMaxBytes: 20 * 1024 * 1024,
      minArticleChars: 350,
      statePath: "/home/agent/.reading-lite/extract-agent.state.json",
      runLogPath: "/home/agent/.reading-lite/extract-agent.runs.jsonl",
      runLogMaxBytes: 5 * 1024 * 1024,
      lockPath: "/home/agent/.reading-lite/extract-agent.lock",
      lockMaxAgeSeconds: 10800,
      healthcheckFailUrl: undefined,
      email: false,
    });
  });

  it("moves the derived run-log and lock paths with the state dir", () => {
    const config = resolveAgentConfig({
      vars: { ...REQUIRED, AGENT_STATE_PATH: "/var/lib/agent/state.json" },
      homedir: "/home/agent",
    });
    expect(config.runLogPath).toBe("/var/lib/agent/extract-agent.runs.jsonl");
    expect(config.lockPath).toBe("/var/lib/agent/extract-agent.lock");
  });

  it("lets explicit run-log and lock paths win over the derivation", () => {
    const config = resolveAgentConfig({
      vars: {
        ...REQUIRED,
        AGENT_STATE_PATH: "/var/lib/agent/state.json",
        AGENT_RUN_LOG_PATH: "/var/log/agent/runs.jsonl",
        AGENT_LOCK_PATH: "/run/agent.lock",
      },
      homedir: "/home/agent",
    });
    expect(config.runLogPath).toBe("/var/log/agent/runs.jsonl");
    expect(config.lockPath).toBe("/run/agent.lock");
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
        HEALTHCHECK_FAIL_URL: "https://hc.example/ping/fail",
        AGENT_MAX_PAID_ACTIONS: "5",
        AGENT_MAX_ATTEMPTS: "2",
        AGENT_MAX_RENDERS: "4",
        AGENT_FETCH_MAX_BYTES: "1048576",
        AGENT_MIN_ARTICLE_CHARS: "100",
        AGENT_STATE_PATH: "/var/lib/agent/state.json",
        AGENT_RUN_LOG_PATH: "/var/log/agent/runs.jsonl",
        AGENT_RUN_LOG_MAX_BYTES: "1024",
        AGENT_LOCK_PATH: "/run/agent.lock",
        AGENT_LOCK_MAX_AGE_SECONDS: "60",
        AGENT_EMAIL: "true",
      },
      homedir: "/home/agent",
    });
    expect(config).toEqual({
      api: { base: REQUIRED.READING_API_URL, token: "tok_test" },
      healthcheckUrl: "https://hc.example/ping",
      maxPaidActions: 5,
      maxAttempts: 2,
      maxRenders: 4,
      fetchMaxBytes: 1048576,
      minArticleChars: 100,
      statePath: "/var/lib/agent/state.json",
      runLogPath: "/var/log/agent/runs.jsonl",
      runLogMaxBytes: 1024,
      lockPath: "/run/agent.lock",
      lockMaxAgeSeconds: 60,
      healthcheckFailUrl: "https://hc.example/ping/fail",
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
    for (const key of ["AGENT_MAX_PAID_ACTIONS", "AGENT_LOCK_MAX_AGE_SECONDS", "AGENT_RUN_LOG_MAX_BYTES"]) {
      for (const bad of ["nope", "-1", "0"]) {
        expect(() =>
          resolveAgentConfig({ vars: { ...REQUIRED, [key]: bad }, homedir: "/h" }),
        ).toThrow(new RegExp(key));
      }
    }
  });
});
