import { describe, expect, it } from "vitest";
import { makeBrowserFetch } from "../../../scripts/corpus-lib/browser-fetch";

describe("makeBrowserFetch", () => {
  const capture = () => {
    let seen: Headers | undefined;
    const base: typeof fetch = async (_url, init) => {
      seen = new Headers(init?.headers ?? {});
      return new Response("ok");
    };
    return { base, seen: () => seen };
  };

  it("fills browser-like defaults when the caller sets no headers", async () => {
    const { base, seen } = capture();
    await makeBrowserFetch(base)("https://example.com");
    expect(seen()?.get("user-agent")).toMatch(/Mozilla/);
    expect(seen()?.get("accept")).toMatch(/text\/html/);
    expect(seen()?.get("accept-language")).toBe("en-US,en;q=0.9");
  });

  it("preserves caller-supplied Reddit OAuth headers instead of clobbering them", async () => {
    const { base, seen } = capture();
    await makeBrowserFetch(base)("https://oauth.reddit.com/r/x/comments/1.json", {
      headers: {
        authorization: "Bearer tok",
        "user-agent": "web:reading-lite:1.0",
        accept: "application/json",
      },
    });
    // The Reddit extractor sets these on purpose; Reddit throttles generic
    // browser UAs and the OAuth endpoint expects JSON, so they must survive.
    expect(seen()?.get("authorization")).toBe("Bearer tok");
    expect(seen()?.get("user-agent")).toBe("web:reading-lite:1.0");
    expect(seen()?.get("accept")).toBe("application/json");
    // A default the caller omitted is still filled.
    expect(seen()?.get("accept-language")).toBe("en-US,en;q=0.9");
  });
});
