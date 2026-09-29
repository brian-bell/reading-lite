import { z } from "zod";
import type { AccountRead, AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// Provider settings from /api/auth/provider (reading-lite-gh341.8; ADR 0004):
// the reader's own OpenAI key, shown masked, the summary effort, and the daily
// spending cap, with today's charges from /api/auth/provider/usage. Fetched in
// the browser only, like the rest of the account pages (ADR 0003). The
// projections mirror ProviderSettingsResponseSchema and
// ProviderUsageResponseSchema (src/schemas/api.ts); unknown fields pass
// through, and a malformed one is the retryable "unexpected body" error rather
// than a crash in a component. No response ever carries the key itself.

export const EffortSchema = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof EffortSchema>;

const CredentialSchema = z.looseObject({
  provider: z.string().min(1),
  last_four: z.string(),
  status: z.enum(["active", "invalid"]),
  validated_at_ms: z.number().nullable(),
});

const Microdollars = z.number().int().positive();

export const ProviderSettingsSchema = z.looseObject({
  credential: CredentialSchema.nullable(),
  effort: EffortSchema,
  daily_spend_cap_microdollars: Microdollars.nullable(),
  effective_daily_spend_microdollars: Microdollars,
  operator_daily_spend_microdollars: Microdollars,
});
/** The fields this app reads; the schema lets the rest pass through. */
export interface ProviderSettings {
  credential: {
    provider: string;
    last_four: string;
    status: "active" | "invalid";
    validated_at_ms: number | null;
  } | null;
  effort: Effort;
  /** The reader's own cap, or null when they have not lowered it. */
  daily_spend_cap_microdollars: number | null;
  /** The cap the spend guard admits against: the smaller of the two. */
  effective_daily_spend_microdollars: number;
  /** The hosting limit: the reader's cap may be lower, never higher. */
  operator_daily_spend_microdollars: number;
}

export const ProviderUsageSchema = z.looseObject({
  day_key: z.string().min(1),
  charged_microdollars: z.number().int().nonnegative(),
  effective_daily_spend_microdollars: Microdollars,
  reset_at_ms: z.number(),
  observed_at_ms: z.number(),
});
export interface ProviderUsage {
  day_key: string;
  /** Today's charges as the guard counts them: holds for running requests at their most. */
  charged_microdollars: number;
  effective_daily_spend_microdollars: number;
  reset_at_ms: number;
  observed_at_ms: number;
}

/** Account-scoped, so sign-in and sign-out drop them (src/auth/session.ts). */
export function providerQueryKey(userId: string): readonly unknown[] {
  return ["provider", userId];
}
export function providerUsageQueryKey(userId: string): readonly unknown[] {
  return ["provider-usage", userId];
}

export type ProviderResult = AccountRead<ProviderSettings>;
export type ProviderUsageResult = AccountRead<ProviderUsage>;

export function providerFromResponse(status: number, body: unknown): ProviderResult {
  if (status === 200) return { state: "ready", value: parsedSettings(body) };
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `provider settings returned ${status}`);
}

/**
 * Today's charges. A 503 is the guard not answering; it throws like any
 * other failure, and the page says so beside the cap rather than over it.
 */
export function usageFromResponse(status: number, body: unknown): ProviderUsageResult {
  if (status === 200) {
    const parsed = ProviderUsageSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "usage returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `usage returned ${status}`);
}

const RECENT_AUTH_REQUIRED = "recent authentication required";

/** Why OpenAI's check refused a key (ProviderKeyRejection in the control plane). */
export type KeyRejection = "invalid_key" | "model_access";

/**
 * What POST /api/auth/provider answered. The backend checks the key with
 * OpenAI before storing it: `rejected` is OpenAI refusing it, and
 * `provider-unavailable` is OpenAI not answering, so nothing was stored
 * either way. `invalid` is a body the backend refused before asking. A 403
 * that names recent authentication is `step-up`; any other 403 or a 412
 * refuses the account. A 401 and anything else throw.
 */
export type KeyConnectOutcome =
  | { kind: "saved"; settings: ProviderSettings }
  | { kind: "rejected"; reason: KeyRejection }
  | { kind: "invalid" }
  | { kind: "provider-unavailable" }
  | { kind: "step-up" }
  | AccountRefusal;

export function keyConnectFromResponse(status: number, body: unknown): KeyConnectOutcome {
  if (status === 200) return { kind: "saved", settings: parsedSettings(body) };
  const code = codeOf(body);
  if (status === 400) {
    return code === "invalid_key" || code === "model_access" ? { kind: "rejected", reason: code } : { kind: "invalid" };
  }
  if (status === 503 && code === "provider_unavailable") return { kind: "provider-unavailable" };
  return refusalOf(status, body) ?? throwFailure(status, body, "failed to connect the key");
}

/** What DELETE /api/auth/provider answered: the settings with no key, or a refusal. */
export type KeyRemoveOutcome = { kind: "saved"; settings: ProviderSettings } | { kind: "step-up" } | AccountRefusal;

export function keyRemoveFromResponse(status: number, body: unknown): KeyRemoveOutcome {
  if (status === 200) return { kind: "saved", settings: parsedSettings(body) };
  return refusalOf(status, body) ?? throwFailure(status, body, "failed to remove the key");
}

/**
 * POST /api/auth/provider/preferences (PostProviderPreferencesBodySchema):
 * either field, or both. A null cap puts the hosting limit back.
 */
export interface PreferencesBody {
  effort?: Effort;
  daily_spend_cap_microdollars?: number | null;
}

/**
 * What the preferences save answered. `cap-above` is a cap over the hosting
 * limit, which may have been lowered since the page loaded. The route needs
 * no recent sign-in, so every 403 refuses the account.
 */
export type PreferencesSaveOutcome =
  | { kind: "saved"; settings: ProviderSettings }
  | { kind: "cap-above" }
  | { kind: "invalid" }
  | AccountRefusal;

export function preferencesSaveFromResponse(status: number, body: unknown): PreferencesSaveOutcome {
  if (status === 200) return { kind: "saved", settings: parsedSettings(body) };
  if (status === 400) return codeOf(body) === "cap_above_operator_default" ? { kind: "cap-above" } : { kind: "invalid" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to save provider preferences");
}

/**
 * The key's state as the page names it. The backend has no removed state:
 * a removed key is no key. `removed` is a removal made on this visit, so the
 * page can say what removing it changed.
 */
export type KeyState =
  | { kind: "missing" }
  | { kind: "removed" }
  | { kind: "connected"; lastFour: string; validatedAtMs: number | null }
  | { kind: "invalid"; lastFour: string };

export function keyStateOf(settings: ProviderSettings, removedHere: boolean): KeyState {
  const credential = settings.credential;
  if (credential === null) return removedHere ? { kind: "removed" } : { kind: "missing" };
  if (credential.status === "invalid") return { kind: "invalid", lastFour: credential.last_four };
  return { kind: "connected", lastFour: credential.last_four, validatedAtMs: credential.validated_at_ms };
}

/** The backend's key bounds (PostProviderKeyBodySchema): 4 to 256 characters, no whitespace. */
const KEY_MIN = 4;
const KEY_MAX = 256;

/** The field's value checked before any request; the key sent is the trimmed value. */
export function keyInputError(value: string): "empty" | "malformed" | null {
  const key = value.trim();
  if (key === "") return "empty";
  if (key.length < KEY_MIN || key.length > KEY_MAX || /\s/.test(key)) return "malformed";
  return null;
}

const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const CENT = 10_000;

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Dollars and cents; a charge under a cent says so rather than rounding to nothing. */
export function formatUsd(microdollars: number): string {
  if (microdollars > 0 && microdollars < CENT) return "less than $0.01";
  return USD.format(microdollars / MICRODOLLARS_PER_DOLLAR);
}

/** A cap as the field's value: plain dollars and cents, no symbol. */
export function dollarsOf(microdollars: number): string {
  return (microdollars / MICRODOLLARS_PER_DOLLAR).toFixed(2);
}

/**
 * The cap field read as a new cap. Dollars with up to two decimal places, an
 * optional leading `$`; more than zero, and no more than the hosting limit,
 * since the reader may only lower it.
 */
export type CapInput =
  | { kind: "cap"; microdollars: number }
  | { kind: "empty" }
  | { kind: "zero" }
  | { kind: "invalid" }
  | { kind: "above" };

export function capFromDollars(value: string, operatorMicrodollars: number): CapInput {
  const text = value.trim().replace(/^\$\s*/, "");
  if (text === "") return { kind: "empty" };
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return { kind: "invalid" };
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  const microdollars = cents * CENT;
  if (!Number.isSafeInteger(microdollars)) return { kind: "invalid" };
  if (microdollars === 0) return { kind: "zero" };
  if (microdollars > operatorMicrodollars) return { kind: "above" };
  return { kind: "cap", microdollars };
}

function parsedSettings(body: unknown): ProviderSettings {
  const parsed = ProviderSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, "provider settings returned an unexpected body");
  return parsed.data;
}

function codeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** A key write's 403 (step-up or the account refused) or 412; undefined for anything else. */
function refusalOf(status: number, body: unknown): { kind: "step-up" } | AccountRefusal | undefined {
  if (status === 403) return messageOf(body) === RECENT_AUTH_REQUIRED ? { kind: "step-up" } : { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  return undefined;
}

function throwFailure(status: number, body: unknown, fallback: string): never {
  throw new ApiError(status, messageOf(body) ?? fallback);
}
