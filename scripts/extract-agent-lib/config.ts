// Agent configuration resolved from an injected vars map (the CLI composes
// `{...loadDotVars(".extract-agent.vars"), ...process.env}`). No process.env
// reads in here so tests can drive every branch.

export interface AgentConfig {
  api: { base: string; token: string };
  healthcheckUrl?: string;
  maxPaidActions: number;
  maxAttempts: number;
  fetchMaxBytes: number;
  minArticleChars: number;
  statePath: string;
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
  return {
    api: { base: vars.READING_API_URL!.replace(/\/$/, ""), token: vars.READER_API_TOKEN! },
    // Resolved but deliberately unread in Phase 1: the dead-man ping that
    // consumes it lands in Phase 2 (reading-lite-x1u.3), alongside the run
    // report and lockfile. Setting it now is inert, not broken.
    healthcheckUrl: vars.HEALTHCHECK_URL || undefined,
    maxPaidActions: positiveInt(vars, "AGENT_MAX_PAID_ACTIONS", 25),
    maxAttempts: positiveInt(vars, "AGENT_MAX_ATTEMPTS", 3),
    fetchMaxBytes: positiveInt(vars, "AGENT_FETCH_MAX_BYTES", 20 * 1024 * 1024),
    minArticleChars: positiveInt(vars, "AGENT_MIN_ARTICLE_CHARS", 350),
    statePath: vars.AGENT_STATE_PATH || `${homedir}/.reading-lite/extract-agent.state.json`,
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
