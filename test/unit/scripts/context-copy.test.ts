import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stagingPrepareContextCommand,
  type PrepareContextDeps,
} from "../../../scripts/ops-lib/commands/staging-prepare-context";
import {
  prepareContextCopy,
  copyHash,
  type CopyReaders,
} from "../../../scripts/staging-lib/context-copy";
import { ManifestSchema } from "../../../src/schemas/manifest";
const source = "usr_550e8400-e29b-41d4-a716-446655440000",
  destination = "usr_550e8400-e29b-41d4-a716-446655440001";
const id = "rd_0000000001",
  prefix = "readings/imported/" + id,
  url = "https://example.com/article";
const input = {
  sourceTenant: source,
  destinationTenant: destination,
  ids: [id],
  targets: [],
  now: "2026-09-06T00:00:00.000Z",
};
function fixture() {
  const manifest = ManifestSchema.parse({
    id,
    url,
    url_hash: copyHash(url),
    status: "ready",
    title: "Title",
    tldr: "Summary",
    content_type: "text/markdown",
    content_status: "captured",
    content_bytes: 4,
    extracted_bytes: 4,
    content_sha256: copyHash("text"),
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    connections: [],
    tensions: [
      {
        id: "rd_outside",
        kind: "qualifies",
        reason: "a reason",
        computed_at: "2026-09-01T00:00:00.000Z",
      },
    ],
  });
  const entry = {
    keyPrefix: prefix,
    manifest,
    ownerId: id,
    revisionId: "rv_current",
    contentKeys: {
      rawKey: prefix + "/revisions/current/raw.md",
      extractedKey: prefix + "/revisions/current/extracted.md",
      contentType: "text/markdown",
    },
    embedding: Array(1536).fill(0.1),
  };
  const files: Record<string, string> = {
    [entry.contentKeys.rawKey]: "text",
    [entry.contentKeys.extractedKey]: "text",
  };
  const readers = {
    source: {
      read: vi.fn(async (key: string) =>
        files[key] === undefined
          ? null
          : { body: Buffer.from(files[key]), contentType: "text/markdown" },
      ),
    },
    destination: {
      list: vi.fn(async (_prefix: string): Promise<string[]> => []),
    },
    rows: vi.fn(async () => [entry]),
  } satisfies CopyReaders;
  return { entry, files, readers };
}

describe("PostgreSQL context artifact", () => {
  it("exports only content and tenant-rewritten row payloads, preserving current revision and relationship flags", async () => {
    const f = fixture();
    f.files[prefix + "/revisions/old/raw.md"] = "old";
    const p = await prepareContextCopy(
      { ...input, targets: [{ id, contentSha256: copyHash("text") }] },
      f.readers,
    );
    expect(p.format).toBe("reading-lite-staging-context-v2");
    expect(p.objects.map((o) => o.key)).toEqual([
      `u/${destination}/${f.entry.contentKeys.extractedKey}`,
      `u/${destination}/${f.entry.contentKeys.rawKey}`,
    ]);
    expect(p.rows[0]).toMatchObject({
      reading: {
        tenant_id: destination,
        key_prefix: prefix,
        active_attempt: null,
        last_attempt: null,
        current_revision_id: "rv_current",
      },
      ownsUrl: true,
      revision: {
        id: "rv_current",
        raw_key: f.entry.contentKeys.rawKey,
        connections_present: true,
        tensions_present: true,
      },
      relationships: [
        { kind: "tension", target_id: "rd_outside", position: 0 },
      ],
      embedding: f.entry.embedding,
    });
    expect(p.targets[0]).toMatchObject({ action: "reprocess", stagingId: id });
    expect(p.readingIds).toEqual([id]);
    expect(p.sourceRowChecks).toHaveLength(1);
    expect(p.sourceChecks).toHaveLength(2);
    expect(f.readers.source.read).toHaveBeenCalledTimes(2);
    expect(p.destinationChecks).toEqual([
      {
        id,
        url,
        urlHash: copyHash(url),
        keyPrefix: prefix,
        expected: "absent",
      },
    ]);
  });

  it("copies a shared raw/Markdown content key once", async () => {
    const f = fixture();
    f.entry.contentKeys.extractedKey = f.entry.contentKeys.rawKey;
    const p = await prepareContextCopy(input, f.readers);
    expect(p.objects).toHaveLength(1);
    expect(f.readers.source.read).toHaveBeenCalledOnce();
    expect(p.rows[0].revision!.extracted_key).toBe(p.rows[0].revision!.raw_key);
  });

  it("hashes the original row before projecting an expired attempt and refuses fresh work", async () => {
    const f = fixture();
    const initial = await prepareContextCopy(input, f.readers);
    f.entry.manifest.active_attempt = {
      id: "at_old",
      trigger: "reprocess",
      status: "running",
      started_at: "2026-06-18T19:20:07.533Z",
    };
    const p = await prepareContextCopy(input, f.readers);
    expect(p.rows[0].reading.active_attempt).toBeNull();
    expect(p.rows[0].reading.last_attempt).toBeNull();
    expect(p.sourceRowChecks[0].sha256).not.toBe(
      initial.sourceRowChecks[0].sha256,
    );
    f.entry.manifest.active_attempt.started_at = "2026-09-05T23:59:00Z";
    await expect(prepareContextCopy(input, f.readers)).rejects.toThrow(
      "identity/state mismatch",
    );
  });

  it.each([
    "../escape",
    "/absolute",
    "readings/a/../b",
    "readings/a%2Fb",
    "readings/a\\b",
  ])("refuses unsafe stored prefix %s", async (keyPrefix) => {
    const f = fixture();
    f.entry.keyPrefix = keyPrefix;
    await expect(prepareContextCopy(input, f.readers)).rejects.toThrow(
      "Unsafe",
    );
    expect(f.readers.source.read).not.toHaveBeenCalled();
  });
  it("rejects foreign content keys and orphaned destination bytes", async () => {
    const f = fixture();
    f.entry.contentKeys.rawKey = "readings/another/raw.md";
    await expect(prepareContextCopy(input, f.readers)).rejects.toThrow(
      "outside",
    );
    expect(f.readers.source.read).not.toHaveBeenCalled();
    const g = fixture();
    g.readers.destination.list.mockResolvedValue([prefix + "/orphan"]);
    await expect(prepareContextCopy(input, g.readers)).rejects.toThrow(
      "Occupied destination",
    );
  });
  it.each(["hash", "size", "markdown", "missing", "ownership", "embedding"])(
    "rejects %s corruption",
    async (fault) => {
      const f = fixture();
      if (fault === "hash") f.files[f.entry.contentKeys.rawKey] = "else";
      if (fault === "size") f.entry.manifest.content_bytes = 9;
      if (fault === "markdown")
        f.files[f.entry.contentKeys.extractedKey] = "longer";
      if (fault === "missing") delete f.files[f.entry.contentKeys.rawKey];
      if (fault === "ownership") f.entry.ownerId = "rd_other";
      if (fault === "embedding") f.entry.embedding = [NaN];
      await expect(prepareContextCopy(input, f.readers)).rejects.toThrow();
    },
  );
  it("pins target Markdown hashes and preserves import vs reprocess mapping", async () => {
    const f = fixture();
    const targetId = "rd_0000000002",
      targetPrefix = "readings/imported/" + targetId;
    const target = {
      ...f.entry,
      keyPrefix: targetPrefix,
      manifest: {
        ...f.entry.manifest,
        id: targetId,
        url: url + "/target",
        url_hash: copyHash(url + "/target"),
      },
      ownerId: targetId,
      contentKeys: {
        ...f.entry.contentKeys,
        rawKey: targetPrefix + "/raw.md",
        extractedKey: targetPrefix + "/extracted.md",
      },
    };
    f.readers.rows.mockResolvedValue([f.entry, target]);
    f.files[target.contentKeys.rawKey] = "text";
    f.files[target.contentKeys.extractedKey] = "else";
    const args = {
      ...input,
      targets: [
        {
          id: targetId,
          contentSha256: copyHash("text"),
          markdownSha256: copyHash("text"),
        },
      ],
    };
    await expect(prepareContextCopy(args, f.readers)).rejects.toThrow(
      "Markdown hash changed",
    );
    f.files[target.contentKeys.extractedKey] = "text";
    const p = await prepareContextCopy(args, f.readers);
    expect(p.rows).toHaveLength(1);
    expect(p.objects).toHaveLength(2);
    expect(p.targets[0]).toMatchObject({
      action: "import",
      sourceId: targetId,
    });
    expect(p.targets[0].stagingId).toBeUndefined();
    expect(p.sourceChecks).toHaveLength(4);
  });
  it("rejects unsafe or duplicate input before any row access", async () => {
    for (const args of [
      { ...input, sourceTenant: destination },
      { ...input, ids: ["../escape"] },
      { ...input, ids: [id, id] },
    ]) {
      const f = fixture();
      await expect(prepareContextCopy(args, f.readers)).rejects.toThrow();
      expect(f.readers.rows).not.toHaveBeenCalled();
    }
  });
});

describe("context command", () => {
  function deps() {
    const f = fixture();
    return {
      io: { stdout: vi.fn(), stderr: vi.fn() },
      now: () => input.now,
      readInput: async () => ({ ids: [id], targets: [] }),
      withReaders: async <T>(
        _source: string,
        _destination: string,
        _vars: string | undefined,
        work: (r: CopyReaders) => Promise<T>,
      ) => work(f.readers),
      save: vi.fn(),
    } satisfies PrepareContextDeps;
  }
  const args = [
    "--source-tenant",
    source,
    "--tenant",
    destination,
    "--input",
    "selection.json",
  ];
  it("prints a plan without local writes", async () => {
    const d = deps();
    expect(await stagingPrepareContextCommand.run(args, d)).toBe(0);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.io.stdout).toHaveBeenCalledWith(
      expect.stringContaining('"remoteWrites": 0'),
    );
  });
  it("requires execute and output directory together", async () => {
    const d = deps();
    await expect(
      stagingPrepareContextCommand.run([...args, "--output-dir", "packet"], d),
    ).rejects.toThrow();
    await expect(
      stagingPrepareContextCommand.run([...args, "--execute"], d),
    ).rejects.toThrow();
    expect(d.save).not.toHaveBeenCalled();
  });
  it("materializes a private checksummed v2 packet and refuses an existing output directory", async () => {
    const d = deps(),
      root = await mkdtemp(join(tmpdir(), "context-test-")),
      output = join(root, "packet");
    const save = stagingPrepareContextCommand.defaultDeps(d.io).save;
    try {
      expect(
        await stagingPrepareContextCommand.run(
          [...args, "--execute", "--output-dir", output],
          { ...d, save },
        ),
      ).toBe(0);
      const body = await readFile(join(output, "plan.json"), "utf8"),
        plan = JSON.parse(body);
      expect(plan.format).toBe("reading-lite-staging-context-v2");
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      expect((await stat(join(output, "plan.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(output, "SHA256SUMS"), "utf8")).toContain(
        copyHash(body) + "  plan.json",
      );
      for (const object of plan.objects)
        expect(
          copyHash(await readFile(join(output, "blobs", object.blob))),
        ).toBe(object.blob);
      await expect(
        stagingPrepareContextCommand.run(
          [...args, "--execute", "--output-dir", output],
          { ...d, save },
        ),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
