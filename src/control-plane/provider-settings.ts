import { z } from "zod";
import {
  ProviderSettingsResponseSchema,
  SummarizationEffortSchema,
  type ProviderSettingsResponse,
  type SummarizationEffort,
} from "../schemas/api";
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";

const SettingsRowSchema = z.object({
  summarization_effort: SummarizationEffortSchema,
  daily_spend_cap_microdollars: z.number().int().positive().nullable(),
});

const LimitsRowSchema = z.object({
  daily_spend_microdollars: z.number().int().positive(),
});

const MaskRowSchema = z.object({
  provider: z.literal("openai"),
  last_four: z.string().length(4),
  status: z.enum(["active", "invalid"]),
  validated_at: z.string().nullable(),
});

export type ProviderSettingsLoad = ProviderSettingsResponse | "not_found" | "limits_missing";

export type ProviderPreferenceResult = "ok" | "not_found" | "limits_missing" | "cap_above_operator_default";

/** The tenant cap the spend guard admits against: the reader may only lower the operator default. */
export function effectiveDailySpend(userCap: number | null, operator: number): number {
  return userCap === null ? operator : Math.min(userCap, operator);
}

type SpendCaps = {
  effort: SummarizationEffort;
  daily_spend_cap_microdollars: number | null;
  effective_daily_spend_microdollars: number;
  operator_daily_spend_microdollars: number;
};

/** The reader's effort and daily caps, as the settings page and usage view show them. */
export async function loadSpendCaps(db: ControlPlaneDb, userId: string): Promise<SpendCaps | "not_found" | "limits_missing"> {
  const settingsRow = await db.first(
    `SELECT summarization_effort, daily_spend_cap_microdollars
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
    daily_spend_cap_microdollars: settings.daily_spend_cap_microdollars,
    effective_daily_spend_microdollars: effectiveDailySpend(settings.daily_spend_cap_microdollars, operator),
    operator_daily_spend_microdollars: operator,
  };
}

/** The reader's summarization effort, or null when the user has no settings row. */
export async function readSummarizationEffort(db: ControlPlaneDb, userId: string): Promise<SummarizationEffort | null> {
  const row = await db.first("SELECT summarization_effort FROM user_settings WHERE user_id = ?", userId);
  return row === null ? null : SettingsRowSchema.pick({ summarization_effort: true }).parse(row).summarization_effort;
}

export async function loadProviderSettings(db: ControlPlaneDb, userId: string): Promise<ProviderSettingsLoad> {
  const caps = await loadSpendCaps(db, userId);
  if (typeof caps === "string") return caps;
  const maskRow = await db.first(
    `SELECT provider, last_four, status, validated_at
     FROM tenant_provider_credentials WHERE tenant_id = ? AND provider = 'openai'`,
    userId,
  );
  const mask = maskRow === null ? null : MaskRowSchema.parse(maskRow);
  return ProviderSettingsResponseSchema.parse({
    credential: mask
      ? {
          provider: mask.provider,
          last_four: mask.last_four,
          status: mask.status,
          validated_at_ms: fromTimestamp(mask.validated_at),
        }
      : null,
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
  },
): Promise<ProviderPreferenceResult> {
  return db.transaction(async (tx) => {
    const settingsRow = await tx.first(
      `SELECT summarization_effort, daily_spend_cap_microdollars
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

    await tx.run(
      `UPDATE user_settings
       SET summarization_effort = ?, daily_spend_cap_microdollars = ?, updated_at = ?
       WHERE user_id = ?`,
      input.effort ?? settings.summarization_effort,
      nextCap,
      toTimestamp(input.nowMs),
      input.userId,
    );
    return "ok";
  });
}
