// `ops account sweep-wipe-prefix`: the prefix guard that keeps the sweep off
// corpus data, and the post-sweep re-list that makes the run verified rather
// than fire-and-forget (issue #195 slice S2).

import { describe, expect, it } from "vitest";
import { ACCOUNT_WIPE_IN_FLIGHT_MS } from "../../../src/account-wipe";
import { buildKeyPrefix, r2KeyLayout } from "../../../src/modules/stores/layout";
import {
  assertSweepableWipeKey,
  isSweepableWipeKey,
  PROTECTED_KEY_ROOTS,
  sweepableWipeKeyVerdict,
  wipeKeyTenantId,
  WIPE_PREFIX,
} from "../../../scripts/account-lib/wipe-prefix";
import {
  accountSweepWipePrefixCommand,
  OPERATOR_DATABASES,
  type WipeSweepStorage,
} from "../../../scripts/ops-lib/commands/account-sweep-wipe-prefix";
import type { R2ObjectMeta } from "../../../scripts/lib/cf-clients";
import { runCli } from "../../../scripts/ops-lib/cli";
import type { CommandIo } from "../../../scripts/ops-lib/contract";

const TENANT_ID = "usr_11111111-1111-4111-8111-111111111111";

/**
 * The key shape the retired R2-backed progress record used.
 *
 * S2 (#270) moved wipe progress into D1 and deleted `accountWipeProgressKey`
 * with the rest of the R2 record; #271's sweep landed in parallel and kept
 * importing it, which left `main` failing `tsc`. The shape still matters to
 * this suite — the sweep exists precisely to recognise and remove the objects
 * that shape left behind in the bucket — so it is pinned here, next to the
 * `wipeKeyTenantId` parser it has to agree with, rather than resurrected in
 * `src/`, which no longer writes such a key.
 */
function accountWipeProgressKey(tenantId: string): string {
  return `${WIPE_PREFIX}${tenantId}/progress.json`;
}

const PROGRESS_KEY = accountWipeProgressKey(TENANT_ID);
const ACK = "--acknowledge-no-active-wipe";

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

  it("reads the tenant out of a progress key, and only out of that shape", () => {
    expect(wipeKeyTenantId(PROGRESS_KEY)).toBe(TENANT_ID);
    for (const key of [
      `${WIPE_PREFIX}stray.json`,
      `${WIPE_PREFIX}${TENANT_ID}/other.json`,
      `${WIPE_PREFIX}${TENANT_ID}/nested/progress.json`,
      `${WIPE_PREFIX}not-a-tenant/progress.json`,
      `u/${TENANT_ID}/index/list.json`,
    ]) {
      expect(wipeKeyTenantId(key), key).toBeNull();
    }
  });

  it("accepts other objects genuinely under wipe/", () => {
    expect(isSweepableWipeKey(`${WIPE_PREFIX}${TENANT_ID}/progress.json`)).toBe(true);
    expect(isSweepableWipeKey(`${WIPE_PREFIX}stray.json`)).toBe(true);
  });
});

describe("bucket → control-plane mapping", () => {
  // The mapping decides which control plane the safety briefing sends the
  // operator to. wrangler.toml owns the bucket name; if it moves, the printed
  // query would silently point at the wrong environment, so pin the pair
  // rather than trusting two copies to stay in step. The D1 database name is
  // no longer declared there — the control plane is on PostgreSQL (ADR 0005)
  // and these commands are the last wrangler-D1 callers, ported or retired by
  // reading-lite-gh347.4.
  it("names, for each env, the bucket wrangler.toml declares", async () => {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const toml = await fs.readFile(
      path.resolve(__dirname, "../../../wrangler.toml"),
      "utf8",
    );

    // Everything from `[env.<name>]` to the next TOP-LEVEL env header is that
    // environment's block. The cut must ignore `[env.<name>.vars]` and
    // `[[env.<name>.r2_buckets]]`, which belong to the block they sit in.
    const blockFor = (env: string): string => {
      const start = toml.indexOf(`\n[env.${env}]\n`);
      expect(start, `wrangler.toml has no [env.${env}] section`).toBeGreaterThanOrEqual(0);
      const rest = toml.slice(start + 1);
      const next = /\n\[env\.[A-Za-z0-9_-]+\]\n/.exec(rest.slice(1));
      return next === null ? rest : rest.slice(0, next.index + 1);
    };
    const valueIn = (block: string, key: string): string | undefined =>
      new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m").exec(block)?.[1];

    for (const [bucket, { env }] of Object.entries(OPERATOR_DATABASES)) {
      expect(valueIn(blockFor(env), "bucket_name"), `${env} bucket_name`).toBe(bucket);
    }
  });
});

describe("ops account sweep-wipe-prefix", () => {
  it("is registered plan-first and never deletes without --execute", async () => {
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

  it("names the tenants at risk, prints a D1 query scoped to exactly them, and states the S2 rules", async () => {
    const other = TENANT_ID.replace("1111-1111", "4444-4444");
    const storage = fakeStorage({
      listings: [[object(PROGRESS_KEY), object(accountWipeProgressKey(other))]],
    });
    const { code, out } = await run([], storage);

    expect(code).toBe(0);
    expect(out).toContain("Tenants named by these records (2)");
    expect(out).toContain(`from wipe_progress where tenant_id in ('${TENANT_ID}', '${other}')`);
    // A users.status count is the signal neither before nor after the deploy —
    // status survives a completed wipe, so it never returns to 0.
    expect(out).not.toContain("count(*)");
    expect(out).toContain("status='deleting' is NOT the signal");

    // S2's deploy is the precondition; pre-deploy the rule is wait, not
    // sweep-around: a stale record is DUE FOR RESUMPTION, not inert
    // (src/account-wipe.ts wipeLeaseHeld). Post-deploy the in-flight signal
    // lives in D1, not in R2, and the lease window is the worker's own.
    expect(out).toContain("BEFORE S2 DEPLOYS");
    expect(out).toContain("AFTER S2 DEPLOYS");
    expect(out).toContain("Do not sweep around it");
    expect(out).toContain("RESUME");
    expect(out).toContain("completed_at_ms NULL and a recent updated_at_ms heartbeat");
    expect(out).toContain(`${ACCOUNT_WIPE_IN_FLIGHT_MS / 60_000} minutes`);
  });



  it("points the evidence query at the database variable matching the bucket", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)]] });
    const { out } = await run(["--bucket", "reading-lite-staging"], storage);

    expect(out).toContain("STAGING_DATABASE_URL");
    expect(out).not.toContain("PRODUCTION_DATABASE_URL");
  });

  it("offers no query at all for a bucket with no mapped control plane", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)]] });
    const { out } = await run(["--bucket", "some-scratch-bucket"], storage);

    expect(out).toContain("No control-plane database is mapped");
    expect(out).not.toContain("wrangler d1 execute");
  });

  it("says so when nothing listed is a tenant-named progress record", async () => {
    const storage = fakeStorage({ listings: [[object(`${WIPE_PREFIX}stray.json`)]] });
    const { code, out } = await run([], storage);
    expect(code).toBe(0);
    expect(out).toContain("none names a tenant");
    expect(out).not.toContain("Tenants named by these records");
  });

  it("reports an object with no last-modified rather than inventing one", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY, { lastModified: undefined })]] });
    const { code, out } = await run([], storage);
    expect(code).toBe(0);
    expect(out).toContain("(no last-modified reported)");
  });

  it("succeeds with nothing to do on an already-empty prefix", async () => {
    const storage = fakeStorage({ listings: [[]] });
    const { code, out } = await run(["--execute", ACK], storage);
    expect(code).toBe(0);
    expect(storage.deletes).toEqual([]);
    expect(out).toContain("already empty");
  });

  it("deletes under --execute and exits 0 when the re-list comes back clean", async () => {
    const second = `${WIPE_PREFIX}${TENANT_ID.replace("1111-1111", "2222-2222")}/progress.json`;
    const storage = fakeStorage({ listings: [[object(second), object(PROGRESS_KEY)], []] });
    const { code, out } = await run(["--execute", ACK], storage);

    expect(code).toBe(0);
    expect(storage.deletes).toEqual([PROGRESS_KEY, second].sort());
    // Listed once to plan, once to verify.
    expect(storage.prefixes).toEqual([WIPE_PREFIX, WIPE_PREFIX]);
    expect(out).toContain("VERIFIED");
  });

  it("exits non-zero when the post-delete re-list still shows objects", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)], [object(PROGRESS_KEY)]] });
    const { code, out, err } = await run(["--execute", ACK], storage);

    expect(code).toBe(1);
    expect(storage.deletes).toEqual([PROGRESS_KEY]);
    expect(err).toContain("VERIFICATION FAILED");
    expect(err).toContain(PROGRESS_KEY);
    expect(err).toContain("survived the delete");
    expect(err).not.toContain("NEW or REWRITTEN");
    expect(out).not.toContain("VERIFIED:");
  });

  it("flags a record that appeared after the plan listing rather than telling the operator to re-run", async () => {
    const appeared = `${WIPE_PREFIX}${TENANT_ID.replace("1111-1111", "3333-3333")}/progress.json`;
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)], [object(appeared)]] });
    const { code, err } = await run(["--execute", ACK], storage);

    expect(code).toBe(1);
    expect(storage.deletes).toEqual([PROGRESS_KEY]);
    expect(err).toContain("NEW or REWRITTEN");
    expect(err).toContain(appeared);
    expect(err).toContain("do NOT re-run blind");
    expect(err).toContain("wipe_progress");
    expect(err).not.toContain("survived the delete");
  });

  it("treats the same key re-created with different bytes as rewritten, not survived", async () => {
    // The worst case: a wipe writes a fresh record for the very tenant whose
    // record this run just deleted. By key alone that reads as a survivor, and
    // "re-running is safe" is the one thing it is not.
    const storage = fakeStorage({
      listings: [
        [object(PROGRESS_KEY, { etag: "before" })],
        [object(PROGRESS_KEY, { etag: "after" })],
      ],
    });
    const { code, err } = await run(["--execute", ACK], storage);

    expect(code).toBe(1);
    expect(err).toContain("NEW or REWRITTEN");
    expect(err).not.toContain("survived the delete");
  });

  it("does not call a row a survivor when neither listing carries an etag", async () => {
    const storage = fakeStorage({
      listings: [[object(PROGRESS_KEY, { etag: "" })], [object(PROGRESS_KEY, { etag: "" })]],
    });
    const { code, err } = await run(["--execute", ACK], storage);

    expect(code).toBe(1);
    expect(err).toContain("NEW or REWRITTEN");
    expect(err).not.toContain("survived the delete");
  });

  it("tells the operator how to clear a key it refuses to delete itself", async () => {
    const storage = fakeStorage({ listings: [[object(`${WIPE_PREFIX}a//b.json`)], []] });
    const { code, err } = await run(["--execute", ACK], storage);

    expect(code).toBe(1);
    expect(storage.deletes).toEqual([]);
    expect(err).toContain("REFUSED");
    expect(err).toContain("wrangler r2 object delete");
  });

  it("exits non-zero when a delete errored even if the prefix re-lists empty", async () => {
    const storage = fakeStorage({
      listings: [[object(PROGRESS_KEY)], []],
      deleteFails: new Set([PROGRESS_KEY]),
    });
    const { code, err } = await run(["--execute", ACK], storage);

    expect(code).toBe(1);
    expect(err).toContain("unverified");
  });

  it("aborts before any delete when the listing returns a key outside wipe/", async () => {
    const tenantKey = `u/${TENANT_ID}/index/list.json`;
    const legacyKeys = ["readings/2026/04/26T200000Z-rd_abc123/manifest.json", "index/list.json"];
    for (const stray of [tenantKey, ...legacyKeys]) {
      const storage = fakeStorage({ listings: [[object(PROGRESS_KEY), object(stray)], []] });
      const { code, err } = await run(["--execute", ACK], storage);

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

  it("refuses --execute without the no-active-wipe acknowledgement, before touching R2", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)]] });
    await expect(run(["--execute"], storage)).rejects.toThrow(
      /--execute requires --acknowledge-no-active-wipe/,
    );
    // Refused at parse time: no listing, no deletes.
    expect(storage.prefixes).toEqual([]);
    expect(storage.deletes).toEqual([]);
  });

  it("does not require the acknowledgement in plan mode", async () => {
    const storage = fakeStorage({ listings: [[object(PROGRESS_KEY)]] });
    const { code } = await run([], storage);
    expect(code).toBe(0);
    expect(storage.deletes).toEqual([]);
  });

  it("maps the missing acknowledgement onto the CLI's usage exit code", async () => {
    const { io, err } = captureIo();
    const code = await runCli(["account", "sweep-wipe-prefix", "--execute"], {
      io,
      depsFor: () => ({
        io,
        createStorage: async () => {
          throw new Error("storage must not be reached for a usage refusal");
        },
      }),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--acknowledge-no-active-wipe");
  });
});
