import { describe, expect, it } from "vitest";
import {
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TEST_SECRET_FAIL,
  TURNSTILE_TEST_SECRET_PASS,
  TURNSTILE_TEST_SITE_KEY_PASS,
  turnstileSiteKey,
  verifyTurnstileToken,
} from "../../../src/control-plane/turnstile";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return async (input) => {
    expect(String(input)).toBe(TURNSTILE_SITEVERIFY_URL);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("turnstileSiteKey", () => {
  it("returns null for missing or blank keys", () => {
    expect(turnstileSiteKey({})).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "  " })).toBeNull();
  });

  it("returns a trimmed configured key", () => {
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: ` ${TURNSTILE_TEST_SITE_KEY_PASS} ` })).toBe(
      TURNSTILE_TEST_SITE_KEY_PASS,
    );
  });
});

describe("verifyTurnstileToken", () => {
  it("fail-opens locally when the secret is unset, even without a token", async () => {
    expect(await verifyTurnstileToken({ env: { APP_ENV: "local" }, token: undefined })).toBe(true);
    expect(await verifyTurnstileToken({ env: { APP_ENV: "test" }, token: "" })).toBe(true);
    expect(await verifyTurnstileToken({ env: {}, token: undefined })).toBe(true);
  });

  it("fail-closes on staging and production when the secret is unset", async () => {
    expect(await verifyTurnstileToken({ env: { APP_ENV: "staging" }, token: "tok" })).toBe(false);
    expect(await verifyTurnstileToken({ env: { APP_ENV: "production" }, token: "tok" })).toBe(false);
    expect(await verifyTurnstileToken({ env: { APP_ENV: "staging", TURNSTILE_SECRET_KEY: "  " }, token: "tok" })).toBe(
      false,
    );
  });

  it("rejects a missing token when the secret is present without calling siteverify", async () => {
    let called = 0;
    const fetchImpl: typeof fetch = async () => {
      called += 1;
      return new Response("{}");
    };
    expect(
      await verifyTurnstileToken({
        env: { APP_ENV: "local", TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_PASS },
        token: undefined,
        fetchImpl,
      }),
    ).toBe(false);
    expect(
      await verifyTurnstileToken({
        env: { APP_ENV: "staging", TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_PASS },
        token: "  ",
        fetchImpl,
      }),
    ).toBe(false);
    expect(called).toBe(0);
  });

  it("accepts success===true from siteverify", async () => {
    let posted = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(TURNSTILE_SITEVERIFY_URL);
      posted = String(init?.body);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" },
      });
    };
    expect(
      await verifyTurnstileToken({
        env: { TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_PASS },
        token: "widget-token",
        fetchImpl,
        remoteIp: "203.0.113.9",
      }),
    ).toBe(true);
    expect(posted).toContain("secret=");
    expect(posted).toContain("response=widget-token");
    expect(posted).toContain("remoteip=203.0.113.9");
  });

  it("fail-closes when success is not true", async () => {
    expect(
      await verifyTurnstileToken({
        env: { TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_FAIL },
        token: "widget-token",
        fetchImpl: jsonFetch({ success: false }),
      }),
    ).toBe(false);
    expect(
      await verifyTurnstileToken({
        env: { TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_PASS },
        token: "widget-token",
        fetchImpl: jsonFetch({ success: "true" }),
      }),
    ).toBe(false);
  });

  it("fail-closes on siteverify HTTP errors and thrown fetch", async () => {
    expect(
      await verifyTurnstileToken({
        env: { APP_ENV: "production", TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_PASS },
        token: "widget-token",
        fetchImpl: jsonFetch({ success: true }, 502),
      }),
    ).toBe(false);
    expect(
      await verifyTurnstileToken({
        env: { APP_ENV: "staging", TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_PASS },
        token: "widget-token",
        fetchImpl: async () => {
          throw new Error("network");
        },
      }),
    ).toBe(false);
  });
});
