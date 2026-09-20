import type { Context } from "hono";
import { PostAuthSettingsBodySchema } from "../schemas/api";
import { jsonAuth } from "./auth-handlers";
import { fromSql } from "./db";
import { getUserSettings, updateUserSettings } from "./user-settings";
import type { AppBindings } from "../middleware";

export async function handleGetSettings(c: Context<AppBindings>): Promise<Response> {
  const principal = c.get("principal");
  const settings = await getUserSettings(fromSql(c.get("sql")), String(principal.userId));
  if (!settings) return jsonAuth({ error: "not found" }, 404);
  return jsonAuth(settings, 200);
}

export async function handlePostSettings(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const json = await c.req.json().catch(() => null);
  const parsed = PostAuthSettingsBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  const settings = await updateUserSettings(fromSql(c.get("sql")), {
    userId: String(principal.userId),
    nowMs,
    notifyImmediate: parsed.data.notify_immediate,
    digestCadence: parsed.data.digest_cadence,
    timeZone: parsed.data.time_zone,
    digestHourLocal: parsed.data.digest_hour_local,
    digestWeekday: parsed.data.digest_weekday,
  });
  if (!settings) return jsonAuth({ error: "not found" }, 404);
  return jsonAuth(settings, 200);
}
