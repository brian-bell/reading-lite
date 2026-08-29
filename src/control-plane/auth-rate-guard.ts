import type { Env } from "../index";
import { readAuthRoots } from "./auth-root";
import {
  AUTH_RATE_EMAIL_MAX,
  AUTH_RATE_EMAIL_WINDOW_MS,
  AUTH_RATE_GLOBAL_MAX,
  AUTH_RATE_GLOBAL_WINDOW_MS,
  AUTH_RATE_GUARD_NAME,
  AUTH_RATE_IP_MAX,
  AUTH_RATE_IP_WINDOW_MS,
} from "./constants";
import { deriveHmacKey, hmacHex } from "./crypto";

type WindowRecord = { start: number; count: number };

type AdmitBody = {
  emailHash: string;
  ipHash: string;
  emailWindowMs: number;
  emailMax: number;
  ipWindowMs: number;
  ipMax: number;
  globalWindowMs: number;
  globalMax: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function isCloudAuthEnv(env: { APP_ENV?: string }): boolean {
  return env.APP_ENV === "staging" || env.APP_ENV === "production";
}

export function coarseIp(raw: string | null | undefined): string {
  const ip = (raw ?? "").trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!ip) return "unknown";
  if (ip.includes(".")) {
    const host = ip.includes(":") ? (ip.split(":")[0] ?? "") : ip;
    const parts = host.split(".");
    if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
    return "unknown";
  }
  if (ip.includes(":")) {
    const [head] = ip.split("::");
    const parts = (head ?? "").split(":").filter((part) => part.length > 0);
    while (parts.length < 4) parts.push("0");
    return `${parts.slice(0, 4).join(":")}::`;
  }
  return "unknown";
}

export function connectingIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for")?.trim();
  if (!forwarded) return null;
  return forwarded.split(",")[0]?.trim() || null;
}

export function bumpWindow(record: WindowRecord | undefined, now: number, windowMs: number): WindowRecord {
  if (!record || now - record.start >= windowMs) {
    return { start: now, count: 1 };
  }
  return { start: record.start, count: record.count + 1 };
}

function envInt(env: Env, name: string, fallback: number): number {
  const raw = (env as unknown as Record<string, unknown>)[name];
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function hashSubject(env: Env, value: string): Promise<string> {
  const { authRoot } = readAuthRoots(env);
  return hmacHex(await deriveHmacKey(authRoot, "rate_limit"), value);
}

async function bumpStored(
  storage: DurableObjectStorage,
  key: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const current = (await storage.get(key)) as WindowRecord | undefined;
  const next = bumpWindow(current, now, windowMs);
  await storage.put(key, next);
  return next.count;
}

function parseAdmitBody(value: unknown): AdmitBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const emailHash = typeof body.emailHash === "string" ? body.emailHash : "";
  const ipHash = typeof body.ipHash === "string" ? body.ipHash : "";
  const nums = [
    body.emailWindowMs,
    body.emailMax,
    body.ipWindowMs,
    body.ipMax,
    body.globalWindowMs,
    body.globalMax,
  ].map((n) => Number(n));
  if (!emailHash || !ipHash || nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return {
    emailHash,
    ipHash,
    emailWindowMs: nums[0]!,
    emailMax: nums[1]!,
    ipWindowMs: nums[2]!,
    ipMax: nums[3]!,
    globalWindowMs: nums[4]!,
    globalMax: nums[5]!,
  };
}

export class AuthRateGuard implements DurableObject {
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    let parsed: AdmitBody | null = null;
    try {
      parsed = parseAdmitBody(await request.json());
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!parsed) return json({ error: "invalid_body" }, 400);
    const now = Date.now();
    const emailCount = await bumpStored(this.state.storage, `e:${parsed.emailHash}`, now, parsed.emailWindowMs);
    if (emailCount > parsed.emailMax) return json({ ok: false, reason: "email" });
    const ipCount = await bumpStored(this.state.storage, `i:${parsed.ipHash}`, now, parsed.ipWindowMs);
    if (ipCount > parsed.ipMax) return json({ ok: false, reason: "ip" });
    const globalCount = await bumpStored(this.state.storage, "g:all", now, parsed.globalWindowMs);
    if (globalCount > parsed.globalMax) return json({ ok: false, reason: "global" });
    return json({ ok: true });
  }
}

export async function admitAuthSend(
  env: Env,
  request: Request,
  canonicalEmail: string,
): Promise<"allow" | "deny"> {
  const ns = env.AUTH_RATE_GUARD;
  const cloud = isCloudAuthEnv(env);
  if (!ns) return cloud ? "deny" : "allow";
  try {
    const emailHash = await hashSubject(env, canonicalEmail);
    const ipHash = await hashSubject(env, coarseIp(connectingIp(request)));
    const stub = ns.get(ns.idFromName(AUTH_RATE_GUARD_NAME));
    const res = await stub.fetch("https://auth-rate-guard/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailHash,
        ipHash,
        emailWindowMs: envInt(env, "AUTH_RATE_EMAIL_WINDOW_MS", AUTH_RATE_EMAIL_WINDOW_MS),
        emailMax: envInt(env, "AUTH_RATE_EMAIL_MAX", AUTH_RATE_EMAIL_MAX),
        ipWindowMs: envInt(env, "AUTH_RATE_IP_WINDOW_MS", AUTH_RATE_IP_WINDOW_MS),
        ipMax: envInt(env, "AUTH_RATE_IP_MAX", AUTH_RATE_IP_MAX),
        globalWindowMs: envInt(env, "AUTH_RATE_GLOBAL_WINDOW_MS", AUTH_RATE_GLOBAL_WINDOW_MS),
        globalMax: envInt(env, "AUTH_RATE_GLOBAL_MAX", AUTH_RATE_GLOBAL_MAX),
      }),
    });
    if (!res.ok) return cloud ? "deny" : "allow";
    const payload = (await res.json()) as { ok?: boolean };
    return payload.ok === true ? "allow" : "deny";
  } catch {
    return cloud ? "deny" : "allow";
  }
}
