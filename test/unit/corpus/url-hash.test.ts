import { describe, expect, it } from "vitest";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";
import { sha256Hex } from "../../../src/services";

// The Node-side helper must reproduce the worker's URL hashing exactly, since
// both spell the `url_hash` stored on a reading and its reading_urls claim.
describe("urlHash", () => {
  const urls = [
    "https://example.com/",
    "https://example.com/path?q=1#frag",
    "http://xn--e1aybc.example/ünïcödé",
    "",
  ];

  it("matches the worker sha256Hex for representative URLs", async () => {
    for (const u of urls) {
      expect(urlHash(u)).toBe(await sha256Hex(u));
    }
  });
});
