import { describe, expect, it } from "vitest";
import {
  CONTENT_CHUNK_BYTES,
  maxPolls,
  publicMarkdownLink,
  publicReadingUrl,
  sliceUtf8,
  mapHttpError,
} from "../../../src/mcp/format";
import { mcpOriginAllowed, parseMcpAllowedOrigins } from "../../../src/mcp/origin";

describe("mcp format helpers", () => {
  it("builds a public reading URL from WEB_BASE_URL, stripping trailing slashes", () => {
    expect(publicReadingUrl("https://reading.test.example/", "rd_ABC")).toBe(
      "https://reading.test.example/readings/rd_ABC",
    );
    expect(publicReadingUrl("", "rd_ABC")).toBeUndefined();
    expect(publicReadingUrl("   ", "rd_ABC")).toBeUndefined();
    expect(publicReadingUrl(undefined, "rd_ABC")).toBeUndefined();
  });

  it("builds a markdown link, falling back to the URL as the label", () => {
    expect(publicMarkdownLink("Karpathy", "https://x.example/readings/rd_1")).toBe(
      "[Karpathy](https://x.example/readings/rd_1)",
    );
    expect(publicMarkdownLink(undefined, "https://x.example/readings/rd_1")).toBe(
      "[https://x.example/readings/rd_1](https://x.example/readings/rd_1)",
    );
  });

  it("slices UTF-8 by bytes and reports truncation", () => {
    const body = "a".repeat(CONTENT_CHUNK_BYTES + 50);
    const first = sliceUtf8(body, 0, CONTENT_CHUNK_BYTES);
    expect(first.truncated).toBe(true);
    expect(first.bytes_total).toBe(CONTENT_CHUNK_BYTES + 50);
    expect(first.bytes_returned).toBe(CONTENT_CHUNK_BYTES);
    expect(first.next_offset).toBe(CONTENT_CHUNK_BYTES);
    const rest = sliceUtf8(body, first.next_offset!, CONTENT_CHUNK_BYTES);
    expect(rest.truncated).toBe(false);
    expect(rest.bytes_returned).toBe(50);
    expect(rest.text).toBe("a".repeat(50));
  });

  it("does not split UTF-8 code points across pages", () => {
    // "€" is E2 82 AC (3 bytes). A 2-byte page would cut it in half.
    const body = "a€b";
    const first = sliceUtf8(body, 0, 2);
    expect(first.text).toBe("a");
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(1);
    const rest = sliceUtf8(body, first.next_offset!, 16);
    expect(rest.text).toBe("€b");
    expect(first.text + rest.text).toBe(body);

    // A maxBytes smaller than the first character still returns that character whole.
    const euro = sliceUtf8("€", 0, 1);
    expect(euro.text).toBe("€");
    expect(euro.truncated).toBe(false);
    expect(euro.next_offset).toBeNull();
  });

  it("maps auth and not-found HTTP errors onto the connector phrasing", () => {
    expect(mapHttpError(401, "unauthorized")).toBe("bad or missing token");
    expect(mapHttpError(403, "forbidden")).toBe("bad or missing token");
    expect(mapHttpError(404, "not found")).toBe("unknown id");
    expect(mapHttpError(404, "extracted markdown not available")).toBe(
      "extracted markdown not available",
    );
    expect(mapHttpError(403, "error code: 1010")).toBe("rate limited; back off and retry");
  });

  it("bounds poll attempts so an instant sleep cannot spin forever", () => {
    expect(maxPolls(25_000, 2_000)).toBe(14);
  });
});

describe("mcp origin allowlist", () => {
  it("defaults to the two public origins when the var is empty", () => {
    expect(parseMcpAllowedOrigins("")).toEqual(["https://readinglite.ai", "https://readinglite.app"]);
    expect(parseMcpAllowedOrigins(undefined)).toEqual(["https://readinglite.ai", "https://readinglite.app"]);
  });

  it("accepts both public hosts by default and rejects the retired host", () => {
    const allowed = parseMcpAllowedOrigins(undefined);
    expect(mcpOriginAllowed("https://readinglite.ai", allowed)).toBe(true);
    expect(mcpOriginAllowed("https://readinglite.app", allowed)).toBe(true);
    expect(mcpOriginAllowed("https://reading-lite.bbell.dev", allowed)).toBe(false);
  });

  it("matches origins exactly, so neighbouring hosts do not slip through", () => {
    const allowed = parseMcpAllowedOrigins(undefined);
    expect(mcpOriginAllowed("https://www.readinglite.ai", allowed)).toBe(false);
    expect(mcpOriginAllowed("https://www.readinglite.app", allowed)).toBe(false);
    expect(mcpOriginAllowed("https://evil-readinglite.ai", allowed)).toBe(false);
    expect(mcpOriginAllowed("http://readinglite.ai", allowed)).toBe(false);
    expect(mcpOriginAllowed("http://readinglite.app", allowed)).toBe(false);
  });

  it("allows a missing Origin (non-browser MCP clients) and rejects unknown origins", () => {
    const allowed = parseMcpAllowedOrigins("https://reading.test.example");
    expect(mcpOriginAllowed(undefined, allowed)).toBe(true);
    expect(mcpOriginAllowed("https://reading.test.example", allowed)).toBe(true);
    expect(mcpOriginAllowed("https://attacker.example", allowed)).toBe(false);
  });

  it("still honours an explicit comma-separated var over the defaults", () => {
    expect(
      parseMcpAllowedOrigins("https://readinglite.ai, https://readinglite.app"),
    ).toEqual(["https://readinglite.ai", "https://readinglite.app"]);
  });
});
