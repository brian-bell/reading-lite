import { describe, expect, it } from "vitest";
import {
  admitAuthSend,
  AuthRateGuard,
  bumpWindow,
  coarseIp,
  connectingIp,
} from "../../../src/control-plane/auth-rate-guard";
import type { Env } from "../../../src/index";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function memoryStorage(yieldBeforeRead = false): DurableObjectStorage {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => {
      const current = map.get(key);
      if (yieldBeforeRead) await new Promise((resolve) => setTimeout(resolve, 0));
      return current;
    },
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  } as DurableObjectStorage;
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
  const body = {
    emailHash: "e1",
    ipHash: "i1",
    emailWindowMs: 60_000,
    emailMax: 2,
    ipWindowMs: 60_000,
    ipMax: 20,
    globalWindowMs: 60_000,
    globalMax: 200,
  };

  function admit(guard: AuthRateGuard): Promise<Response> {
    return guard.fetch(
      new Request("https://auth-rate-guard/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("admits until the email ceiling then denies", async () => {
    const guard = new AuthRateGuard(guardState(), {} as Env);
    expect(((await (await admit(guard)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard)).json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await admit(guard)).json()) as { ok: boolean }).ok).toBe(false);
  });

  it("does not let a concurrent burst all pass the email ceiling", async () => {
    const guard = new AuthRateGuard(guardState(memoryStorage(true)), {} as Env);
    const responses = await Promise.all(Array.from({ length: 8 }, () => admit(guard)));
    const outcomes = await Promise.all(responses.map(async (res) => ((await res.json()) as { ok: boolean }).ok));
    expect(outcomes.filter((ok) => ok)).toHaveLength(2);
    expect(outcomes.filter((ok) => !ok)).toHaveLength(6);
  });
});

describe("admitAuthSend", () => {
  it("fails closed on staging without a Durable Object binding", async () => {
    const env = { APP_ENV: "staging", AUTH_ROOT_SECRET: ROOT_HEX } as Env;
    expect(await admitAuthSend(env, new Request("https://example.test/"), "a@b.test")).toBe("deny");
  });

  it("allows local traffic when the Durable Object is unbound", async () => {
    const env = { APP_ENV: "local", AUTH_ROOT_SECRET: ROOT_HEX } as Env;
    expect(await admitAuthSend(env, new Request("https://example.test/"), "a@b.test")).toBe("allow");
  });

  it("HMACs subjects and honors the guard decision", async () => {
    const bodies: unknown[] = [];
    const env = {
      APP_ENV: "production",
      AUTH_ROOT_SECRET: ROOT_HEX,
      AUTH_RATE_GUARD: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => ({
          fetch: async (_input: RequestInfo, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ ok: false, reason: "email" }), {
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as Env;
    expect(await admitAuthSend(env, new Request("https://example.test/"), "founder@test.example")).toBe("deny");
    const posted = bodies[0] as { emailHash: string; ipHash: string };
    expect(posted.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(posted.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(posted)).not.toContain("founder@test.example");
  });
});
