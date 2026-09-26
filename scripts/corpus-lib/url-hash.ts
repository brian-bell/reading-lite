import { createHash } from "node:crypto";

// Node-side reproduction of the worker's `sha256Hex` (src/services.ts): the
// lowercase hex SHA-256 of the UTF-8 URL string, stored as `url_hash` on the
// reading and its reading_urls claim, so Node-side tooling (batch preparation,
// fixtures) spells it the same way.
export function urlHash(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}
