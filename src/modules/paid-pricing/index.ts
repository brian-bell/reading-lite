/**
 * The runtime price catalog is intentionally small and versioned.  It is a
 * reservation catalog, not a display-price feed: a request using a model or
 * shape outside this table has no safe upper bound and must not be dispatched.
 *
 * Rates are microdollars per token, represented as hundredths of a
 * microdollar.  Keeping the unit integral avoids a floating-point money value
 * crossing the reservation boundary.
 */
export const PAID_PRICE_CATALOG_VERSION = 1;

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const RATE_DENOMINATOR = 100;
const ANTHROPIC_MAX_GEOGRAPHY_MULTIPLIER_NUMERATOR = 11;
const ANTHROPIC_MAX_GEOGRAPHY_MULTIPLIER_DENOMINATOR = 10;
// Anthropic's published tool-use overhead reaches 804 tokens (Opus 4.7).
// 1,024 covers that table plus request framing:
// https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-pricing
const PROTOCOL_OVERHEAD_TOKENS = 1_024;
const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

type Rate = number; // hundredths of one microdollar per token

interface OpenAIPriceTier {
  input: Rate;
  cached: Rate;
  cacheWrite: Rate;
  output: Rate;
}

interface OpenAIRates {
  standard: OpenAIPriceTier;
  longContext: OpenAIPriceTier;
}

interface AnthropicRates {
  input: Rate;
  cacheRead: Rate;
  cacheWrite: Rate;
  cacheWrite1h: Rate;
  output: Rate;
}

// Frozen from the official provider pricing pages on 2026-09-05:
// https://developers.openai.com/api/docs/pricing
// https://docs.anthropic.com/en/docs/about-claude/pricing
// https://platform.claude.com/docs/en/api/service-tiers
//
// Dated conservative bounds. Updating these values is a policy migration: old
// reservations retain their catalog version and must be reconciled using the
// matching catalog rather than today's display price.
const OPENAI_RESPONSE_RATES: Record<string, OpenAIRates> = {
  "gpt-5.6-sol": {
    standard: { input: 400, cached: 40, cacheWrite: 500, output: 2000 },
    longContext: { input: 800, cached: 80, cacheWrite: 1000, output: 3000 },
  },
  "gpt-5.6-terra": {
    standard: { input: 200, cached: 20, cacheWrite: 250, output: 1200 },
    longContext: { input: 400, cached: 40, cacheWrite: 500, output: 1800 },
  },
  "gpt-5.6-luna": {
    standard: { input: 20, cached: 2, cacheWrite: 25, output: 120 },
    longContext: { input: 40, cached: 4, cacheWrite: 50, output: 180 },
  },
};

const ANTHROPIC_MESSAGE_RATES: Record<string, AnthropicRates> = {
  "claude-sonnet-5": { input: 200, cacheRead: 20, cacheWrite: 250, cacheWrite1h: 400, output: 1000 },
  "claude-sonnet-4-6": { input: 300, cacheRead: 30, cacheWrite: 375, cacheWrite1h: 600, output: 1500 },
  "claude-opus-5": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-8": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-7": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-6": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-5-20251101": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite1h: 1000, output: 2500 },
};

const OPENAI_EMBEDDING_RATES: Record<string, Rate> = {
  "text-embedding-3-small": 2,
};

export type PaidProvider = "openai" | "anthropic";
export type PaidRequestKind = "embedding" | "responses" | "messages";

export interface PaidQuote {
  catalogVersion: typeof PAID_PRICE_CATALOG_VERSION;
  provider: PaidProvider;
  kind: PaidRequestKind;
  model: string;
  /** Maximum charge for this one HTTP dispatch, in integer microdollars. */
  maxMicrodollars: number;
  /** SHA-256 of the non-secret request identity, for durable dispatch records. */
  fingerprint: string;
  /** The cache-write rate selected by the validated Anthropic request shape. */
  anthropicCacheWriteRate?: Rate;
}

/**
 * Quotes exactly the provider requests this service emits.  It deliberately
 * accepts only a JSON string body: streams, form bodies, file/image inputs,
 * and unknown endpoints cannot be bounded from the data available here.
 *
 * Input tokens are bounded by one token per UTF-8 payload byte.  That is a
 * conservative encoding bound over the complete serialized request (including
 * instructions, tools, schemas, source and similar-reading context), rather
 * than the planning-only bytes/4 estimate.
 */
export async function quotePaidRequest(
  url: string,
  init: RequestInit,
): Promise<PaidQuote | null> {
  if (init.method?.toUpperCase() !== "POST" || !isJson(init.headers) || typeof init.body !== "string") {
    return null;
  }
  const body = parseJsonObject(init.body);
  if (!body) return null;
  const inputTokenCeiling = utf8Bytes(init.body) + PROTOCOL_OVERHEAD_TOKENS;
  if (!isSafeNonnegativeInteger(inputTokenCeiling)) return null;

  let quote: Omit<PaidQuote, "fingerprint"> | null = null;
  if (url === OPENAI_EMBEDDINGS_URL) {
    quote = quoteEmbedding(body, inputTokenCeiling);
  } else if (url === OPENAI_RESPONSES_URL) {
    quote = quoteOpenAIResponse(body, inputTokenCeiling);
  } else if (url === ANTHROPIC_MESSAGES_URL) {
    quote = quoteAnthropicMessage(body, inputTokenCeiling);
  }
  if (!quote) return null;

  return {
    ...quote,
    fingerprint: await sha256Hex(`${PAID_PRICE_CATALOG_VERSION}:${url}:${init.body}`),
  };
}

/**
 * Returns a reconciliable actual charge only for a fully valid provider usage
 * envelope. `null` means the reservation must remain at its maximum because
 * the response is missing, malformed, from the wrong endpoint, or exceeds the
 * original conservative quote.
 */
export function actualPaidCost(quote: PaidQuote, json: unknown): number | null {
  if (quote.catalogVersion !== PAID_PRICE_CATALOG_VERSION || !isRecord(json)) return null;
  let cost: number | null;
  switch (quote.kind) {
    case "embedding":
      cost = actualEmbeddingCost(quote, json);
      break;
    case "responses":
      cost = actualOpenAIResponseCost(quote, json);
      break;
    case "messages":
      cost = actualAnthropicMessageCost(quote, json);
      break;
  }
  return cost !== null && cost <= quote.maxMicrodollars ? cost : null;
}

function quoteEmbedding(body: Record<string, unknown>, inputTokens: number): Omit<PaidQuote, "fingerprint"> | null {
  const model = stringValue(body.model);
  const rate = model ? OPENAI_EMBEDDING_RATES[model] : undefined;
  if (!model || !rate || !hasExactKeys(body, ["model", "input"]) || !isEmbeddingInput(body.input)) return null;
  const maxMicrodollars = microdollars([{ tokens: inputTokens, rate }]);
  return maxMicrodollars === null
    ? null
    : { catalogVersion: PAID_PRICE_CATALOG_VERSION, provider: "openai", kind: "embedding", model, maxMicrodollars };
}

function quoteOpenAIResponse(body: Record<string, unknown>, inputTokens: number): Omit<PaidQuote, "fingerprint"> | null {
  const model = stringValue(body.model);
  const rates = model ? OPENAI_RESPONSE_RATES[model] : undefined;
  const outputTokens = positiveSafeInteger(body.max_output_tokens);
  if (!model || !rates || outputTokens === null || !isHostedOpenAIResponse(body)) return null;
  // A cache write is the most expensive input category.  Reserve that category
  // for every prompt; reconciliation later uses the provider's disjoint usage
  // fields so cached and cache-write tokens are never charged twice.
  const tier = openAIPriceTier(rates, inputTokens);
  const maxInputRate = Math.max(tier.input, tier.cached, tier.cacheWrite);
  const maxMicrodollars = microdollars([
    { tokens: inputTokens, rate: maxInputRate },
    { tokens: outputTokens, rate: tier.output },
  ]);
  return maxMicrodollars === null
    ? null
    : { catalogVersion: PAID_PRICE_CATALOG_VERSION, provider: "openai", kind: "responses", model, maxMicrodollars };
}

function quoteAnthropicMessage(body: Record<string, unknown>, inputTokens: number): Omit<PaidQuote, "fingerprint"> | null {
  const model = stringValue(body.model);
  const rates = model ? ANTHROPIC_MESSAGE_RATES[model] : undefined;
  const outputTokens = positiveSafeInteger(body.max_tokens);
  if (!model || !rates || outputTokens === null || !isHostedAnthropicMessage(body)) return null;
  const cacheWriteRate = anthropicCacheWriteRate(body, rates);
  if (cacheWriteRate === null) return null;
  const maxInputRate = Math.max(rates.input, rates.cacheRead, cacheWriteRate);
  const maxMicrodollars = microdollars([
    { tokens: inputTokens, rate: maxInputRate },
    { tokens: outputTokens, rate: rates.output },
  ], ANTHROPIC_MAX_GEOGRAPHY_MULTIPLIER_NUMERATOR, ANTHROPIC_MAX_GEOGRAPHY_MULTIPLIER_DENOMINATOR);
  return maxMicrodollars === null
    ? null
    : { catalogVersion: PAID_PRICE_CATALOG_VERSION, provider: "anthropic", kind: "messages", model, maxMicrodollars, anthropicCacheWriteRate: cacheWriteRate };
}

function actualEmbeddingCost(quote: PaidQuote, json: Record<string, unknown>): number | null {
  if (quote.provider !== "openai" || !responseModelMatches(quote, json)) return null;
  const rate = OPENAI_EMBEDDING_RATES[quote.model];
  const usage = recordValue(json.usage);
  const tokens = usage ? nonnegativeSafeInteger(usage.prompt_tokens) : null;
  const total = usage ? nonnegativeSafeInteger(usage.total_tokens) : null;
  return rate && tokens !== null && total === tokens ? microdollars([{ tokens, rate }]) : null;
}

function actualOpenAIResponseCost(quote: PaidQuote, json: Record<string, unknown>): number | null {
  if (quote.provider !== "openai" || !responseModelMatches(quote, json)) return null;
  const rates = OPENAI_RESPONSE_RATES[quote.model];
  const usage = recordValue(json.usage);
  if (!rates || !usage || !responseServiceTierMatches(json)) return null;
  const input = nonnegativeSafeInteger(usage.input_tokens);
  const output = nonnegativeSafeInteger(usage.output_tokens);
  const rawInputDetails = usage.input_tokens_details;
  const inputDetails = recordValue(rawInputDetails);
  if (rawInputDetails !== undefined && inputDetails === null) return null;
  const cached = inputDetails ? optionalNonnegativeSafeInteger(inputDetails.cached_tokens) : 0;
  const cacheWrite = inputDetails ? optionalNonnegativeSafeInteger(inputDetails.cache_write_tokens) : 0;
  if (input === null || output === null || cached === null || cacheWrite === null || cached + cacheWrite > input) return null;
  if (usage.total_tokens !== undefined && nonnegativeSafeInteger(usage.total_tokens) !== input + output) return null;
  const tier = openAIPriceTier(rates, input);
  return microdollars([
    { tokens: input - cached - cacheWrite, rate: tier.input },
    { tokens: cached, rate: tier.cached },
    { tokens: cacheWrite, rate: tier.cacheWrite },
    // Reasoning tokens are included in output_tokens by the Responses API.
    { tokens: output, rate: tier.output },
  ]);
}

function actualAnthropicMessageCost(quote: PaidQuote, json: Record<string, unknown>): number | null {
  if (quote.provider !== "anthropic" || !responseModelMatches(quote, json)) return null;
  const rates = ANTHROPIC_MESSAGE_RATES[quote.model];
  const usage = recordValue(json.usage);
  if (!rates || !usage) return null;
  const input = nonnegativeSafeInteger(usage.input_tokens);
  const output = nonnegativeSafeInteger(usage.output_tokens);
  const cacheRead = optionalNonnegativeSafeInteger(usage.cache_read_input_tokens);
  const cacheWrite = optionalNonnegativeSafeInteger(usage.cache_creation_input_tokens);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  // Anthropic reports the cache buckets separately from input_tokens.
  // Omitted inference_geo inherits the workspace default.  Do not send an
  // override: reserve and settle at the documented maximum US multiplier.
  return microdollars([
    { tokens: input, rate: rates.input },
    { tokens: cacheRead, rate: rates.cacheRead },
    { tokens: cacheWrite, rate: quote.anthropicCacheWriteRate ?? rates.cacheWrite },
    { tokens: output, rate: rates.output },
  ], ANTHROPIC_MAX_GEOGRAPHY_MULTIPLIER_NUMERATOR, ANTHROPIC_MAX_GEOGRAPHY_MULTIPLIER_DENOMINATOR);
}

function microdollars(
  terms: Array<{ tokens: number; rate: Rate }>,
  multiplierNumerator = 1,
  multiplierDenominator = 1,
): number | null {
  if (!isSafeNonnegativeInteger(multiplierNumerator) || !isSafeNonnegativeInteger(multiplierDenominator) || multiplierDenominator === 0) return null;
  let hundredths = 0;
  for (const { tokens, rate } of terms) {
    if (!isSafeNonnegativeInteger(tokens) || !isSafeNonnegativeInteger(rate)) return null;
    const value = tokens * rate;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(hundredths + value)) return null;
    hundredths += value;
  }
  const scaled = hundredths * multiplierNumerator;
  if (!Number.isSafeInteger(scaled)) return null;
  const denominator = RATE_DENOMINATOR * multiplierDenominator;
  if (!Number.isSafeInteger(denominator)) return null;
  const result = Math.ceil(scaled / denominator);
  return Number.isSafeInteger(result) ? result : null;
}

function isJson(headers: HeadersInit | undefined): boolean {
  const contentType = new Headers(headers).get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isEmbeddingInput(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string"));
}

function isHostedOpenAIResponse(body: Record<string, unknown>): boolean {
  const required = [
    "model", "store", "reasoning", "max_output_tokens", "instructions", "input", "text", "prompt_cache_options",
  ];
  if (!hasAllAndOnlyKeys(body, required, ["service_tier"])) return false;
  if (body.service_tier !== undefined && body.service_tier !== "default") return false;
  if (body.store !== false || typeof body.instructions !== "string" || !isOpenAITextInput(body.input)) return false;
  if (!isExactRecord(body.reasoning, ["effort"]) || typeof body.reasoning.effort !== "string") return false;
  if (!isExactRecord(body.prompt_cache_options, ["mode"]) || body.prompt_cache_options.mode !== "explicit") return false;
  const text = recordValue(body.text);
  return text !== null && hasExactKeys(text, ["format"]) && isOpenAIJsonSchemaFormat(text.format);
}

function isOpenAIJsonSchemaFormat(value: unknown): boolean {
  if (!isExactRecord(value, ["type", "name", "strict", "schema"])) return false;
  return value.type === "json_schema" && typeof value.name === "string" && value.name.length > 0 && value.strict === true && isRecord(value.schema);
}

function isOpenAITextInput(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((message) => {
    if (!isExactRecord(message, ["role", "content"]) || typeof message.role !== "string" || !Array.isArray(message.content)) return false;
    return message.content.every((part) => isExactRecord(part, ["type", "text"]) && part.type === "input_text" && typeof part.text === "string");
  });
}

function isHostedAnthropicMessage(body: Record<string, unknown>): boolean {
  if (!hasExactKeys(body, ["model", "max_tokens", "thinking", "output_config", "system", "tools", "tool_choice", "messages"])) return false;
  if (!isExactRecord(body.thinking, ["type"]) || body.thinking.type !== "disabled") return false;
  if (!isExactRecord(body.output_config, ["effort"]) || typeof body.output_config.effort !== "string") return false;
  if (!Array.isArray(body.tools) || body.tools.length === 0 || !body.tools.every(isHostedAnthropicTool)) return false;
  if (!isHostedToolChoice(body.tool_choice, body.tools)) return false;
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return false;
  const system = body.system;
  if (!(typeof system === "string" || isHostedSystemBlocks(system))) return false;
  return body.messages.every((message) =>
    isExactRecord(message, ["role", "content"]) && message.role === "user" && (typeof message.content === "string" || isTextBlocks(message.content)),
  );
}

function isHostedAnthropicTool(value: unknown): boolean {
  return isExactRecord(value, ["name", "description", "input_schema"]) && typeof value.name === "string" && value.name.length > 0 && typeof value.description === "string" && isRecord(value.input_schema);
}

function isHostedToolChoice(value: unknown, tools: unknown[]): boolean {
  if (isExactRecord(value, ["type"]) && value.type === "any") return true;
  return isExactRecord(value, ["type", "name"]) && value.type === "tool" && typeof value.name === "string" && tools.some((tool) => isRecord(tool) && tool.name === value.name);
}

function isHostedSystemBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return false;
    const cache = part.cache_control;
    return hasExactKeys(part, cache === undefined ? ["type", "text"] : ["type", "text", "cache_control"])
      && (cache === undefined || isCacheControl(cache));
  });
}

function isCacheControl(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "ephemeral") return false;
  return hasExactKeys(value, value.ttl === undefined ? ["type"] : ["type", "ttl"])
    && (value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h");
}

function anthropicCacheWriteRate(body: Record<string, unknown>, rates: AnthropicRates): Rate | null {
  if (!Array.isArray(body.system)) return rates.cacheWrite;
  for (const part of body.system) {
    if (!isRecord(part) || !isRecord(part.cache_control)) continue;
    if (part.cache_control.ttl === "1h") return rates.cacheWrite1h;
    if (part.cache_control.ttl !== undefined && part.cache_control.ttl !== "5m") return null;
  }
  return rates.cacheWrite;
}

function isTextBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(
    (part) => isExactRecord(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string",
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasAllAndOnlyKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const actual = Object.keys(value);
  return required.every((key) => key in value)
    && actual.every((key) => required.includes(key) || optional.includes(key));
}

function responseModelMatches(quote: PaidQuote, json: Record<string, unknown>): boolean {
  return !("model" in json) || (typeof json.model === "string" && json.model === quote.model);
}

function responseServiceTierMatches(json: Record<string, unknown>): boolean {
  return !("service_tier" in json) || json.service_tier === "default";
}

function openAIPriceTier(rates: OpenAIRates, inputTokens: number): OpenAIPriceTier {
  return inputTokens > OPENAI_LONG_CONTEXT_TOKENS ? rates.longContext : rates.standard;
}

function positiveSafeInteger(value: unknown): number | null {
  return isSafeNonnegativeInteger(value) && value > 0 ? value : null;
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return isSafeNonnegativeInteger(value) ? value : null;
}

function optionalNonnegativeSafeInteger(value: unknown): number | null {
  return value === undefined ? 0 : nonnegativeSafeInteger(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
