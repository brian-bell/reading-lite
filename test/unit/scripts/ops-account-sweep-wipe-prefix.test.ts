// `ops account sweep-wipe-prefix`: the prefix guard that keeps the sweep off
// corpus data, and the post-sweep re-list that makes the run verified rather
// than fire-and-forget (issue #195 slice S2).

import { describe, expect, it } from "vitest";
import { accountWipeProgressKey } from "../../../src/account-wipe";
import { buildKeyPrefix, r2KeyLayout } from "../../../src/modules/stores/layout";
import {
  assertSweepableWipeKey,
  isSweepableWipeKey,
  PROTECTED_KEY_ROOTS,
  sweepableWipeKeyVerdict,
  WIPE_PREFIX,
} from "../../../scripts/account-lib/wipe-prefix";
import {
  accountSweepWipePrefixCommand,
  type WipeSweepStorage,
} from "../../../scripts/ops-lib/commands/account-sweep-wipe-prefix";
import type { R2ObjectMeta } from "../../../scripts/lib/cf-clients";
import type { CommandIo } from "../../../scripts/ops-lib/contract";

const TENANT_ID = "usr_11111111-1111-4111-8111-111111111111";
const PROGRESS_KEY = accountWipeProgressKey(TENANT_ID);

function object(key: string, extra: Partial<R2ObjectMeta> = {}): R2ObjectMeta {
  return { key, size: 128, etag: "etag", lastModified: "2026-09-01T00:00:00.000Z", ...extra };
}

function captureIo(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

/**
 * A storage fake that answers a scripted sequence of listings and records every
 * delete it is asked for. `deleteFails` names keys whose delete rejects.
 */
function fakeStorage(options: {
  listings: R2ObjectMeta[][];
  deleteFails?: Set<string>;
}): WipeSweepStorage & { deletes: string[]; prefixes: string[]; listCalls: number } {
  const deletes: string[] = [];
  const prefixes: string[] = [];
  let listCalls = 0;
  const storage = {
    deletes,
    prefixes,
    get listCalls() {
      return listCalls;
    },
    async listObjects(prefix: string) {
      prefixes.push(prefix);
      const listing = options.listings[Math.min(listCalls, options.listings.length - 1)] ?? [];
      listCalls += 1;
      return listing;
    },
    async delete(key: string) {
      deletes.push(key);
      if (options.deleteFails?.has(key)) throw new Error("R2 DELETE failed: 500");
    },
  };
  return storage as WipeSweepStorage & {
    deletes: string[];
    prefixes: string[];
    listCalls: number;
  };
}

async function run(
  argv: string[],
  storage: WipeSweepStorage,
): Promise<{ code: number; out: string; err: string }> {
  const { io, out, err } = captureIo();
  const code = await accountSweepWipePrefixCommand.run(argv, {
    io,
    createStorage: async () => storage,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("wipe/ prefix guard", () => {
  it("accepts the exact key the account wipe writes", () => {
    expect(PROGRESS_KEY.startsWith(WIPE_PREFIX)).toBe(true);
    expect(sweepableWipeKeyVerdict(PROGRESS_KEY)).toEqual({ ok: true });
  });

  it("derives the protected roots from the layout vocabulary", () => {
    // u/ (tenant data plane), readings/ and index/ (legacy pre-cutover roots).
    expect(PROTECTED_KEY_ROOTS).toEqual(["index/", "readings/", "u/"]);
  });

  it("refuses every tenant-rooted key, including a real reading manifest path", () => {
    const relative = buildKeyPrefix("rd_abc123", "2026-04-26T20:00:00.000Z");
    const tenantManifest = r2KeyLayout(`u/${TENANT_ID}/`).manifestKey(relative);
    expect(tenantManifest.startsWith("u/")).toBe(true);
    for (const key of [
      tenantManifest,
      `u/${TENANT_ID}/`,
      `u/${TENANT_ID}/index/list.json`,
      `u/${TENANT_ID}/wipe/${TENANT_ID}/progress.json`,
    ]) {
      expect(isSweepableWipeKey(key), key).toBe(false);
      expect(() => assertSweepableWipeKey(key)).toThrow(/refusing to delete/);
    }
  });

  it("refuses the legacy pre-cutover corpus roots", () => {
    const global = r2KeyLayout();
    for (const key of [
      global.listIndexKey(),
      global.refreshStateKey(),
      global.byUrlKey("a".repeat(64)),
      global.byIdKey("rd_abc123"),
      global.manifestKey(buildKeyPrefix("rd_abc123", "2026-04-26T20:00:00.000Z")),
      "readings/",
      "index/",
    ]) {
      expect(isSweepableWipeKey(key), key).toBe(false);
      expect(() => assertSweepableWipeKey(key)).toThrow(/refusing to delete/);
    }
  });

  it("refuses keys that only look like the wipe prefix, and non-literal segments", () => {
    for (const key of [
      "",
      "wipe",
      "wipe/",
      "wiped/x.json",
      "wipes/x.json",
      "notwipe/x.json",
      " wipe/x.json",
      "/wipe/x.json",
      "wipe//x.json",
      "wipe/./x.json",
      "wipe/../u/x.json",
      `wipe/${TENANT_ID}/../../readings/x.json`,
    ]) {
      expect(isSweepableWipeKey(key), key).toBe(false);
      expect(() => assertSweepableWipeKey(key)).toThrow();
    }
  });

  it("accepts other objects genuinely under wipe/", () => {
    expect(isSweepableWipeKey(`${WIPE_PREFIX}${TENANT_ID}/progress.json`)).toBe(true);
    expect(isSweepableWipeKey(`${WIPE_PREFIX}stray.json`)).toBe(true);
  });
});

describe("ops account sweep-wipe-prefix", () => {
  it("is registered plan-first and never deletes without --execute", async () => {
    expect(accountSweepWipePrefixCommand.group).toBe("account");
    expect(accountSweepWipePrefixCommand.safety).toBe("plan-first");

    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)]] });
    const { code, out } = await run([], storage);

    expect(code).toBe(0);
    expect(storage.deletes).toEqual([]);
    expect(storage.prefixes).toEqual([WIPE_PREFIX]);
    expect(out).toContain(PROGRESS_KEY);
    expect(out).toContain("128 bytes");
    expect(out).toContain("2026-09-01T00:00:00.000Z");
    expect(out).toContain("PLAN");
  });

  it("reports an object with no last-modified rather than inventing one", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY, { lastModified: undefined })]] });
    const { code, out } = await run([], storage);
    expect(code).toBe(0);
    expect(out).toContain("(no last-modified reported)");
  });

  it("succeeds with nothing to do on an already-empty prefix", async () => {
    const storage = fakeStorage({ listings: [[]] });
    const { code, out } = await run(["--execute"], storage);
    expect(code).toBe(0);
    expect(storage.deletes).toEqual([]);
    expect(out).toContain("already empty");
  });

  it("deletes under --execute and exits 0 when the re-list comes back clean", async () => {
    const second = `${WIPE_PREFIX}${TENANT_ID.replace("1111-1111", "2222-2222")}/progress.json`;
    const storage = fakeStorage({ listings: [[object(second), object(PROGRESS_KEY)], []] });
    const { code, out } = await run(["--execute"], storage);

    expect(code).toBe(0);
    expect(storage.deletes).toEqual([PROGRESS_KEY, second].sort());
    // Listed once to plan, once to verify.
    expect(storage.prefixes).toEqual([WIPE_PREFIX, WIPE_PREFIX]);
    expect(out).toContain("VERIFIED");
  });

  it("exits non-zero when the post-delete re-list still shows objects", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)], [object(PROGRESS_KEY)]] });
    const { code, out, err } = await run(["--execute"], storage);

    expect(code).toBe(1);
    expect(storage.deletes).toEqual([PROGRESS_KEY]);
    expect(err).toContain("VERIFICATION FAILED");
    expect(err).toContain(PROGRESS_KEY);
    expect(out).not.toContain("VERIFIED:");
  });

  it("exits non-zero when a delete errored even if the prefix re-lists empty", async () => {
    const storage = fakeStorage({
      listings: [[object(PROGRESS_KEY)], []],
      deleteFails: new Set([PROGRESS_KEY]),
    });
    const { code, err } = await run(["--execute"], storage);

    expect(code).toBe(1);
    expect(err).toContain("unverified");
  });

  it("aborts before any delete when the listing returns a key outside wipe/", async () => {
    const tenantKey = `u/${TENANT_ID}/index/list.json`;
    const legacyKeys = ["readings/2026/04/26T200000Z-rd_abc123/manifest.json", "index/list.json"];
    for (const stray of [tenantKey, ...legacyKeys]) {
      const storage = fakeStorage({ listings: [[object(PROGRESS_KEY), object(stray)], []] });
      const { code, err } = await run(["--execute"], storage);

      expect(code, stray).toBe(1);
      // Not "everything but the stray key" — nothing at all.
      expect(storage.deletes, stray).toEqual([]);
      expect(err).toContain("REFUSED");
      expect(err).toContain(stray);
    }
  });

  it("rejects unknown flags as a usage error", async () => {
    const storage = fakeStorage({ listings: [[]] });
    await expect(run(["--tenant", TENANT_ID], storage)).rejects.toThrow();
    expect(storage.deletes).toEqual([]);
  });
});
