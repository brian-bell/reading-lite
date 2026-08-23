import { describe, expect, it } from "vitest";
import { resolveBatchConfig } from "../../../../scripts/corpus-lib/config";

const GLOBAL_TENANT = { kind: "global", keyRoot: "", namespace: undefined } as const;

const full = {
  CORPUS_R2_ACCOUNT_ID: "acct",
  CORPUS_R2_ACCESS_KEY: "ak",
  CORPUS_R2_SECRET_KEY: "sk",
  CORPUS_R2_BUCKET: "reading-lite",
  CORPUS_CF_API_TOKEN: "cf",
  CORPUS_VECTORIZE_ACCOUNT_ID: "acct",
  CORPUS_VECTORIZE_INDEX: "reading-lite",
  ANTHROPIC_API_KEY: "sk-ant",
  OPENAI_API_KEY: "sk-oa",
  ANTHROPIC_MODEL: "claude-opus-4-8",
  OPENAI_SUMMARIZATION_MODEL: "gpt-batch",
  OPENAI_SUMMARIZATION_REASONING_EFFORT: "high",
  SUMMARIZER_PROVIDER: "openai",
};

describe("resolveBatchConfig", () => {
  it("resolves r2, vectorize, keys, and model from env-like vars", () => {
    const cfg = resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: full });
    expect(cfg.r2).toEqual({ accountId: "acct", accessKeyId: "ak", secretAccessKey: "sk", bucket: "reading-lite" });
    expect(cfg.vectorize).toEqual({ accountId: "acct", index: "reading-lite", apiToken: "cf" });
    expect(cfg.anthropicApiKey).toBe("sk-ant");
    expect(cfg.openaiApiKey).toBe("sk-oa");
    expect(cfg.anthropicModel).toBe("claude-opus-4-8");
    expect(cfg.openaiModel).toBe("gpt-batch");
    expect(cfg.openaiReasoningEffort).toBe("high");
    expect(cfg.summarizerProvider).toBe("openai");
  });

  it("defaults the model when unset", () => {
    const {
      ANTHROPIC_MODEL,
      OPENAI_SUMMARIZATION_MODEL,
      OPENAI_SUMMARIZATION_REASONING_EFFORT,
      SUMMARIZER_PROVIDER,
      ...noModel
    } = full;
    void ANTHROPIC_MODEL;
    void OPENAI_SUMMARIZATION_MODEL;
    void OPENAI_SUMMARIZATION_REASONING_EFFORT;
    void SUMMARIZER_PROVIDER;
    const cfg = resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: noModel });
    expect(cfg.anthropicModel).toBe("claude-sonnet-4-6");
    expect(cfg.openaiModel).toBe("gpt-5.6-terra");
    expect(cfg.openaiReasoningEffort).toBe("low");
    expect(cfg.summarizerProvider).toBe("openai");
  });

  it("accepts explicit Anthropic and rejects an invalid provider", () => {
    expect(
      resolveBatchConfig(
        { tenant: GLOBAL_TENANT },
        { vars: { ...full, SUMMARIZER_PROVIDER: "anthropic" } },
      ).summarizerProvider,
    ).toBe("anthropic");
    expect(() =>
      resolveBatchConfig(
        { tenant: GLOBAL_TENANT },
        { vars: { ...full, SUMMARIZER_PROVIDER: "other" } },
      ),
    ).toThrow(/invalid SUMMARIZER_PROVIDER: other/);
  });

  it("requires only credentials relevant to a new run while always keeping the embedding key", () => {
    const { ANTHROPIC_API_KEY, ...openAIOnly } = full;
    void ANTHROPIC_API_KEY;
    expect(
      resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: openAIOnly }),
    ).toMatchObject({
      summarizerProvider: "openai",
      anthropicApiKey: "",
      openaiApiKey: "sk-oa",
    });

    const { ANTHROPIC_API_KEY: missingAnthropic, ...anthropicMissing } = {
      ...full,
      SUMMARIZER_PROVIDER: "anthropic",
    };
    void missingAnthropic;
    expect(() =>
      resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: anthropicMissing }),
    ).toThrow(/ANTHROPIC_API_KEY/);

    const { OPENAI_API_KEY, ...missingEmbedding } = {
      ...full,
      SUMMARIZER_PROVIDER: "anthropic",
    };
    void OPENAI_API_KEY;
    expect(() =>
      resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: missingEmbedding }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("uses the pinned resume provider for credentials and provider-specific settings", () => {
    const { ANTHROPIC_API_KEY, ...withoutAnthropic } = {
      ...full,
      SUMMARIZER_PROVIDER: "anthropic",
      OPENAI_SUMMARIZATION_REASONING_EFFORT: "low",
    };
    void ANTHROPIC_API_KEY;
    expect(
      resolveBatchConfig(
        { resumeProvider: "openai", tenant: GLOBAL_TENANT },
        { vars: withoutAnthropic },
      ),
    ).toMatchObject({
      summarizerProvider: "openai",
      anthropicApiKey: "",
      openaiReasoningEffort: "low",
    });

    expect(() =>
      resolveBatchConfig(
        { resumeProvider: "anthropic", tenant: GLOBAL_TENANT },
        {
          vars: {
            ...withoutAnthropic,
            SUMMARIZER_PROVIDER: "openai",
            OPENAI_SUMMARIZATION_REASONING_EFFORT: "irrelevant",
          },
        },
      ),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("ignores an irrelevant OpenAI effort for Anthropic but validates it for OpenAI", () => {
    expect(
      resolveBatchConfig(
        { tenant: GLOBAL_TENANT },
        {
          vars: {
            ...full,
            SUMMARIZER_PROVIDER: "anthropic",
            OPENAI_SUMMARIZATION_REASONING_EFFORT: "irrelevant",
          },
        },
      ).openaiReasoningEffort,
    ).toBe("low");
    expect(() =>
      resolveBatchConfig(
        { tenant: GLOBAL_TENANT },
        {
          vars: {
            ...full,
            SUMMARIZER_PROVIDER: "openai",
            OPENAI_SUMMARIZATION_REASONING_EFFORT: "irrelevant",
          },
        },
      ),
    ).toThrow(/OPENAI_SUMMARIZATION_REASONING_EFFORT/);
  });

  it("does not parse the current provider when a resume pins its own", () => {
    expect(
      resolveBatchConfig(
        { resumeProvider: "openai", tenant: GLOBAL_TENANT },
        { vars: { ...full, SUMMARIZER_PROVIDER: "anthorpic" } },
      ).summarizerProvider,
    ).toBe("openai");
  });

  it("does not validate the current effort when an OpenAI resume pins its own effort", () => {
    expect(
      resolveBatchConfig(
        { resumeProvider: "openai", tenant: GLOBAL_TENANT },
        {
          vars: {
            ...full,
            OPENAI_SUMMARIZATION_REASONING_EFFORT: "stale-invalid-value",
          },
        },
      ).openaiReasoningEffort,
    ).toBe("low");
  });

  it("lets --bucket override the configured bucket and defaults the index to it", () => {
    const { CORPUS_VECTORIZE_INDEX, ...noIndex } = full;
    void CORPUS_VECTORIZE_INDEX;
    const cfg = resolveBatchConfig({ tenant: GLOBAL_TENANT, bucket: "reading-lite-alt" }, { vars: noIndex });
    expect(cfg.r2.bucket).toBe("reading-lite-alt");
    expect(cfg.vectorize.index).toBe("reading-lite-alt");
  });

  it("honors CORPUS_R2_BUCKET when no --bucket flag is passed (alt bucket isn't masked)", () => {
    // The CLI must pass an *absent* flag through (not a defaulted production
    // bucket), so a .corpus.vars pointing at an alternate bucket writes there.
    const alt = { ...full, CORPUS_R2_BUCKET: "reading-lite-alt", CORPUS_VECTORIZE_INDEX: "reading-lite-alt" };
    const cfg = resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: alt });
    expect(cfg.r2.bucket).toBe("reading-lite-alt");
    expect(cfg.vectorize.index).toBe("reading-lite-alt");
  });

  it("throws listing all missing required fields", () => {
    expect(() => resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: { ANTHROPIC_API_KEY: "x" } })).toThrow(/CORPUS_R2_ACCOUNT_ID/);
  });
});

// reading-lite-s1k.4.3: the tenant selection lands on the batch config as the
// R2 key root every client is wrapped with and the Vectorize namespace.
describe("resolveBatchConfig tenant scoping", () => {
  it("derives keyRoot and vectorize namespace from a tenant selection", () => {
    const tenantId = "usr_550e8400-e29b-41d4-a716-446655440000";
    const cfg = resolveBatchConfig(
      {
        tenant: { kind: "tenant", tenantId, keyRoot: `u/${tenantId}/`, namespace: tenantId },
      },
      { vars: full },
    );
    expect(cfg.keyRoot).toBe(`u/${tenantId}/`);
    expect(cfg.vectorize.namespace).toBe(tenantId);
  });

  it("keeps the global selection un-rooted and un-namespaced", () => {
    const cfg = resolveBatchConfig({ tenant: GLOBAL_TENANT }, { vars: full });
    expect(cfg.keyRoot).toBe("");
    expect(cfg.vectorize).not.toHaveProperty("namespace");
  });
});
