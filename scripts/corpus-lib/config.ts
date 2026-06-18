import { loadDotVars } from "../lib/dotvars";

export const DEFAULT_BUCKET = "reading-lite";
export const DEFAULT_API_BASE = "https://reading-lite.bbell.dev";

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
