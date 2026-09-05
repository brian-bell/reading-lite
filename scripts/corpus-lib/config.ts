import { operatorTenantSelector, type OperatorTenant } from "./tenant";
import { loadDotVars } from "../lib/dotvars";
import type { R2Config, VectorizeConfig } from "../lib/cf-clients";
import {
  parseSummarizerProvider,
  type SummarizerProvider,
} from "../../src/modules/summarizer/config";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  DEFAULT_OPENAI_SUMMARIZATION_REASONING_EFFORT,
  parseAnthropicEffort,
  parseReasoningEffort,
} from "../../src/modules/summarizer";
import type {
  AnthropicReasoningEffort,
  OpenAIReasoningEffort,
} from "../../src/modules/summarizer/types";

export const DEFAULT_BUCKET = "reading-lite";
// Canonical production API origin (issue #265 S5). Override with --url /
// --api-url or READER_URL. Staging and local commands keep their own defaults.
export const DEFAULT_API_BASE = "https://readinglite.ai";
export { DEFAULT_ANTHROPIC_MODEL };

// R2 bucket to read the corpus from (read path uses wrangler / Cloudflare auth,
// not the reading API token).
export function resolveBucket(flag?: string): string {
  return flag ?? process.env.READING_LITE_BUCKET ?? DEFAULT_BUCKET;
}

export interface ApiTarget {
  base: string;
  token: string;
}

// The reading API base + bearer token for write actions (reprocess / import).
// Token precedence: flag → READER_API_TOKEN env → .prd.vars → .dev.vars.
export function resolveApiTarget(flags: { url?: string; token?: string }): ApiTarget {
  const base = (flags.url ?? process.env.READER_URL ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const token =
    flags.token ??
    process.env.READER_API_TOKEN ??
    loadDotVars(".prd.vars").READER_API_TOKEN ??
    loadDotVars(".dev.vars").READER_API_TOKEN ??
    "";
  return { base, token };
}

export interface BatchConfig {
  r2: R2Config;
  /**
   * Tenant key root every batch R2 client is wrapped with (withKeyRoot):
   * "" for the pre-tenant global layout, u/{tenantId}/ for one tenant.
   */
  keyRoot: string;
  /** The validated --tenant selector ('global' or usr_…), for sidecar stamping. */
  tenantSelector: string;
  /**
   * The resolved selector itself, so a caller that needs more than the key root
   * and the string form — the vector ledger needs the tenant id, and needs to
   * know `global` is not one — does not have to re-parse it (issue #195 S3).
   */
  tenant: OperatorTenant;
  vectorize: VectorizeConfig;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiReasoningEffort: OpenAIReasoningEffort;
  anthropicReasoningEffort: AnthropicReasoningEffort;
  summarizerProvider: SummarizerProvider;
}

// Credentials for the bulk batch path. R2 (S3) + Vectorize come from .corpus.vars
// (CORPUS_*); provider keys/models come from .dev.vars/.prd.vars (the same
// names the worker uses). OpenAI is always required for embeddings. Anthropic
// is required only for a new Anthropic run or a sidecar-pinned Anthropic resume.
// A flat var map is injected so this is testable; production reads env + files.
export function resolveBatchConfig(
  flags: { bucket?: string; resumeProvider?: SummarizerProvider; tenant: OperatorTenant },
  deps?: { vars?: Record<string, string | undefined> },
): BatchConfig {
  const vars =
    deps?.vars ??
    {
      ...loadDotVars(".dev.vars"),
      ...loadDotVars(".prd.vars"),
      ...loadDotVars(".corpus.vars"),
      ...process.env,
    };

  const missing: string[] = [];
  const need = (key: string): string => {
    const v = vars[key];
    if (!v) missing.push(key);
    return v ?? "";
  };

  // A sidecar-pinned resume must stay independent of later env changes, so the
  // current SUMMARIZER_PROVIDER is not even parsed when a resume pins its own.
  const summarizerProvider =
    flags.resumeProvider ?? parseSummarizerProvider(vars.SUMMARIZER_PROVIDER);
  const accountId = need("CORPUS_R2_ACCOUNT_ID");
  const accessKeyId = need("CORPUS_R2_ACCESS_KEY");
  const secretAccessKey = need("CORPUS_R2_SECRET_KEY");
  const bucket =
    flags.bucket ?? vars.CORPUS_R2_BUCKET ?? vars.READING_LITE_BUCKET ?? DEFAULT_BUCKET;
  const cfApiToken = need("CORPUS_CF_API_TOKEN");
  const anthropicApiKey = vars.ANTHROPIC_API_KEY ?? "";
  if (summarizerProvider === "anthropic" && !anthropicApiKey) {
    missing.push("ANTHROPIC_API_KEY");
  }
  const openaiApiKey = need("OPENAI_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `missing batch config: ${missing.join(", ")} (set in env or .corpus.vars/.dev.vars)`,
    );
  }

  return {
    r2: { accountId, accessKeyId, secretAccessKey, bucket },
    keyRoot: flags.tenant.keyRoot,
    tenantSelector: operatorTenantSelector(flags.tenant),
    tenant: flags.tenant,
    vectorize: {
      accountId: vars.CORPUS_VECTORIZE_ACCOUNT_ID ?? accountId,
      index: vars.CORPUS_VECTORIZE_INDEX ?? bucket,
      apiToken: cfApiToken,
      ...(flags.tenant.namespace === undefined ? {} : { namespace: flags.tenant.namespace }),
    },
    anthropicApiKey,
    anthropicModel: vars.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    openaiApiKey,
    openaiModel:
      vars.OPENAI_SUMMARIZATION_MODEL ?? DEFAULT_OPENAI_SUMMARIZATION_MODEL,
    openaiReasoningEffort:
      summarizerProvider === "openai" && flags.resumeProvider === undefined
        ? parseReasoningEffort(
            vars.OPENAI_SUMMARIZATION_REASONING_EFFORT,
          )
        : DEFAULT_OPENAI_SUMMARIZATION_REASONING_EFFORT,
    anthropicReasoningEffort:
      summarizerProvider === "anthropic" && flags.resumeProvider === undefined
        ? parseAnthropicEffort(
            vars.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
            vars.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
          )
        : DEFAULT_ANTHROPIC_SUMMARIZATION_REASONING_EFFORT,
    summarizerProvider,
  };
}
