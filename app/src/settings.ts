import { z } from "zod";
import type { AccountRead, AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// Notification settings from GET/POST /api/auth/settings (#340.6, Phase 5 of
// #340): immediate email and the digest schedule. Fetched in the browser
// only, like the sessions list (ADR 0003). The projection mirrors the fields
// of UserSettingsResponseSchema (src/schemas/api.ts) this app reads; unknown
// fields pass through, and a malformed one is the retryable "unexpected body"
// error rather than a crash in a component.

export const DigestCadenceSchema = z.enum(["off", "daily", "weekly"]);
export type DigestCadence = z.infer<typeof DigestCadenceSchema>;

export const UserSettingsSchema = z.looseObject({
  notify_immediate: z.boolean(),
  digest_cadence: DigestCadenceSchema,
  time_zone: z.string().min(1),
  digest_hour_local: z.number().int(),
  digest_weekday: z.number().int(),
});
export interface UserSettings {
  notify_immediate: boolean;
  digest_cadence: DigestCadence;
  time_zone: string;
  digest_hour_local: number;
  digest_weekday: number;
}

/**
 * POST /api/auth/settings (PostAuthSettingsBodySchema). `notify_immediate` is
 * required; digest fields left out keep their stored values.
 */
export type SettingsBody = Pick<UserSettings, "notify_immediate"> &
  Partial<Omit<UserSettings, "notify_immediate">>;

/** Account-scoped, so sign-in and sign-out drop it (src/auth/session.ts). */
export function settingsQueryKey(userId: string): readonly unknown[] {
  return ["settings", userId];
}

export type SettingsResult = AccountRead<UserSettings>;

export function settingsFromResponse(status: number, body: unknown): SettingsResult {
  if (status === 200) return { state: "ready", value: parsedSettings(body) };
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `settings returned ${status}`);
}

/**
 * What POST /api/auth/settings answered: the stored row after the change, or
 * a 403/412 as a value. A 401 and anything else throw: the 401 through the
 * mutation cache becomes the shell's expired-session page.
 */
export type SettingsSaveOutcome = { kind: "saved"; settings: UserSettings } | AccountRefusal;

export function settingsSaveFromResponse(status: number, body: unknown): SettingsSaveOutcome {
  if (status === 200) return { kind: "saved", settings: parsedSettings(body) };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to update settings");
}

function parsedSettings(body: unknown): UserSettings {
  const parsed = UserSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, "settings returned an unexpected body");
  return parsed.data;
}
