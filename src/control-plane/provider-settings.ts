import { z } from "zod";
import {
  ProviderSettingsResponseSchema,
  SummarizationEffortSchema,
  SummarizationProviderSchema,
  type ProviderSettingsResponse,
  type SummarizationEffort,
  type SummarizationProvider,
} from "../schemas/api";
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";
import { PROVIDER_ANTHROPIC, ProviderNameSchema } from "./provider-credentials";

const SettingsRowSchema = z.object({
  summarization_effort: SummarizationEffortSchema,
  summarization_provider: SummarizationProviderSchema,
  daily_spend_cap_microdollars: z.number().int().positive().nullable(),
});

const LimitsRowSchema = z.object({
  daily_spend_microdollars: z.number().int().positive(),
});

const MaskRowSchema = z.object({
  provider: ProviderNameSchema,
  last_four: z.string().length(4),
  status: z.enum(["active", "invalid"]),
  validated_at: z.string().nullable(),
});

export type ProviderSettingsLoad = ProviderSettingsResponse | "not_found" | "limits_missing";

export type ProviderPreferenceResult =
  | "ok"
  | "not_found"
  | "limits_missing"
  | "cap_above_operator_default"
  | "anthropic_key_required";

/** The tenant cap the spend guard admits against: the reader may only lower the operator default. */
export function effectiveDailySpend(userCap: number | null, operator: number): number {
  return userCap === null ? operator : Math.min(userCap, operator);
}

type SpendCaps = {
  effort: SummarizationEffort;
  summarization_provider: SummarizationProvider;
  daily_spend_cap_microdollars: number | null;
  effective_daily_spend_microdollars: number;
  operator_daily_spend_microdollars: number;
};

/** The reader's effort and daily caps, as the settings page and usage view show them. */
export async function loadSpendCaps(db: ControlPlaneDb, userId: string): Promise<SpendCaps | "not_found" | "limits_missing"> {
  const settingsRow = await db.first(
    `SELECT summarization_effort, summarization_provider, daily_spend_cap_microdollars
     FROM user_settings WHERE user_id = ?`,
    userId,
  );
  if (!settingsRow) return "not_found";
  const limitsRow = await db.first(
    "SELECT daily_spend_microdollars FROM tenant_limits WHERE tenant_id = ?",
    userId,
  );
  if (!limitsRow) return "limits_missing";
  const settings = SettingsRowSchema.parse(settingsRow);
  const operator = LimitsRowSchema.parse(limitsRow).daily_spend_microdollars;
  return {
    effort: settings.summarization_effort,
    summarization_provider: settings.summarization_provider,
    daily_spend_cap_microdollars: settings.daily_spend_cap_microdollars,
    effective_daily_spend_microdollars: effectiveDailySpend(settings.daily_spend_cap_microdollars, operator),
    operator_daily_spend_microdollars: operator,
  };
}

export interface SummarizationSettings {
  provider: SummarizationProvider;
  effort: SummarizationEffort;
}

/** The reader's summarization provider and effort, or null when the user has no settings row. */
export async function readSummarizationSettings(db: ControlPlaneDb, userId: string): Promise<SummarizationSettings | null> {
  const row = await db.first(
    "SELECT summarization_provider, summarization_effort FROM user_settings WHERE user_id = ?",
    userId,
  );
  if (row === null) return null;
  const parsed = SettingsRowSchema.pick({ summarization_provider: true, summarization_effort: true }).parse(row);
  return { provider: parsed.summarization_provider, effort: parsed.summarization_effort };
}

export async function loadProviderSettings(db: ControlPlaneDb, userId: string): Promise<ProviderSettingsLoad> {
  const caps = await loadSpendCaps(db, userId);
  if (typeof caps === "string") return caps;
  const maskRows = await db.all(
    `SELECT provider, last_four, status, validated_at
     FROM tenant_provider_credentials WHERE tenant_id = ?`,
    userId,
  );
  const masks = maskRows.map((row) => MaskRowSchema.parse(row));
  const view = (provider: string) => {
    const mask = masks.find((row) => row.provider === provider);
    return mask
      ? {
          provider: mask.provider,
          last_four: mask.last_four,
          status: mask.status,
          validated_at_ms: fromTimestamp(mask.validated_at),
        }
      : null;
  };
  return ProviderSettingsResponseSchema.parse({
    credential: view("openai"),
    anthropic_credential: view(PROVIDER_ANTHROPIC),
    ...caps,
  });
}

export async function updateProviderPreferences(
  db: ControlPlaneDb,
  input: {
    userId: string;
    nowMs: number;
    effort?: SummarizationEffort;
    dailySpendCapMicrodollars?: number | null;
    summarizationProvider?: SummarizationProvider;
  },
): Promise<ProviderPreferenceResult> {
  return db.transaction(async (tx) => {
    // The settings row lock orders this against deleteProviderCredential.
    const settingsRow = await tx.first(
      `SELECT summarization_effort, summarization_provider, daily_spend_cap_microdollars
       FROM user_settings WHERE user_id = ? FOR UPDATE`,
      input.userId,
    );
    if (!settingsRow) return "not_found";
    const limitsRow = await tx.first(
      "SELECT daily_spend_microdollars FROM tenant_limits WHERE tenant_id = ? FOR UPDATE",
      input.userId,
    );
    if (!limitsRow) return "limits_missing";

    const settings = SettingsRowSchema.parse(settingsRow);
    const operator = LimitsRowSchema.parse(limitsRow).daily_spend_microdollars;
    const nextCap =
      input.dailySpendCapMicrodollars === undefined
        ? settings.daily_spend_cap_microdollars
        : input.dailySpendCapMicrodollars;
    if (nextCap !== null && nextCap > operator) return "cap_above_operator_default";

    const nextProvider = input.summarizationProvider ?? settings.summarization_provider;
    if (input.summarizationProvider === PROVIDER_ANTHROPIC) {
      const active = await tx.first(
        `SELECT 1 AS active FROM tenant_provider_credentials
         WHERE tenant_id = ? AND provider = ? AND status = 'active'`,
        input.userId,
        PROVIDER_ANTHROPIC,
      );
      if (!active) return "anthropic_key_required";
    }

    await tx.run(
      `UPDATE user_settings
       SET summarization_effort = ?, summarization_provider = ?, daily_spend_cap_microdollars = ?,
           updated_at = ?
       WHERE user_id = ?`,
      input.effort ?? settings.summarization_effort,
      nextProvider,
      nextCap,
      toTimestamp(input.nowMs),
      input.userId,
    );
    return "ok";
  });
}
