import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadTurnstileApi,
  parseTurnstileSiteKey,
  resetTurnstileLoaderForTests,
  TURNSTILE_SCRIPT_SRC
} from "./turnstile";

afterEach(() => {
  delete window.turnstile;
  resetTurnstileLoaderForTests();
});

describe("parseTurnstileSiteKey", () => {
  it("keeps a non-empty site key and treats null or blank as absent", () => {
    expect(parseTurnstileSiteKey("1x00000000000000000000AA")).toBe("1x00000000000000000000AA");
    expect(parseTurnstileSiteKey(" 1x00000000000000000000AA ")).toBe("1x00000000000000000000AA");
    expect(parseTurnstileSiteKey(null)).toBeNull();
    expect(parseTurnstileSiteKey("")).toBeNull();
    expect(parseTurnstileSiteKey("   ")).toBeNull();
  });
});

describe("loadTurnstileApi", () => {
  it("uses a preinstalled Turnstile API without injecting the Cloudflare script", async () => {
    const api = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() };
    window.turnstile = api;
    await expect(loadTurnstileApi()).resolves.toBe(api);
    expect(document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)).toBeNull();
  });

  it("injects the explicit-render script when Turnstile is not yet present", () => {
    const pending = loadTurnstileApi();
    const script = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    expect(script).toBeInstanceOf(HTMLScriptElement);
    expect((script as HTMLScriptElement).src).toBe(TURNSTILE_SCRIPT_SRC);
    resetTurnstileLoaderForTests();
    void pending.catch(() => undefined);
  });

  it("removes a failed script so a later load injects a fresh tag", async () => {
    const first = loadTurnstileApi();
    const failed = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    expect(failed).toBeInstanceOf(HTMLScriptElement);
    failed!.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("Turnstile failed to load");
    expect(document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)).toBeNull();

    const second = loadTurnstileApi();
    const retry = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    expect(retry).toBeInstanceOf(HTMLScriptElement);
    expect(retry).not.toBe(failed);
    resetTurnstileLoaderForTests();
    void second.catch(() => undefined);
  });
});
