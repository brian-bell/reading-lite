// Agent configuration resolved from an injected vars map (the CLI composes
// `{...loadDotVars(".extract-agent.vars"), ...process.env}`). No process.env
// reads in here so tests can drive every branch.

import { dirname, join } from "node:path";

export interface AgentConfig {
  api: { base: string; token: string };
  healthcheckUrl?: string;
  healthcheckFailUrl?: string;
  maxPaidActions: number;
  maxAttempts: number;
  fetchMaxBytes: number;
  minArticleChars: number;
  statePath: string;
  // Siblings of the state file: overriding AGENT_STATE_PATH alone relocates the
  // whole agent state directory coherently. Both stay independently overridable.
  runLogPath: string;
  runLogMaxBytes: number;
  lockPath: string;
  lockMaxAgeSeconds: number;
  email: boolean;
}

export interface ConfigDeps {
  vars: Record<string, string | undefined>;
  homedir: string;
}

export function resolveAgentConfig({ vars, homedir }: ConfigDeps): AgentConfig {
  const missing = ["READING_API_URL", "READER_API_TOKEN"].filter((key) => !vars[key]);
  if (missing.length > 0) {
    throw new Error(`extract-agent config: missing required var(s): ${missing.join(", ")}`);
  }
  const statePath = vars.AGENT_STATE_PATH || `${homedir}/.reading-lite/extract-agent.state.json`;
  const stateDir = dirname(statePath);
  return {
    api: { base: vars.READING_API_URL!.replace(/\/$/, ""), token: vars.READER_API_TOKEN! },
    healthcheckUrl: vars.HEALTHCHECK_URL || undefined,
    healthcheckFailUrl: vars.HEALTHCHECK_FAIL_URL || undefined,
    maxPaidActions: positiveInt(vars, "AGENT_MAX_PAID_ACTIONS", 25),
    maxAttempts: positiveInt(vars, "AGENT_MAX_ATTEMPTS", 3),
    fetchMaxBytes: positiveInt(vars, "AGENT_FETCH_MAX_BYTES", 20 * 1024 * 1024),
    minArticleChars: positiveInt(vars, "AGENT_MIN_ARTICLE_CHARS", 350),
    statePath,
    runLogPath: vars.AGENT_RUN_LOG_PATH || join(stateDir, "extract-agent.runs.jsonl"),
    runLogMaxBytes: positiveInt(vars, "AGENT_RUN_LOG_MAX_BYTES", 5 * 1024 * 1024),
    lockPath: vars.AGENT_LOCK_PATH || join(stateDir, "extract-agent.lock"),
    lockMaxAgeSeconds: positiveInt(vars, "AGENT_LOCK_MAX_AGE_SECONDS", 3 * 60 * 60),
    email: vars.AGENT_EMAIL === "true" || vars.AGENT_EMAIL === "1",
  };
}

function positiveInt(vars: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = vars[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`extract-agent config: ${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}
