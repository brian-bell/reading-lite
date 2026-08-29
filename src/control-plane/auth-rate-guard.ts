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

type AdmitIpBody = {
  kind: "ip";
  ipHash: string;
  ipWindowMs: number;
  ipMax: number;
};

type AdmitSendBody = {
  kind: "send";
  emailHash: string;
  emailWindowMs: number;
  emailMax: number;
  globalWindowMs: number;
  globalMax: number;
};

type AdmitBody = AdmitIpBody | AdmitSendBody;

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
  const kind = body.kind;
  if (kind === "ip") {
    const ipHash = typeof body.ipHash === "string" ? body.ipHash : "";
    const ipWindowMs = Number(body.ipWindowMs);
    const ipMax = Number(body.ipMax);
    if (!ipHash || !Number.isFinite(ipWindowMs) || ipWindowMs <= 0 || !Number.isFinite(ipMax) || ipMax <= 0) {
      return null;
    }
    return { kind: "ip", ipHash, ipWindowMs, ipMax };
  }
  if (kind === "send") {
    const emailHash = typeof body.emailHash === "string" ? body.emailHash : "";
    const nums = [body.emailWindowMs, body.emailMax, body.globalWindowMs, body.globalMax].map((n) => Number(n));
    if (!emailHash || nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
    return {
      kind: "send",
      emailHash,
      emailWindowMs: nums[0]!,
      emailMax: nums[1]!,
      globalWindowMs: nums[2]!,
      globalMax: nums[3]!,
    };
  }
  return null;
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
    const body = parsed;
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      if (body.kind === "ip") {
        const ipCount = await bumpStored(this.state.storage, `i:${body.ipHash}`, now, body.ipWindowMs);
        if (ipCount > body.ipMax) return json({ ok: false, reason: "ip" });
        return json({ ok: true });
      }
      const emailCount = await bumpStored(this.state.storage, `e:${body.emailHash}`, now, body.emailWindowMs);
      if (emailCount > body.emailMax) return json({ ok: false, reason: "email" });
      const globalCount = await bumpStored(this.state.storage, "g:all", now, body.globalWindowMs);
      if (globalCount > body.globalMax) return json({ ok: false, reason: "global" });
      return json({ ok: true });
    });
  }
}

export async function admitAuthIp(env: Env, request: Request): Promise<"allow" | "deny"> {
  try {
    return await admitGuard(env, {
      kind: "ip",
      ipHash: await hashSubject(env, coarseIp(connectingIp(request))),
      ipWindowMs: envInt(env, "AUTH_RATE_IP_WINDOW_MS", AUTH_RATE_IP_WINDOW_MS),
      ipMax: envInt(env, "AUTH_RATE_IP_MAX", AUTH_RATE_IP_MAX),
    });
  } catch {
    return isCloudAuthEnv(env) ? "deny" : "allow";
  }
}

export async function admitAuthSend(env: Env, canonicalEmail: string): Promise<"allow" | "deny"> {
  try {
    return await admitGuard(env, {
      kind: "send",
      emailHash: await hashSubject(env, canonicalEmail),
      emailWindowMs: envInt(env, "AUTH_RATE_EMAIL_WINDOW_MS", AUTH_RATE_EMAIL_WINDOW_MS),
      emailMax: envInt(env, "AUTH_RATE_EMAIL_MAX", AUTH_RATE_EMAIL_MAX),
      globalWindowMs: envInt(env, "AUTH_RATE_GLOBAL_WINDOW_MS", AUTH_RATE_GLOBAL_WINDOW_MS),
      globalMax: envInt(env, "AUTH_RATE_GLOBAL_MAX", AUTH_RATE_GLOBAL_MAX),
    });
  } catch {
    return isCloudAuthEnv(env) ? "deny" : "allow";
  }
}

async function admitGuard(env: Env, body: AdmitBody): Promise<"allow" | "deny"> {
  const ns = env.AUTH_RATE_GUARD;
  const cloud = isCloudAuthEnv(env);
  if (!ns) return cloud ? "deny" : "allow";
  const stub = ns.get(ns.idFromName(AUTH_RATE_GUARD_NAME));
  const res = await stub.fetch("https://auth-rate-guard/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return cloud ? "deny" : "allow";
  const payload = (await res.json()) as { ok?: boolean };
  return payload.ok === true ? "allow" : "deny";
}
