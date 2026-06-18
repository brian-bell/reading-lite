import { describe, expect, it } from "vitest";
import { resolveBatchConfig } from "../../../../scripts/corpus-lib/config";

const full = {
  MIGRATE_R2_ACCOUNT_ID: "acct",
  MIGRATE_R2_ACCESS_KEY: "ak",
  MIGRATE_R2_SECRET_KEY: "sk",
  MIGRATE_R2_BUCKET: "reading-lite",
  MIGRATE_CF_API_TOKEN: "cf",
  MIGRATE_VECTORIZE_ACCOUNT_ID: "acct",
  MIGRATE_VECTORIZE_INDEX: "reading-lite",
  ANTHROPIC_API_KEY: "sk-ant",
  OPENAI_API_KEY: "sk-oa",
  ANTHROPIC_MODEL: "claude-opus-4-8",
};

describe("resolveBatchConfig", () => {
  it("resolves r2, vectorize, keys, and model from env-like vars", () => {
    const cfg = resolveBatchConfig({}, { vars: full });
    expect(cfg.r2).toEqual({ accountId: "acct", accessKeyId: "ak", secretAccessKey: "sk", bucket: "reading-lite" });
    expect(cfg.vectorize).toEqual({ accountId: "acct", index: "reading-lite", apiToken: "cf" });
    expect(cfg.anthropicApiKey).toBe("sk-ant");
    expect(cfg.openaiApiKey).toBe("sk-oa");
    expect(cfg.anthropicModel).toBe("claude-opus-4-8");
  });

  it("defaults the model when unset", () => {
    const { ANTHROPIC_MODEL, ...noModel } = full;
    void ANTHROPIC_MODEL;
    expect(resolveBatchConfig({}, { vars: noModel }).anthropicModel).toBe("claude-sonnet-4-6");
  });

  it("lets --bucket override the configured bucket and defaults the index to it", () => {
    const { MIGRATE_VECTORIZE_INDEX, ...noIndex } = full;
    void MIGRATE_VECTORIZE_INDEX;
    const cfg = resolveBatchConfig({ bucket: "reading-lite-staging" }, { vars: noIndex });
    expect(cfg.r2.bucket).toBe("reading-lite-staging");
    expect(cfg.vectorize.index).toBe("reading-lite-staging");
  });

  it("throws listing all missing required fields", () => {
    expect(() => resolveBatchConfig({}, { vars: { ANTHROPIC_API_KEY: "x" } })).toThrow(/MIGRATE_R2_ACCOUNT_ID/);
  });
});
