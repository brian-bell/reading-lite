import { describe, expect, it, vi } from "vitest";
import {
  corpusPurgeConnectionsCommand,
  type PurgeConnectionsStorage,
} from "../../../scripts/ops-lib/commands/corpus-purge-connections";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { makeR2RestClient } from "../../../scripts/lib/cf-clients";
import { mintReadingId, parseReadingId } from "../../../src/services";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "usr_22222222-2222-4222-8222-222222222222";
const TARGET = "rd_0123456789";
const READING_A = "rd_ABCDEFGHJK";
const READING_B = "rd_MNPQRSTVWY";
const READING_C = "rd_ZYXWVTSRQP";
const KEEP_1 = "rd_1111111111";
const KEEP_2 = "rd_2222222222";
const CONCURRENT = "rd_3333333333";

function canonicalKey(id: string, tenant?: string): string {
  return `${tenant ? `u/${tenant}/` : ""}readings/2026/08/29T120000Z-${id}/manifest.json`;
}

function manifest(id: string, connections: Array<{ id: string; reason: string }>) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "ready",
    title: id,
    connections,
    content_type: "text/markdown",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-08-29T12:00:00.000Z",
    updated_at: "2026-08-29T12:00:00.000Z",
  };
}

function memoryStorage(initial: Record<string, { body: string; etag: string }>) {
  const objects = new Map(Object.entries(initial));
  let writes = 0;
  const storage: PurgeConnectionsStorage = {
    head: vi.fn(async (key) => objects.has(key)),
    listObjects: vi.fn(async (prefix) =>
      [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.body.length, etag: value.etag })),
    ),
    get: vi.fn(async (key) => objects.get(key)?.body ?? null),
    putIfMatch: vi.fn(async (key, body, etag) => {
      const current = objects.get(key);
      if (!current || current.etag !== etag) return false;
      writes += 1;
      objects.set(key, { body, etag: `written-${writes}` });
      return true;
    }),
  };
  return { storage, objects };
}

async function run(
  argv: string[],
  storage: PurgeConnectionsStorage,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await corpusPurgeConnectionsCommand.run(argv, {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    createStorage: vi.fn(async () => storage),
  });
  return { code, out, err };
}

describe("ops corpus purge-connections", () => {
  it("ignores a manifest-looking key whose reading id contains a percent-encoded separator", async () => {
    const invalidId = "rd_PREFIX%2Fbackup";
    const key = canonicalKey(invalidId);
    const { storage } = memoryStorage({
      [key]: {
        body: JSON.stringify(manifest(invalidId, [{ id: "rd_0123456789", reason: "must ignore" }])),
        etag: "e1",
      },
    });

    const result = await run(
      ["--tenant", "global", "--id", "rd_0123456789", "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_scanned: 0,
      manifests_matched: 0,
      manifests_written: 0,
    });
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.putIfMatch).not.toHaveBeenCalled();
  });

  it.each([
    ["digits", "rd_9876543210"],
    ["allowed letters", "rd_ABCDEFGHJK"],
    ["mixed Crockford alphabet", "rd_MNPQRSTVWY"],
  ])("accepts a canonical key containing a valid minted-form id: %s", async (_case, readingId) => {
    const key = canonicalKey(readingId);
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(readingId, [])), etag: "e1" },
    });

    const result = await run(["--tenant", "global", "--id", TARGET], storage);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ manifests_scanned: 1 });
    expect(storage.get).toHaveBeenCalledWith(key);
  });

  it.each([
    ["uppercase encoded slash", "rd_PREFIX%2Fbackup"],
    ["lowercase encoded slash", "rd_PREFIX%2fbackup"],
    ["literal slash", "rd_PREFIX/backup"],
    ["backslash", "rd_PREFIX\\backup"],
    ["colon", "rd_PREFIX:backup"],
    ["percent", "rd_PREFIX%backup"],
    ["dot segments", "rd_../backup"],
    ["query-like text", "rd_PREFIX?backup"],
    ["hash-like text", "rd_PREFIX#backup"],
    ["whitespace", "rd_PREFIX backup"],
    ["control character", "rd_PREFIX\u0001X"],
    ["Unicode", "rd_PRÉFIXBACK"],
    ["short suffix", "rd_123456789"],
    ["long suffix", "rd_12345678901"],
    ["lowercase suffix", "rd_abcdefghjk"],
    ["ambiguous I", "rd_ABCDEFHIJK"],
    ["ambiguous L", "rd_ABCDEFHLJK"],
    ["ambiguous O", "rd_ABCDEFOHJK"],
    ["ambiguous U", "rd_ABCDEFUHJK"],
  ])("ignores a non-mintable manifest key without fetching it: %s", async (_case, readingId) => {
    const key = canonicalKey(readingId);
    const { storage } = memoryStorage({ [key]: { body: "{corrupt-but-ignored", etag: "e1" } });

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_scanned: 0,
      manifests_matched: 0,
      manifests_written: 0,
    });
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.putIfMatch).not.toHaveBeenCalled();
  });

  it("keeps parsing and minting on one exact reading-id alphabet", () => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (const character of alphabet) {
      expect(parseReadingId(`rd_${character.repeat(10)}`)).toBe(`rd_${character.repeat(10)}`);
    }
    for (const character of ["I", "L", "O", "U"]) {
      expect(parseReadingId(`rd_${character.repeat(10)}`)).toBeNull();
    }
    for (let index = 0; index < 100; index += 1) {
      const minted = mintReadingId();
      expect(parseReadingId(minted)).toBe(minted);
    }
  });

  it("rejects an invalid target id with one audit and no storage calls", async () => {
    const createStorage = vi.fn();
    const out: string[] = [];
    const err: string[] = [];

    const code = await corpusPurgeConnectionsCommand.run(
      ["--tenant", "global", "--id", "rd_PREFIX%2Fbackup"],
      {
        io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
        createStorage,
      },
    );

    expect(code).toBe(2);
    expect(createStorage).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      target_id: "rd_PREFIX%2Fbackup",
      manifests_scanned: 0,
      manifests_written: 0,
      failures: 1,
      partial_execution: false,
      failure_code: "invalid_target",
      failure_stage: "validate_target",
    });
    expect(err).toEqual(["REFUSED: --id must be a valid reading id"]);
  });

  it("plans a tenant-rooted sweep using bare connection ids without writing", async () => {
    const key = canonicalKey(READING_A, TENANT);
    const putIfMatch = vi.fn();
    const out: string[] = [];
    const code = await corpusPurgeConnectionsCommand.run(
      ["--tenant", TENANT, "--id", TARGET],
      {
        io: { stdout: (line) => out.push(line), stderr: vi.fn() },
        createStorage: vi.fn(async () => ({
          head: vi.fn(async () => false),
          listObjects: vi.fn(async () => [{ key, size: 1, etag: "e1" }]),
          get: vi.fn(async () => JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "old link" }]))),
          putIfMatch,
        })),
      },
    );

    expect(code).toBe(0);
    expect(putIfMatch).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      mode: "plan",
      tenant: TENANT,
      tenant_audit_stamp: { tenant_id: TENANT },
      target_id: TARGET,
      manifests_scanned: 1,
      manifests_matched: 1,
      matching_entries_found: 1,
      manifests_would_write: 1,
      manifests_written: 0,
      unchanged_manifests: 0,
      failures: 0,
      partial_execution: false,
    });
  });

  it("ignores nested, backup, and trailing manifest-shaped objects", async () => {
    const canonical = canonicalKey(READING_A);
    const nested = `readings/2026/08/29T120000Z-${READING_A}/attempts/manifest.json`;
    const backup = `readings/2026/08/29T120000Z-${READING_A}/backup/manifest.json`;
    const trailing = `${canonical}.bak`;
    const { storage, objects } = memoryStorage({
      [canonical]: {
        body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "canonical" }])),
        etag: "canonical-etag",
      },
      [nested]: {
        body: JSON.stringify(manifest(READING_B, [{ id: TARGET, reason: "must ignore" }])),
        etag: "nested-etag",
      },
      [backup]: { body: "{broken", etag: "backup-etag" },
      [trailing]: { body: "{broken", etag: "trailing-etag" },
    });

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_scanned: 1,
      manifests_matched: 1,
      manifests_written: 1,
    });
    expect(storage.putIfMatch).toHaveBeenCalledTimes(1);
    expect(storage.putIfMatch).toHaveBeenCalledWith(canonical, expect.any(String), "canonical-etag");
    expect(storage.get).not.toHaveBeenCalledWith(nested);
    expect(storage.get).not.toHaveBeenCalledWith(backup);
    expect(storage.get).not.toHaveBeenCalledWith(trailing);
    expect(JSON.parse(objects.get(nested)!.body).connections).toEqual([
      { id: TARGET, reason: "must ignore" },
    ]);
  });

  it("refuses a valid canonical key whose body has a different valid reading id", async () => {
    const key = canonicalKey(READING_A);
    const { storage } = memoryStorage({
      [key]: {
        body: JSON.stringify(manifest(READING_B, [{ id: TARGET, reason: "x" }])),
        etag: "e1",
      },
    });

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 0,
      failures: 1,
      partial_execution: false,
      failure_code: "manifest_invalid",
      failure_stage: "validate_manifest",
    });
    expect(storage.putIfMatch).not.toHaveBeenCalled();
  });

  it("refuses a valid canonical key whose body has a non-mintable reading id", async () => {
    const key = canonicalKey(READING_A);
    const { storage } = memoryStorage({
      [key]: {
        body: JSON.stringify(manifest("rd_invalid", [{ id: TARGET, reason: "x" }])),
        etag: "e1",
      },
    });

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 0,
      failures: 1,
      partial_execution: false,
      failure_code: "manifest_invalid",
      failure_stage: "validate_manifest",
    });
    expect(storage.putIfMatch).not.toHaveBeenCalled();
  });

  it("refuses a valid canonical key whose created_at does not match its timestamp", async () => {
    const key = canonicalKey(READING_A);
    const corrupted = { ...manifest(READING_A, [{ id: TARGET, reason: "x" }]), created_at: "2026-08-29T12:00:01.000Z" };
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(corrupted), etag: "e1" },
    });

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 0,
      failures: 1,
      failure_code: "manifest_invalid",
      failure_stage: "validate_manifest",
    });
    expect(storage.putIfMatch).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", TENANT],
    ["global", undefined],
  ])("executes against a valid canonical %s key", async (_case, tenant) => {
    const key = canonicalKey(READING_A, tenant);
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "e1" },
    });
    const selector = tenant ?? "global";

    const result = await run(
      ["--tenant", selector, "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      tenant: selector,
      manifests_scanned: 1,
      manifests_written: 1,
    });
    expect(storage.putIfMatch).toHaveBeenCalledWith(key, expect.any(String), "e1");
  });

  it("requires --execute and --sole-writer to be paired before storage access", async () => {
    const createStorage = vi.fn();
    await expect(
      corpusPurgeConnectionsCommand.run(["--tenant", "global", "--id", TARGET, "--execute"], {
        io: { stdout: vi.fn(), stderr: vi.fn() },
        createStorage,
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(createStorage).not.toHaveBeenCalled();
  });

  it("refuses when the target exists, before scanning or writing", async () => {
    const storage = memoryStorage({}).storage;
    vi.mocked(storage.head).mockResolvedValue(true);
    const result = await run(["--tenant", "global", "--id", TARGET], storage);
    expect(result.code).toBe(1);
    expect(storage.listObjects).not.toHaveBeenCalled();
    expect(storage.putIfMatch).not.toHaveBeenCalled();
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      failures: 1,
      partial_execution: false,
      failure_code: "target_present",
      failure_stage: "check_target",
    });
  });

  it("also refuses a target manifest when its by-id witness is missing", async () => {
    const key = canonicalKey(TARGET);
    const { storage } = memoryStorage({ [key]: { body: JSON.stringify(manifest(TARGET, [])), etag: "e1" } });
    const result = await run(["--tenant", "global", "--id", TARGET], storage);
    expect(result.code).toBe(1);
    expect(storage.putIfMatch).not.toHaveBeenCalled();
  });

  it("keeps tenant scans isolated and supports the explicit global layout", async () => {
    const tenantKey = canonicalKey(READING_A, TENANT);
    const otherKey = canonicalKey(READING_B, OTHER_TENANT);
    const globalKey = canonicalKey(READING_C);
    const { storage } = memoryStorage({
      [tenantKey]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "t1" },
      [otherKey]: { body: JSON.stringify(manifest(READING_B, [{ id: TARGET, reason: "x" }])), etag: "o1" },
      [globalKey]: { body: JSON.stringify(manifest(READING_C, [{ id: TARGET, reason: "x" }])), etag: "g1" },
      [`u/${TENANT}/readings/2026/08/29T120000Z-${READING_A}/backup/manifest.json`]: {
        body: "{not-even-json",
        etag: "backup",
      },
    });
    const tenantResult = await run(["--tenant", TENANT, "--id", TARGET], storage);
    expect(JSON.parse(tenantResult.out[0]!)).toMatchObject({ manifests_scanned: 1, manifests_matched: 1 });
    expect(storage.listObjects).toHaveBeenLastCalledWith(`u/${TENANT}/readings/`);

    const globalResult = await run(["--tenant", "global", "--id", TARGET], storage);
    expect(JSON.parse(globalResult.out[0]!)).toMatchObject({ tenant: "global", tenant_audit_stamp: null, manifests_scanned: 1 });
    expect(storage.listObjects).toHaveBeenLastCalledWith("readings/");
  });

  it.each([TENANT, OTHER_TENANT])("purges connections only in selected tenant %s when reading ids overlap", async (selected) => {
    const initial = Object.fromEntries([TENANT, OTHER_TENANT, undefined].map((tenant) => [
      canonicalKey(READING_A, tenant),
      {
        body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "remove" }, { id: KEEP_1, reason: "keep" }])),
        etag: tenant ?? "legacy",
      },
    ]));
    const { storage, objects } = memoryStorage(initial);
    const result = await run(["--tenant", selected, "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ manifests_scanned: 1, manifests_written: 1 });
    expect(JSON.parse(objects.get(canonicalKey(READING_A, selected))!.body).connections).toEqual([
      { id: KEEP_1, reason: "keep" },
    ]);
    for (const tenant of [TENANT, OTHER_TENANT, undefined].filter((t) => t !== selected)) {
      const key = canonicalKey(READING_A, tenant);
      expect(objects.get(key)).toEqual(initial[key]);
    }
  });

  it("removes duplicate matches across manifests while preserving order and unrelated fields", async () => {
    const keyA = canonicalKey(READING_A);
    const keyB = canonicalKey(READING_B);
    const { storage, objects } = memoryStorage({
      [keyA]: {
        body: JSON.stringify({
          ...manifest(READING_A, [
            { id: KEEP_1, reason: "first" },
            { id: TARGET, reason: "duplicate one" },
            { id: TARGET, reason: "duplicate two" },
            { id: KEEP_2, reason: "last" },
          ]),
          future_field: { preserve: true },
        }),
        etag: "a1",
      },
      [keyB]: { body: JSON.stringify(manifest(READING_B, [{ id: TARGET, reason: "one" }])), etag: "b1" },
    });
    const result = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_scanned: 2,
      manifests_matched: 2,
      matching_entries_found: 3,
      manifests_written: 2,
      conflicts: 0,
    });
    const written = JSON.parse(objects.get(keyA)!.body);
    expect(written.connections).toEqual([
      { id: KEEP_1, reason: "first" },
      { id: KEEP_2, reason: "last" },
    ]);
    expect(written.future_field).toEqual({ preserve: true });
    expect(written.title).toBe(READING_A);
  });

  it("validates the complete preflight before its first write", async () => {
    const { storage } = memoryStorage({
      [canonicalKey(READING_A)]: {
        body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])),
        etag: "a1",
      },
      [canonicalKey(READING_C)]: { body: "{broken", etag: "z1" },
    });
    const result = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(storage.putIfMatch).not.toHaveBeenCalled();
    expect(result.err.join("\n")).toContain("malformed manifest");
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      failures: 1,
      manifests_written: 0,
      partial_execution: false,
      failure_code: "manifest_invalid",
      failure_stage: "validate_manifest",
    });
  });

  it("reports a sanitized non-partial audit when storage fails before any write", async () => {
    const secret = "api-token-must-not-leak";
    const storage = memoryStorage({}).storage;
    vi.mocked(storage.listObjects).mockRejectedValue(
      new Error(`permission denied ${secret} ${"provider-body ".repeat(100)}`),
    );

    const result = await run(["--tenant", "global", "--id", TARGET], storage);

    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 0,
      failures: 1,
      partial_execution: false,
      failure_code: "storage_error",
      failure_stage: "list_manifests",
    });
    expect(result.err.join("\n")).not.toContain(secret);
    expect(result.err.join("\n")).not.toContain("provider-body");
  });

  it("reports a 2xx Cloudflare error envelope as a failed write, never a success", async () => {
    const key = canonicalKey(READING_A);
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
    });
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "denied" }] }), { status: 200 }),
    );
    const rest = makeR2RestClient(
      { accountId: "acct", apiToken: "secret-token", bucket: "bucket" },
      fetchFn as unknown as typeof fetch,
    );
    storage.putIfMatch = (objectKey, body, etag) => rest.putIfMatch(objectKey, body, etag);

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 0,
      failures: 1,
      partial_execution: false,
      failure_code: "storage_error",
      failure_stage: "write_manifest",
    });
    expect(result.err.join("\n")).not.toContain("secret-token");
    expect(result.err.join("\n")).not.toContain("denied");
  });

  it("detects target recreation immediately before mutation", async () => {
    const key = canonicalKey(READING_A);
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
    });
    vi.mocked(storage.head).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(storage.putIfMatch).not.toHaveBeenCalled();
    expect(result.err.join("\n")).toContain("before mutation");
  });

  it("retries a CAS conflict against the newest valid manifest and preserves concurrent changes", async () => {
    const key = canonicalKey(READING_A);
    const { storage, objects } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
    });
    vi.mocked(storage.putIfMatch).mockImplementationOnce(async () => {
      objects.set(key, {
        body: JSON.stringify({
          ...manifest(READING_A, [{ id: TARGET, reason: "x" }, { id: CONCURRENT, reason: "concurrent" }]),
          concurrent_field: true,
        }),
        etag: "a2",
      });
      return false;
    });
    const result = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ conflicts: 1, retries: 1, manifests_written: 1 });
    const written = JSON.parse(objects.get(key)!.body);
    expect(written.concurrent_field).toBe(true);
    expect(written.connections).toEqual([{ id: CONCURRENT, reason: "concurrent" }]);
  });

  it("exhausts bounded CAS retries without a blind overwrite", async () => {
    const key = canonicalKey(READING_A);
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
    });
    vi.mocked(storage.putIfMatch).mockResolvedValue(false);
    const result = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(1);
    expect(storage.putIfMatch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      conflicts: 4,
      retries: 3,
      failures: 1,
      manifests_written: 0,
      partial_execution: false,
      failure_code: "cas_exhausted",
      failure_stage: "write_manifest",
    });
    expect(result.err.join("\n")).toContain("no blind overwrite");
  });

  it("is a no-op when no matches remain and an idempotent rerun writes nothing", async () => {
    const key = canonicalKey(READING_A);
    const { storage } = memoryStorage({
      [key]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
    });
    expect((await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage)).code).toBe(0);
    vi.mocked(storage.putIfMatch).mockClear();
    const rerun = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(rerun.code).toBe(0);
    expect(storage.putIfMatch).not.toHaveBeenCalled();
    expect(JSON.parse(rerun.out[0]!)).toMatchObject({ manifests_matched: 0, manifests_written: 0, unchanged_manifests: 1 });
  });

  it("reports partial execution and failure if recreation appears during a later conflict retry", async () => {
    const keyA = canonicalKey(READING_A);
    const keyB = canonicalKey(READING_B);
    const { storage, objects } = memoryStorage({
      [keyA]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
      [keyB]: { body: JSON.stringify(manifest(READING_B, [{ id: TARGET, reason: "x" }])), etag: "b1" },
    });
    let puts = 0;
    vi.mocked(storage.putIfMatch).mockImplementation(async (...args) => {
      puts += 1;
      if (puts === 2) return false;
      const [key, body, etag] = args;
      const current = objects.get(key);
      if (!current || current.etag !== etag) return false;
      objects.set(key, { body, etag: `written-${puts}` });
      return true;
    });
    vi.mocked(storage.head)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await run(["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"], storage);
    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 1,
      conflicts: 1,
      retries: 0,
      failures: 1,
      partial_execution: true,
      failure_code: "target_present",
      failure_stage: "check_target",
    });
  });

  it("returns one sanitized partial audit when a later storage write throws", async () => {
    const keyA = canonicalKey(READING_A);
    const keyB = canonicalKey(READING_B);
    const secret = "Bearer should-not-leak";
    const { storage, objects } = memoryStorage({
      [keyA]: { body: JSON.stringify(manifest(READING_A, [{ id: TARGET, reason: "x" }])), etag: "a1" },
      [keyB]: { body: JSON.stringify(manifest(READING_B, [{ id: TARGET, reason: "x" }])), etag: "b1" },
    });
    vi.mocked(storage.putIfMatch)
      .mockImplementationOnce(async (key, body) => {
        objects.set(key, { body, etag: "written" });
        return true;
      })
      .mockRejectedValueOnce(new Error(`R2 denied: ${secret} ${"provider-body ".repeat(100)}`));

    const result = await run(
      ["--tenant", "global", "--id", TARGET, "--execute", "--sole-writer"],
      storage,
    );

    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      manifests_written: 1,
      failures: 1,
      partial_execution: true,
      failure_code: "storage_error",
      failure_stage: "write_manifest",
    });
    expect(result.err.join("\n")).not.toContain(secret);
    expect(result.err.join("\n")).not.toContain("provider-body");
  });
});
