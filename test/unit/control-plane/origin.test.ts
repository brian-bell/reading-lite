import { describe, expect, it } from "vitest";
import { cookieAuthAllowed, isSameOriginRequest } from "../../../src/control-plane/origin";

const same = {
  url: "https://reading-lite.bbell.dev/api/whoami",
  webBaseUrl: "https://reading-lite.bbell.dev/",
};

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
