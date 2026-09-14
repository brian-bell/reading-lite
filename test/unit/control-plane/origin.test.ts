import { describe, expect, it } from "vitest";
import { cookieAuthAllowed, isSameOriginRequest, PUBLIC_WEB_ORIGINS } from "../../../src/control-plane/origin";

const same = {
  url: "https://readinglite.ai/api/whoami",
  webBaseUrl: "https://readinglite.ai/",
};

describe("PUBLIC_WEB_ORIGINS", () => {
  it("names every production and staging host this project serves", () => {
    expect(PUBLIC_WEB_ORIGINS).toEqual([
      "https://readinglite.ai",
      "https://readinglite.app",
      "https://staging.readinglite.ai",
      "https://staging.readinglite.app",
      // New-frontend preview hosts (ADR 0003); retired after the Phase 5 cutover.
      "https://next.readinglite.ai",
      "https://next-staging.readinglite.ai",
    ]);
  });
});

describe("isSameOriginRequest", () => {
  it("requires a matching Origin", () => {
    expect(isSameOriginRequest({ origin: undefined, ...same })).toBe(false);
    expect(isSameOriginRequest({ origin: "https://evil.example", ...same })).toBe(false);
    expect(isSameOriginRequest({ origin: "https://readinglite.ai", ...same })).toBe(true);
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
        url: "https://readinglite.ai/api/readings",
        webBaseUrl: "https://readinglite.ai/",
      }),
    ).toBe(false);
    expect(
      cookieAuthAllowed({
        method: "POST",
        origin: "https://readinglite.ai",
        url: "https://readinglite.ai/api/readings",
        webBaseUrl: "https://readinglite.ai/",
      }),
    ).toBe(true);
  });
});
