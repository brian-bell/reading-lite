import { describe, expect, it } from "vitest";
import { cookieAuthAllowed, isSameOriginRequest } from "../../../src/control-plane/origin";

const same = {
  url: "https://readinglite.ai/api/whoami",
  webBaseUrl: "https://readinglite.ai/",
};

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
