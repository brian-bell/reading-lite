import type { ByUrlPointer, Manifest } from "../schemas/manifest";
import { sha256Hex, type Services } from "../services";
import { PointerExistsError, ReadingStore } from "./stores/reading-store";

// A by-url pointer whose manifest is missing is treated as a still-initializing
// owner (not damaged) while the pointer's key_prefix timestamp is younger than
// this grace window. `POST /readings` writes the pointer before the pending
// manifest, so there is a brief, legitimate window where the pointer exists but
// the manifest does not yet.
const MISSING_MANIFEST_OWNER_GRACE_MS = 5 * 60 * 1000;

// Bounds the read→repair→re-resolve loop. Each iteration that fails to converge
// (a concurrent writer changed the pointer between our read and our CAS) re-reads
// and retries; persistent contention terminates with an error rather than the
// unbounded recursion this resolver replaces.
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * The outcome of resolving "who owns this URL?".
 *
 * - `owned`        — a by-url pointer resolves to a manifest that genuinely owns
 *                    the URL. The caller decides what to do with it (a `failed`
 *                    owner is reprocessed in place; otherwise it is returned).
 * - `initializing` — a fresh pointer whose manifest has not been written yet,
 *                    still inside the grace window. The caller should 409.
 * - `unclaimed`    — the URL is free to claim. `replaceEtag` is set when a
 *                    damaged pointer occupies the slot and must be CAS-overwritten
 *                    (rather than created `ifNotExists`) by the caller.
 */
export type OwnerResolution =
  | { kind: "owned"; pointer: ByUrlPointer; manifest: Manifest }
  | { kind: "initializing"; pointer: ByUrlPointer }
  | { kind: "unclaimed"; replaceEtag?: string };

export interface ReadingClaimOptions {
  maxAttempts?: number;
}

/**
 * The read → match → repair → resolve protocol for URL ownership, extracted from
 * the router so the six submit/import/lookup call sites collapse to a single
 * switch on {@link OwnerResolution}. `resolveOwner` performs the repair writes
 * (CAS-replacing a damaged pointer to a recovered legacy reading, claiming a
 * legacy reading that has no pointer yet) but never *creates* a new reading —
 * that stays with the caller, which gets back `unclaimed` (with the etag to
 * overwrite, when a damaged pointer is in the way).
 */
export class ReadingClaim {
  private readonly maxAttempts: number;

  constructor(
    private readonly store: ReadingStore,
    private readonly services: Services,
    opts: ReadingClaimOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async resolveOwner(url: string): Promise<OwnerResolution> {
    const urlHash = await sha256Hex(url);

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const existing = await this.store.readByUrlPointerWithEtag(urlHash);

      if (existing) {
        const manifest = await this.store.readManifest(existing.pointer.key_prefix);
        if (manifest && ownedManifestMatches(existing.pointer, manifest, url, urlHash)) {
          return { kind: "owned", pointer: existing.pointer, manifest };
        }
        if (!manifest && isFreshMissingManifestPointer(existing.pointer, this.services.now())) {
          return { kind: "initializing", pointer: existing.pointer };
        }

        // Damaged owner (manifest mismatched, or stale-missing): try to repair
        // to a recovered legacy reading. A deep scan is the strongest repair —
        // this is the import-only `deepScan: existing ? true : undefined` policy,
        // unified: we deep-scan exactly when an existing pointer needs repair.
        const legacy = await this.store.findManifestByUrl(url, { deepScan: true });
        if (legacy) {
          const pointer = { id: legacy.manifest.id, key_prefix: legacy.keyPrefix };
          const replaced = await this.store.replaceByUrlPointerIfCurrent(
            urlHash,
            existing.etag,
            pointer,
          );
          if (replaced) return { kind: "owned", pointer, manifest: legacy.manifest };
          // A concurrent writer changed the pointer first — re-read and converge
          // on whatever they wrote rather than clobbering it.
          continue;
        }

        return { kind: "unclaimed", replaceEtag: existing.etag };
      }

      // No pointer at all. Cold path: a legacy reading may exist without a
      // pointer (no deep scan — first-time submits must not pay a full bucket
      // scan). Claim its pointer; if nothing is found, the URL is free.
      const legacy = await this.store.findManifestByUrl(url);
      if (!legacy) return { kind: "unclaimed" };

      const pointer = { id: legacy.manifest.id, key_prefix: legacy.keyPrefix };
      try {
        await this.store.writeByUrlPointer(urlHash, pointer, { ifNotExists: true });
        return { kind: "owned", pointer, manifest: legacy.manifest };
      } catch (err) {
        if (!(err instanceof PointerExistsError)) throw err;
        // Lost the claim race — another writer wrote the pointer between our
        // read and our conditional create. Re-resolve against what they wrote.
        continue;
      }
    }

    throw new Error(
      `resolveOwner: exhausted ${this.maxAttempts} attempts resolving URL ownership under contention`,
    );
  }
}

function ownedManifestMatches(
  pointer: ByUrlPointer,
  manifest: Manifest,
  url: string,
  urlHash: string,
): boolean {
  return manifest.id === pointer.id && manifest.url === url && manifest.url_hash === urlHash;
}

function isFreshMissingManifestPointer(pointer: ByUrlPointer, nowIso: string): boolean {
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
