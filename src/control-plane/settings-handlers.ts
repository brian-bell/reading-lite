import type { Context } from "hono";
import { PostAuthSettingsBodySchema } from "../schemas/api";
import { jsonAuth } from "./auth-handlers";
import { fromD1 } from "./db";
import { getUserSettings, updateNotifyImmediate } from "./user-settings";
import type { AppBindings } from "../middleware";

export async function handleGetSettings(c: Context<AppBindings>): Promise<Response> {
  const principal = c.get("principal");
  const settings = await getUserSettings(fromD1(c.env.CONTROL_PLANE), String(principal.userId));
  if (!settings) return jsonAuth({ error: "not found" }, 404);
  return jsonAuth(settings, 200);
}

export async function handlePostSettings(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const json = await c.req.json().catch(() => null);
  const parsed = PostAuthSettingsBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  const settings = await updateNotifyImmediate(fromD1(c.env.CONTROL_PLANE), {
    userId: String(principal.userId),
    notifyImmediate: parsed.data.notify_immediate,
    nowMs,
  });
  if (!settings) return jsonAuth({ error: "not found" }, 404);
  return jsonAuth(settings, 200);
}
