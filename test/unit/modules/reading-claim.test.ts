import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKeyPrefix,
  ReadingStore,
} from "../../../src/modules/stores/reading-store";
import {
  OwnerResolutionContentionError,
  ReadingClaim,
} from "../../../src/modules/reading-claim";
import { sha256Hex, type Services } from "../../../src/services";
import type { Manifest } from "../../../src/schemas/manifest";

const NOW = "2026-04-26T20:00:00.000Z";

function fakeServices(now = NOW): Services {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    lookup: async () => [{ address: "93.184.216.34" }],
    now: () => now,
    newId: () => "rd_NEW",
  };
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_OWNER",
    url: "https://example.com/a",
    url_hash: "a".repeat(64),
    status: "ready",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(clearBucket);
afterEach(clearBucket);

function newClaim(services = fakeServices()) {
  const store = new ReadingStore(env.READINGS_BUCKET);
  return { store, claim: new ReadingClaim(store, services) };
}

// Writes a manifest at its canonical key_prefix (and nothing else). Returns the
// pieces a test needs to wire up pointers and assertions.
async function writeReading(
  store: ReadingStore,
  url: string,
  overrides: Partial<Manifest> = {},
) {
  const urlHash = await sha256Hex(url);
  const id = overrides.id ?? "rd_OWNER";
  const createdAt = overrides.created_at ?? NOW;
  const keyPrefix = buildKeyPrefix(id, createdAt);
  const m = manifest({
    ...overrides,
    id,
    url,
    url_hash: urlHash,
    created_at: createdAt,
    updated_at: overrides.updated_at ?? createdAt,
  });
  await store.writeManifest(keyPrefix, m);
  return { id, urlHash, keyPrefix, manifest: m };
}

describe("ReadingClaim.resolveOwner", () => {
  it("returns unclaimed when there is no pointer and no legacy manifest", async () => {
    const { claim } = newClaim();
    const res = await claim.resolveOwner("https://example.com/cold");
    expect(res).toEqual({ kind: "unclaimed" });
  });

  it("returns owned with the manifest verbatim for a matching ready owner", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/ready";
    const owner = await writeReading(store, url, { id: "rd_READY", status: "ready" });
    await store.writeByUrlPointer(owner.urlHash, { id: owner.id, key_prefix: owner.keyPrefix });

    const res = await claim.resolveOwner(url);
    expect(res).toEqual({
      kind: "owned",
      pointer: { id: owner.id, key_prefix: owner.keyPrefix },
      manifest: owner.manifest,
    });
  });

  it("returns owned for a matching failed owner without branching on status", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/failed";
    const owner = await writeReading(store, url, {
      id: "rd_FAILED",
      status: "failed",
      content_status: "failed",
      error: { code: "BadStatusError", message: "boom" },
    });
    await store.writeByUrlPointer(owner.urlHash, { id: owner.id, key_prefix: owner.keyPrefix });

    const res = await claim.resolveOwner(url);
    expect(res.kind).toBe("owned");
    if (res.kind === "owned") {
      expect(res.manifest.status).toBe("failed");
      expect(res.pointer.id).toBe("rd_FAILED");
    }
  });

  it("returns initializing for a fresh pointer whose manifest is not yet written", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/initializing";
    const urlHash = await sha256Hex(url);
    // key_prefix timestamp is ~1 minute before NOW: inside the 5-minute grace.
    const keyPrefix = "readings/2026/04/26T195900Z-rd_FRESH";
    await store.writeByUrlPointer(urlHash, { id: "rd_FRESH", key_prefix: keyPrefix });

    const res = await claim.resolveOwner(url);
    expect(res).toEqual({
      kind: "initializing",
      pointer: { id: "rd_FRESH", key_prefix: keyPrefix },
    });
  });

  it("CAS-replaces a stale missing-manifest pointer onto a recovered legacy reading", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/stale-with-legacy";
    const urlHash = await sha256Hex(url);
    const legacy = await writeReading(store, url, {
      id: "rd_LEGACY",
      status: "failed",
      created_at: "2026-04-26T19:00:00.000Z",
    });
    // Orphan pointer at a stale (>5min) timestamp, manifest absent.
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    const res = await claim.resolveOwner(url);
    expect(res.kind).toBe("owned");
    if (res.kind === "owned") expect(res.pointer.id).toBe("rd_LEGACY");
    // The pointer was repaired to the legacy reading.
    expect(await store.readByUrlPointer(urlHash)).toEqual({
      id: "rd_LEGACY",
      key_prefix: legacy.keyPrefix,
    });
  });

  it("returns unclaimed with the pointer etag for a stale orphan with no legacy", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/stale-orphan";
    const urlHash = await sha256Hex(url);
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    const stored = await store.readByUrlPointerWithEtag(urlHash);

    const res = await claim.resolveOwner(url);
    expect(res).toEqual({ kind: "unclaimed", replaceEtag: stored!.etag });
  });

  it("repairs a damaged pointer whose manifest belongs to another url", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/wanted";
    const urlHash = await sha256Hex(url);
    // Pointer resolves to a manifest that owns a *different* url (damaged).
    const otherUrl = "https://example.com/other";
    const damaged = await writeReading(store, otherUrl, { id: "rd_DAMAGED", status: "ready" });
    await store.writeByUrlPointer(urlHash, { id: "rd_DAMAGED", key_prefix: damaged.keyPrefix });
    // A legacy reading that genuinely owns `url`, discoverable via deep scan.
    const legacy = await writeReading(store, url, {
      id: "rd_WANTED",
      status: "ready",
      created_at: "2026-04-26T19:30:00.000Z",
    });

    const res = await claim.resolveOwner(url);
    expect(res.kind).toBe("owned");
    if (res.kind === "owned") expect(res.pointer.id).toBe("rd_WANTED");
    expect(await store.readByUrlPointer(urlHash)).toEqual({
      id: "rd_WANTED",
      key_prefix: legacy.keyPrefix,
    });
  });

  it("claims a pointer ifNotExists for a legacy reading that has no pointer yet", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/legacy-no-pointer";
    const urlHash = await sha256Hex(url);
    const legacy = await writeReading(store, url, { id: "rd_LEGACY", status: "ready" });
    expect(await store.readByUrlPointer(urlHash)).toBeNull();

    const res = await claim.resolveOwner(url);
    expect(res.kind).toBe("owned");
    if (res.kind === "owned") expect(res.pointer.id).toBe("rd_LEGACY");
    expect(await store.readByUrlPointer(urlHash)).toEqual({
      id: "rd_LEGACY",
      key_prefix: legacy.keyPrefix,
    });
  });

  it("converges on a concurrent writer's owner when the CAS-replace loses the race", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/race";
    const urlHash = await sha256Hex(url);

    // A stale damaged orphan occupies the slot.
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    // The legacy reading our resolver would repair *to*.
    await writeReading(store, url, {
      id: "rd_LEGACY",
      status: "ready",
      created_at: "2026-04-26T19:00:00.000Z",
    });
    // A *different* valid owner the concurrent writer claims first.
    const other = await writeReading(store, url, {
      id: "rd_OTHER",
      status: "ready",
      created_at: "2026-04-26T19:45:00.000Z",
    });

    const realPut = env.READINGS_BUCKET.put.bind(env.READINGS_BUCKET);
    const byUrlKey = `index/by-url/${urlHash}`;
    let injected = false;
    const spy = vi
      .spyOn(env.READINGS_BUCKET, "put")
      .mockImplementation((async (key: string, value: unknown, options?: R2PutOptions) => {
        // Intercept our conditional CAS-replace: simulate another writer landing
        // a valid owner (rd_OTHER) just before us, then fail our precondition.
        if (key === byUrlKey && options?.onlyIf && !injected) {
          injected = true;
          await realPut(
            byUrlKey,
            JSON.stringify({ id: other.id, key_prefix: other.keyPrefix }),
            { httpMetadata: { contentType: "application/json" } },
          );
          return null;
        }
        return realPut(key, value as ArrayBuffer, options);
      }) as typeof env.READINGS_BUCKET.put);

    const res = await claim.resolveOwner(url);
    spy.mockRestore();

    // Converged on the concurrent writer's owner — not clobbered back to legacy.
    expect(res.kind).toBe("owned");
    if (res.kind === "owned") expect(res.pointer.id).toBe("rd_OTHER");
    expect(await store.readByUrlPointer(urlHash)).toEqual({
      id: other.id,
      key_prefix: other.keyPrefix,
    });
  });

  it("treats a pointer with an unparseable timestamp as damaged, not initializing", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/unparseable";
    const urlHash = await sha256Hex(url);
    await store.writeByUrlPointer(urlHash, {
      id: "rd_WEIRD",
      key_prefix: "readings/not-a-timestamp-rd_WEIRD",
    });
    const stored = await store.readByUrlPointerWithEtag(urlHash);

    const res = await claim.resolveOwner(url);
    expect(res).toEqual({ kind: "unclaimed", replaceEtag: stored!.etag });
  });

  it("deep-scans only when repairing an existing pointer, never on the cold path", async () => {
    const { store, claim } = newClaim();
    const spy = vi.spyOn(store, "findManifestByUrl");

    // Cold path: no pointer → findManifestByUrl(url) with no deepScan, so a
    // first-time submit never pays a full bucket scan.
    await claim.resolveOwner("https://example.com/cold-scan");
    expect(spy).toHaveBeenLastCalledWith("https://example.com/cold-scan");

    // Repair path: a damaged pointer → deepScan:true (the strongest recovery).
    const url = "https://example.com/repair-scan";
    const urlHash = await sha256Hex(url);
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    await claim.resolveOwner(url);
    expect(spy).toHaveBeenLastCalledWith(url, { deepScan: true });

    spy.mockRestore();
  });

  it("does not scan or claim a cold legacy when claimColdLegacy is false", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/read-only-cold";
    const urlHash = await sha256Hex(url);
    await writeReading(store, url, { id: "rd_LEGACY", status: "ready" });
    const spy = vi.spyOn(store, "findManifestByUrl");

    const res = await claim.resolveOwner(url, { claimColdLegacy: false });

    // No live pointer → "not found"; the legacy is neither scanned for nor claimed.
    expect(res).toEqual({ kind: "unclaimed" });
    expect(spy).not.toHaveBeenCalled();
    expect(await store.readByUrlPointer(urlHash)).toBeNull();
    spy.mockRestore();
  });

  it("does not scan or write to repair a damaged pointer when repairDamaged is false", async () => {
    // The read-only lookup path (GET /api/readings/lookup) passes repairDamaged:false
    // so a GET never deep-scans the bucket or CAS-writes the pointer. A damaged
    // pointer reads as "not found"; the write paths (submit/import) still repair.
    const { store, claim } = newClaim();
    const url = "https://example.com/read-only-no-repair";
    const urlHash = await sha256Hex(url);
    await writeReading(store, url, {
      id: "rd_LEGACY",
      status: "ready",
      created_at: "2026-04-26T19:00:00.000Z",
    });
    const orphanPointer = {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    };
    await store.writeByUrlPointer(urlHash, orphanPointer);
    const scan = vi.spyOn(store, "findManifestByUrl");

    const res = await claim.resolveOwner(url, {
      claimColdLegacy: false,
      repairDamaged: false,
    });

    // Read-only: no repair → unclaimed, no bucket scan, pointer left untouched.
    expect(res.kind).toBe("unclaimed");
    expect(scan).not.toHaveBeenCalled();
    expect(await store.readByUrlPointer(urlHash)).toEqual(orphanPointer);
    scan.mockRestore();
  });

  it("terminates after the bounded attempts under persistent CAS contention", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const claim = new ReadingClaim(store, fakeServices(), { maxAttempts: 3 });
    const url = "https://example.com/contended";
    const urlHash = await sha256Hex(url);
    await writeReading(store, url, { id: "rd_LEGACY", status: "ready" });
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    // Every CAS-replace loses — the loop must give up rather than spin forever.
    const spy = vi
      .spyOn(store, "replaceByUrlPointerIfCurrent")
      .mockResolvedValue(false);

    // A typed, retryable error (not a generic Error) so the router can map it to
    // 503 instead of a 500 that masks transient contention.
    await expect(claim.resolveOwner(url)).rejects.toBeInstanceOf(OwnerResolutionContentionError);
    await expect(claim.resolveOwner(url)).rejects.toThrow(/exhausted 3 attempts/i);
    expect(spy).toHaveBeenCalledTimes(6);
    spy.mockRestore();
  });

  it("deep-scans only once while repairing a damaged pointer across CAS retries", async () => {
    const store = new ReadingStore(env.READINGS_BUCKET);
    const claim = new ReadingClaim(store, fakeServices(), { maxAttempts: 4 });
    const url = "https://example.com/repair-contended";
    const urlHash = await sha256Hex(url);
    await writeReading(store, url, { id: "rd_LEGACY", status: "ready" });
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    // Every CAS-replace loses, so the repair branch re-runs for all 4 attempts.
    const cas = vi.spyOn(store, "replaceByUrlPointerIfCurrent").mockResolvedValue(false);
    // The deep scan (a full bucket rebuild) must be memoized — the repair target
    // can't change between retries, so it runs once regardless of attempt count.
    const scan = vi.spyOn(store, "findManifestByUrl");

    await expect(claim.resolveOwner(url)).rejects.toBeInstanceOf(OwnerResolutionContentionError);
    expect(cas).toHaveBeenCalledTimes(4);
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
    cas.mockRestore();
  });
});

// The bounded slot-claim loop, moved behind the Owner-resolution seam from the
// router (where it was claimByUrlSlot). Returns a claim outcome instead of
// taking a callback, so pointer-CAS internals (replaceEtag, PointerExistsError)
// never cross the seam to Reading intake.
describe("ReadingClaim.claimSlot", () => {
  const FRESH_POINTER = { id: "rd_NEW", key_prefix: buildKeyPrefix("rd_NEW", NOW) };

  it("claims a free slot and writes the pointer", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/free-slot";
    const urlHash = await sha256Hex(url);

    const out = await claim.claimSlot(url, FRESH_POINTER);

    expect(out).toEqual({ kind: "claimed" });
    await expect(store.readByUrlPointer(urlHash)).resolves.toEqual(FRESH_POINTER);
  });

  it("CAS-overwrites a damaged pointer when given its replaceEtag", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/damaged-etag";
    const urlHash = await sha256Hex(url);
    // Damaged: points at a manifest that never existed, older than the grace window.
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    const resolved = await claim.resolveOwner(url);
    expect(resolved.kind).toBe("unclaimed");
    const replaceEtag = resolved.kind === "unclaimed" ? resolved.replaceEtag : undefined;
    expect(replaceEtag).toBeDefined();

    const out = await claim.claimSlot(url, FRESH_POINTER, { replaceEtag });

    expect(out).toEqual({ kind: "claimed" });
    await expect(store.readByUrlPointer(urlHash)).resolves.toEqual(FRESH_POINTER);
  });

  it("converges onto a damaged pointer without a replaceEtag by re-resolving", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/damaged-cold";
    const urlHash = await sha256Hex(url);
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });

    // First write attempt loses (ifNotExists), re-resolve hands back the etag,
    // second attempt CAS-replaces it.
    const out = await claim.claimSlot(url, FRESH_POINTER);

    expect(out).toEqual({ kind: "claimed" });
    await expect(store.readByUrlPointer(urlHash)).resolves.toEqual(FRESH_POINTER);
  });

  it("defers to a valid owner that won the race", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/lost-race";
    const winner = await writeReading(store, url, { id: "rd_WINNER", status: "ready" });
    await store.writeByUrlPointer(winner.urlHash, {
      id: winner.id,
      key_prefix: winner.keyPrefix,
    });

    const out = await claim.claimSlot(url, FRESH_POINTER);

    expect(out).toEqual({
      kind: "owned",
      pointer: { id: winner.id, key_prefix: winner.keyPrefix },
      manifest: winner.manifest,
    });
    // The winner's pointer is untouched.
    await expect(store.readByUrlPointer(winner.urlHash)).resolves.toEqual({
      id: winner.id,
      key_prefix: winner.keyPrefix,
    });
  });

  it("reports a still-initializing winner (fresh pointer, no manifest yet)", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/initializing";
    const urlHash = await sha256Hex(url);
    // Fresh pointer (key_prefix timestamp == NOW) whose manifest is not written yet.
    const winnerPointer = { id: "rd_FRESH", key_prefix: buildKeyPrefix("rd_FRESH", NOW) };
    await store.writeByUrlPointer(urlHash, winnerPointer);

    const out = await claim.claimSlot(url, FRESH_POINTER);

    expect(out).toEqual({ kind: "initializing", pointer: winnerPointer });
  });

  it("gives up as contended when every CAS attempt loses", async () => {
    const { store, claim } = newClaim();
    const url = "https://example.com/claim-contended";
    const urlHash = await sha256Hex(url);
    await store.writeByUrlPointer(urlHash, {
      id: "rd_ORPHAN",
      key_prefix: "readings/2026/04/26T190000Z-rd_ORPHAN",
    });
    const cas = vi.spyOn(store, "replaceByUrlPointerIfCurrent").mockResolvedValue(false);

    const out = await claim.claimSlot(url, FRESH_POINTER);

    expect(out).toEqual({ kind: "contended" });
    cas.mockRestore();
  });
});
