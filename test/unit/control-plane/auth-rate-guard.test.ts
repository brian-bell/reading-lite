import { describe, expect, it } from "vitest";
import {
  admitAuthIp,
  admitAuthSend,
  AuthRateGuard,
  bumpWindow,
  coarseIp,
  connectingIp,
} from "../../../src/control-plane/auth-rate-guard";
import type { Env } from "../../../src/index";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function memoryStorage(
  yieldBeforeRead = false,
  map: Map<string, unknown> = new Map(),
): DurableObjectStorage {
  let alarm: number | null = null;
  return {
    get: async (key: string) => {
      const current = map.get(key);
      if (yieldBeforeRead) await new Promise((resolve) => setTimeout(resolve, 0));
      return current;
    },
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async () => new Map(map),
    getAlarm: async () => alarm,
    setAlarm: async (expiresAt: number) => {
      alarm = expiresAt;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;
}

function guardState(storage: DurableObjectStorage = memoryStorage()): DurableObjectState {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const run = chain.then(callback, callback);
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  } as DurableObjectState;
}

describe("coarseIp", () => {
  it("truncates IPv4 to a /24 and IPv6 to the first four hextets", () => {
    expect(coarseIp("203.0.113.55")).toBe("203.0.113.0");
    expect(coarseIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3:0::");
    expect(coarseIp("2001:db8:85a3:8a2e:370:7334:1:2")).toBe("2001:db8:85a3:8a2e::");
    expect(coarseIp("")).toBe("unknown");
    expect(coarseIp(null)).toBe("unknown");
  });
});

describe("connectingIp", () => {
  it("prefers cf-connecting-ip then the first x-forwarded-for hop", () => {
    expect(
      connectingIp(
        new Request("https://example.test/", {
          headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1" },
        }),
      ),
    ).toBe("203.0.113.9");
    expect(
      connectingIp(
        new Request("https://example.test/", {
          headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.1" },
        }),
      ),
    ).toBe("198.51.100.2");
    expect(connectingIp(new Request("https://example.test/"))).toBeNull();
  });
});

describe("bumpWindow", () => {
  it("resets after the window and counts inside it", () => {
    const first = bumpWindow(undefined, 1000, 100);
    expect(first).toEqual({ start: 1000, count: 1 });
    expect(bumpWindow(first, 1099, 100)).toEqual({ start: 1000, count: 2 });
    expect(bumpWindow(first, 1100, 100)).toEqual({ start: 1100, count: 1 });
  });
});

describe("AuthRateGuard", () => {
  const sendBody = {
    kind: "send",
    emailHash: "e1",
    emailWindowMs: 60_000,
    emailMax: 2,
    globalWindowMs: 60_000,
    globalMax: 200,
  };
  const ipBody = {
    kind: "ip",
    ipHash: "i1",
    ipWindowMs: 60_000,
    ipMax: 2,
  };

  function admit(guard: AuthRateGuard, body: unknown): Promise<Response> {
    return guard.fetch(
      new Request("https://auth-rate-guard/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("send admits until the email ceiling then denies without bumping IP", async () => {
    const map = new Map<string, unknown>();
    const guard = new AuthRateGuard(guardState(memoryStorage(false, map)), {} as Env);
    expect(((await (await admit(guard, sendBody)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard, sendBody)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard, sendBody)).json()) as { ok: boolean }).ok).toBe(false);
    expect(map.has("i:i1")).toBe(false);
    expect(map.get("e:e1")).toEqual({ start: expect.any(Number), count: 3, windowMs: 60_000 });
    expect(map.get("g:all")).toEqual({ start: expect.any(Number), count: 2, windowMs: 60_000 });
  });

  it("ip admits until the IP ceiling then denies without bumping email or global", async () => {
    const map = new Map<string, unknown>();
    const guard = new AuthRateGuard(guardState(memoryStorage(false, map)), {} as Env);
    expect(((await (await admit(guard, ipBody)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard, ipBody)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard, ipBody)).json()) as { ok: boolean }).ok).toBe(false);
    expect(map.has("e:e1")).toBe(false);
    expect(map.has("g:all")).toBe(false);
    expect(map.get("i:i1")).toEqual({ start: expect.any(Number), count: 3, windowMs: 60_000 });
  });

  it("does not let a concurrent burst all pass the email ceiling", async () => {
    const guard = new AuthRateGuard(guardState(memoryStorage(true)), {} as Env);
    const responses = await Promise.all(Array.from({ length: 8 }, () => admit(guard, sendBody)));
    const outcomes = await Promise.all(responses.map(async (res) => ((await res.json()) as { ok: boolean }).ok));
    expect(outcomes.filter((ok) => ok)).toHaveLength(2);
    expect(outcomes.filter((ok) => !ok)).toHaveLength(6);
  });

  it("alarm deletes expired i: and e: records without changing live admit counts", async () => {
    const map = new Map<string, unknown>([
      ["i:stale", { start: Date.now() - 120_000, count: 9, windowMs: 60_000 }],
      ["e:stale", { start: Date.now() - 120_000, count: 4, windowMs: 60_000 }],
    ]);
    const guard = new AuthRateGuard(guardState(memoryStorage(false, map)), {} as Env);
    expect(((await (await admit(guard, ipBody)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard, sendBody)).json()) as { ok: boolean }).ok).toBe(true);
    await guard.alarm();
    expect(map.has("i:stale")).toBe(false);
    expect(map.has("e:stale")).toBe(false);
    expect(map.get("i:i1")).toEqual({ start: expect.any(Number), count: 1, windowMs: 60_000 });
    expect(map.get("e:e1")).toEqual({ start: expect.any(Number), count: 1, windowMs: 60_000 });
    expect(((await (await admit(guard, ipBody)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard, ipBody)).json()) as { ok: boolean }).ok).toBe(false);
  });
});

function recordingGuard(decision: { ok: boolean; reason?: string } = { ok: true }) {
  const bodies: unknown[] = [];
  const env = {
    APP_ENV: "production",
    AUTH_ROOT_SECRET: ROOT_HEX,
    AUTH_RATE_GUARD: {
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({
        fetch: async (_input: RequestInfo, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(decision), {
            headers: { "content-type": "application/json" },
          });
        },
      }),
    },
  } as unknown as Env;
  return { env, bodies };
}

const UNBOUND_ADMITS: ReadonlyArray<[string, (env: Env) => Promise<string>]> = [
  ["admitAuthIp", (env) => admitAuthIp(env, new Request("https://example.test/"))],
  ["admitAuthSend", (env) => admitAuthSend(env, "a@b.test")],
];

describe("without a Durable Object binding", () => {
  it.each(UNBOUND_ADMITS)("%s fails closed on staging", async (_name, admit) => {
    expect(await admit({ APP_ENV: "staging", AUTH_ROOT_SECRET: ROOT_HEX } as Env)).toBe("deny");
  });

  it.each(UNBOUND_ADMITS)("%s allows local traffic", async (_name, admit) => {
    expect(await admit({ APP_ENV: "local", AUTH_ROOT_SECRET: ROOT_HEX } as Env)).toBe("allow");
  });
});

describe("admitAuthIp", () => {
  it("posts kind ip with an HMAC of the coarse IP and no email hash", async () => {
    const { env, bodies } = recordingGuard({ ok: false, reason: "ip" });
    expect(
      await admitAuthIp(
        env,
        new Request("https://example.test/", { headers: { "cf-connecting-ip": "203.0.113.55" } }),
      ),
    ).toBe("deny");
    const posted = bodies[0] as { kind: string; ipHash: string; emailHash?: string };
    expect(posted.kind).toBe("ip");
    expect(posted.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(posted).not.toHaveProperty("emailHash");
    expect(JSON.stringify(posted)).not.toContain("203.0.113");
  });
});

describe("admitAuthSend", () => {
  it("posts kind send with an HMAC of the email and no IP hash", async () => {
    const { env, bodies } = recordingGuard({ ok: false, reason: "email" });
    expect(await admitAuthSend(env, "founder@test.example")).toBe("deny");
    const posted = bodies[0] as { kind: string; emailHash: string; ipHash?: string };
    expect(posted.kind).toBe("send");
    expect(posted.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(posted).not.toHaveProperty("ipHash");
    expect(JSON.stringify(posted)).not.toContain("founder@test.example");
  });
});
