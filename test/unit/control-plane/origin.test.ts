import { describe, expect, it } from "vitest";
import { cookieAuthAllowed, isSameOriginRequest, PUBLIC_WEB_ORIGINS } from "../../../src/control-plane/origin";

const same = {
  url: "https://reading-lite.bbell.dev/api/whoami",
  webBaseUrl: "https://reading-lite.bbell.dev/",
};

describe("PUBLIC_WEB_ORIGINS", () => {
  it("names every production and staging host this project serves", () => {
    expect(PUBLIC_WEB_ORIGINS).toEqual([
      "https://reading-lite.bbell.dev",
      "https://readinglite.ai",
      "https://readinglite.app",
      "https://reading-lite-staging.bbell.dev",
      "https://staging.readinglite.ai",
      "https://staging.readinglite.app",
    ]);
  });
});

describe("isSameOriginRequest", () => {
  it("requires a matching Origin", () => {
    expect(isSameOriginRequest({ origin: undefined, ...same })).toBe(false);
    expect(isSameOriginRequest({ origin: "https://evil.example", ...same })).toBe(false);
    expect(isSameOriginRequest({ origin: "https://reading-lite.bbell.dev", ...same })).toBe(true);
  });
});

describe("cookieAuthAllowed", () => {
  it("allows GET/HEAD with no Origin when Sec-Fetch-Site is same-origin", () => {
    expect(
      cookieAuthAllowed({
        method: "GET",
        origin: undefined,
        secFetchSite: "same-origin",
        ...same,
      }),
    ).toBe(true);
    expect(
      cookieAuthAllowed({
        method: "HEAD",
        origin: undefined,
        secFetchSite: "same-origin",
        ...same,
      }),
    ).toBe(true);
  });

  it("rejects a present cross-site Origin even when Sec-Fetch-Site claims same-origin", () => {
    expect(
      cookieAuthAllowed({
        method: "GET",
        origin: "https://evil.example",
        secFetchSite: "same-origin",
        ...same,
      }),
    ).toBe(false);
  });

  it("still requires Origin on cookie writes", () => {
    expect(
      cookieAuthAllowed({
        method: "POST",
        origin: undefined,
        secFetchSite: "same-origin",
        url: "https://reading-lite.bbell.dev/api/readings",
        webBaseUrl: "https://reading-lite.bbell.dev/",
      }),
    ).toBe(false);
    expect(
      cookieAuthAllowed({
        method: "POST",
        origin: "https://reading-lite.bbell.dev",
        url: "https://reading-lite.bbell.dev/api/readings",
        webBaseUrl: "https://reading-lite.bbell.dev/",
      }),
    ).toBe(true);
  });
});
