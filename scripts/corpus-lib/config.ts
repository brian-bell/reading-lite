import { loadDotVars } from "../lib/dotvars";
import type { R2Config, VectorizeConfig } from "../lib/cf-clients";

export const DEFAULT_BUCKET = "reading-lite";
export const DEFAULT_API_BASE = "https://reading-lite.bbell.dev";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

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
  vectorize: VectorizeConfig;
  anthropicApiKey: string;
  anthropicModel: string;
  openaiApiKey: string;
}

// Credentials for the bulk batch path. R2 (S3) + Vectorize come from .corpus.vars
// (CORPUS_*); the Anthropic/OpenAI keys and model come from .dev.vars/.prd.vars
// (the same names the worker uses). A flat var map is injected so this is
// testable; production reads env + the dot files.
export function resolveBatchConfig(
  flags: { bucket?: string },
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

  const accountId = need("CORPUS_R2_ACCOUNT_ID");
  const accessKeyId = need("CORPUS_R2_ACCESS_KEY");
  const secretAccessKey = need("CORPUS_R2_SECRET_KEY");
  const bucket =
    flags.bucket ?? vars.CORPUS_R2_BUCKET ?? vars.READING_LITE_BUCKET ?? DEFAULT_BUCKET;
  const cfApiToken = need("CORPUS_CF_API_TOKEN");
  const anthropicApiKey = need("ANTHROPIC_API_KEY");
  const openaiApiKey = need("OPENAI_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `missing batch config: ${missing.join(", ")} (set in env or .corpus.vars/.dev.vars)`,
    );
  }

  return {
    r2: { accountId, accessKeyId, secretAccessKey, bucket },
    vectorize: {
      accountId: vars.CORPUS_VECTORIZE_ACCOUNT_ID ?? accountId,
      index: vars.CORPUS_VECTORIZE_INDEX ?? bucket,
      apiToken: cfApiToken,
    },
    anthropicApiKey,
    anthropicModel: vars.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    openaiApiKey,
  };
}
