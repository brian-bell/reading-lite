import { createHash } from "node:crypto";

// Node-side reproduction of the worker's `sha256Hex` (src/services.ts): the
// lowercase hex SHA-256 of the UTF-8 URL string. by-url ownership pointers live
// at `index/by-url/{urlHash(url)}`, so cleanup tooling recomputes this Node-side
// to find the pointer a dropped reading might (or might not) own.
export function urlHash(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}
