// The offline batch pipeline's by-url ownership rules, over the R2 pointer
// layout it still reads and writes. These were the Worker's (ReadingClaim) until
// the Worker moved URL ownership to a PostgreSQL unique row (ADR 0005); the
// batch pipeline moves in the operator slice (reading-lite-gh347.4), and until
// then it keeps the exact rules it was written against.
import type { Manifest } from "../../../src/schemas/manifest";

export interface ByUrlPointer {
  id: string;
  key_prefix: string;
}

// A by-url pointer whose manifest is missing is a still-initializing owner, not
// a damaged one, while the pointer's key_prefix timestamp is younger than this.
// The realtime path wrote the pointer before the pending manifest.
const MISSING_MANIFEST_OWNER_GRACE_MS = 5 * 60 * 1000;

// A manifest genuinely owns the URL a pointer claims for it.
export function ownedManifestMatches(
  pointer: ByUrlPointer,
  manifest: Manifest,
  url: string,
  urlHash: string,
): boolean {
  return manifest.id === pointer.id && manifest.url === url && manifest.url_hash === urlHash;
}

export function isFreshMissingManifestPointer(pointer: ByUrlPointer, nowIso: string): boolean {
  const createdAtMs = keyPrefixCreatedAtMs(pointer.key_prefix);
  if (createdAtMs === null) return false;
  const ageMs = Date.parse(nowIso) - createdAtMs;
  return ageMs >= 0 && ageMs < MISSING_MANIFEST_OWNER_GRACE_MS;
}

function keyPrefixCreatedAtMs(keyPrefix: string): number | null {
  const m = keyPrefix.match(
    /^readings\/(\d{4})\/(\d{2})\/(\d{2})T(\d{2})(\d{2})(\d{2})Z-/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
