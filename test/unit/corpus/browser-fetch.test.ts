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

  it("preserves caller-supplied headers instead of clobbering them", async () => {
    const { base, seen } = capture();
    // A caller that sets specific headers (auth, a custom UA, a JSON accept) on
    // purpose must have them survive — the wrapper only fills the gaps.
    await makeBrowserFetch(base)("https://api.example.com/resource.json", {
      headers: {
        authorization: "Bearer tok",
        "user-agent": "custom-agent/1.0",
        accept: "application/json",
      },
    });
    expect(seen()?.get("authorization")).toBe("Bearer tok");
    expect(seen()?.get("user-agent")).toBe("custom-agent/1.0");
    expect(seen()?.get("accept")).toBe("application/json");
    // A default the caller omitted is still filled.
    expect(seen()?.get("accept-language")).toBe("en-US,en;q=0.9");
  });

  it("does not force redirect: follow, so safeFetch can keep redirect: manual", async () => {
    let seen: RequestInit | undefined;
    const base: typeof fetch = async (_url, init) => {
      seen = init;
      return new Response("ok");
    };
    await makeBrowserFetch(base)("https://example.com", { redirect: "manual" });
    expect(seen?.redirect).toBe("manual");
  });
});
