import { describe, expect, it } from "vitest";
import {
  deleteObject,
  isObjectNotFound,
  keysForReading,
  queryByVectorId,
  readObject,
  vectorExists,
  writeListIndex,
  type Runner,
} from "../../../scripts/corpus-lib/wrangler-r2";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";

// A Runner that answers the `r2 object get`s keysForReading makes: the manifest
// read and the by-url pointer read. `undefined` for either means "absent" (the
// CLI exits non-zero), which keysForReading tolerates.
const runner = (opts: { manifest?: unknown; pointer?: unknown }): Runner =>
  async (_cmd, args) => {
    const isGet = args[0] === "r2" && args[1] === "object" && args[2] === "get";
    const target = String(args[3]);
    if (isGet && target.endsWith("/manifest.json") && opts.manifest !== undefined) {
      return { code: 0, stdout: JSON.stringify(opts.manifest), stderr: "" };
    }
    if (isGet && target.includes("index/by-url/") && opts.pointer !== undefined) {
      return { code: 0, stdout: JSON.stringify(opts.pointer), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "not found" };
  };

describe("keysForReading", () => {
  const id = "rd_a";
  const url = "https://example.com/a";
  const prefix = "readings/2026/06/18T000000Z-rd_a";
  const pointerKey = `index/by-url/${urlHash(url)}`;
  const deps = (opts: { manifest?: unknown; pointer?: unknown }) => ({
    bucket: "b",
    keyRoot: "",
    remote: true,
    run: runner(opts),
  });

  it("covers the manifest, content, by-id pointer and common raw extensions", async () => {
    const keys = await keysForReading(id, prefix, url, deps({ manifest: {} }));
    expect(keys).toContain(`${prefix}/manifest.json`);
    expect(keys).toContain(`${prefix}/extracted.md`);
    expect(keys).toContain(`index/by-id/${id}`);
    expect(keys).toContain(`${prefix}/raw.html`);
    expect(keys).toContain(`${prefix}/raw.pdf`);
  });

  it("deletes the manifest-referenced attempt files (active + last)", async () => {
    const keys = await keysForReading(id, prefix, url, deps({
      manifest: { active_attempt: { id: "at_ACTIVE" }, last_attempt: { id: "at_LAST" } },
    }));
    expect(keys).toContain(`${prefix}/attempts/at_ACTIVE.json`);
    expect(keys).toContain(`${prefix}/attempts/at_LAST.json`);
  });

  it("deletes the by-url pointer only when this reading owns it", async () => {
    const keys = await keysForReading(id, prefix, url, deps({
      manifest: {},
      pointer: { id, key_prefix: prefix },
    }));
    expect(keys).toContain(pointerKey);
  });

  it("does not delete a by-url pointer owned by a surviving reading", async () => {
    const keys = await keysForReading(id, prefix, url, deps({
      manifest: {},
      pointer: { id: "rd_survivor", key_prefix: "readings/other" },
    }));
    expect(keys).not.toContain(pointerKey);
  });

  it("does not delete a by-url pointer that is absent", async () => {
    const keys = await keysForReading(id, prefix, url, deps({ manifest: {} }));
    expect(keys).not.toContain(pointerKey);
  });

  it("aborts the drop when the by-url pointer read fails for a non-absent reason", async () => {
    // A transient/permission failure on the pointer GET (not a 404, not an auth
    // error) must NOT be mistaken for "pointer absent" — that would drop the
    // reading and rewrite list.json while a pointer it owns lingers. Fail loud.
    const run: Runner = async (_cmd, args) => {
      const target = String(args[3]);
      if (target.endsWith("/manifest.json")) return { code: 0, stdout: "{}", stderr: "" };
      return { code: 1, stdout: "", stderr: "Internal Server Error (500)" };
    };
    await expect(
      keysForReading(id, prefix, url, { bucket: "b", keyRoot: "", remote: true, run }),
    ).rejects.toThrow();
  });

  it("does not treat a transient pointer error as absent just because stderr echoes a '404'-bearing key", async () => {
    // by-url keys are SHA-256 hex strings that can contain "404"; a transient
    // error whose stderr quotes the key path must still abort, not be read as
    // "pointer absent".
    const run: Runner = async (_cmd, args) => {
      const target = String(args[3]);
      if (target.endsWith("/manifest.json")) return { code: 0, stdout: "{}", stderr: "" };
      return {
        code: 1,
        stdout: "",
        stderr: "503 Service Unavailable while reading b/index/by-url/aa404bbccdd",
      };
    };
    await expect(
      keysForReading(id, prefix, url, { bucket: "b", keyRoot: "", remote: true, run }),
    ).rejects.toThrow();
  });

  it("tolerates a missing/unreadable manifest (still returns the static keys)", async () => {
    const keys = await keysForReading(id, prefix, url, deps({}));
    expect(keys).toContain(`${prefix}/manifest.json`);
    expect(keys).toContain(`index/by-id/${id}`);
  });
});

describe("isObjectNotFound", () => {
  it("matches genuine key-not-found signals", () => {
    expect(isObjectNotFound("The specified key does not exist.")).toBe(true);
    expect(isObjectNotFound("NoSuchKey")).toBe(true);
    expect(isObjectNotFound("error: not found")).toBe(true);
    expect(isObjectNotFound("no such key")).toBe(true);
  });

  it("does not match a transient error whose text merely contains '404'", () => {
    expect(isObjectNotFound("503 Service Unavailable: GET b/index/by-url/aa404bb")).toBe(false);
    expect(isObjectNotFound("403 Forbidden")).toBe(false);
    expect(isObjectNotFound("Internal Server Error (500)")).toBe(false);
  });
});

describe("queryByVectorId", () => {
  const ok = (matches: unknown[]): Runner => async () => ({
    code: 0,
    stdout: `📋 Searching...\n${JSON.stringify({ count: matches.length, matches })}`,
    stderr: "",
  });

  it("parses matches out of wrangler's decorated stdout", async () => {
    const out = await queryByVectorId("idx", "rd_a", 6, {
      run: ok([{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7 }]),
    });
    expect(out).toEqual([{ id: "rd_a", score: 1 }, { id: "rd_b", score: 0.7 }]);
  });

  it("returns null on the real missing-vector signal, which exits ZERO", async () => {
    // Verified against wrangler 4.101: an unknown vector id is not an error.
    // It exits 0 with a warning on stderr and prints no JSON.
    const run: Runner = async () => ({
      code: 0,
      stdout: "📋 Searching for relevant vectors...",
      stderr: "▲ [WARNING] Could not find any relevant vectors",
    });
    expect(await queryByVectorId("idx", "rd_gone", 6, { run })).toBeNull();
  });

  it("throws on a non-zero exit instead of reporting a missing vector", async () => {
    // Missing vectors never exit non-zero, so a failure here is a real error.
    // Collapsing it into null would invent a corpus gap that does not exist.
    const run: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "Unknown arguments: bogusFlag\nwrangler vectorize query --filter '{ 'p2': { '$ne': true } }'",
    });
    await expect(queryByVectorId("idx", "rd_a", 6, { run })).rejects.toThrow(/vectorize query failed/i);
  });

  it("does not mistake CLI usage text for a missing vector", async () => {
    const run: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "error: no such option '--vector-id'",
    });
    await expect(queryByVectorId("idx", "rd_a", 6, { run })).rejects.toThrow();
  });

  it("throws when a zero exit yields neither JSON nor the known warning", async () => {
    // Silently returning null here would turn any future change in wrangler's
    // output shape into a fabricated 'no vector indexed' report.
    const run: Runner = async () => ({ code: 0, stdout: "something unexpected", stderr: "" });
    await expect(queryByVectorId("idx", "rd_a", 6, { run })).rejects.toThrow(/unexpected/i);
  });

  it("ignores malformed match entries rather than passing junk on", async () => {
    const out = await queryByVectorId("idx", "rd_a", 6, {
      run: ok([{ id: "rd_b", score: 0.5 }, { id: 7 }, { score: 0.2 }]),
    });
    expect(out).toEqual([{ id: "rd_b", score: 0.5 }]);
  });
});

describe("vectorExists", () => {
  it("is true when the index returns the vector", async () => {
    const run: Runner = async () => ({
      code: 0,
      stdout: `📋 Fetching vectors...\n${JSON.stringify([{ id: "rd_a", values: [1] }])}`,
      stderr: "",
    });
    expect(await vectorExists("idx", "rd_a", { run })).toBe(true);
  });

  it("is false on the confirmed not-found warning, which exits ZERO", async () => {
    const run: Runner = async () => ({
      code: 0,
      stdout: "📋 Fetching vectors...",
      stderr: "▲ [WARNING] The index does not contain vectors corresponding to the provided identifiers",
    });
    expect(await vectorExists("idx", "rd_gone", { run })).toBe(false);
  });

  it("is false for an empty array", async () => {
    const run: Runner = async () => ({ code: 0, stdout: "[]", stderr: "" });
    expect(await vectorExists("idx", "rd_gone", { run })).toBe(false);
  });

  it("throws on a non-zero exit rather than guessing absence", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "Unknown arguments: bogus" });
    await expect(vectorExists("idx", "rd_a", { run })).rejects.toThrow(/get-vectors/i);
  });

  it("throws when a zero exit yields neither JSON nor the known warning", async () => {
    const run: Runner = async () => ({ code: 0, stdout: "something unexpected", stderr: "" });
    await expect(vectorExists("idx", "rd_a", { run })).rejects.toThrow(/unexpected/i);
  });
});

// reading-lite-s1k.4.3: the wrangler helpers address the bucket through the
// tenant key root carried on R2Deps. Plan-level keys (what keysForReading
// returns, what delete plans print) stay RELATIVE — the root is applied only
// where a key becomes a bucket path, mirroring the worker's layout contract.
describe("tenant-rooted R2Deps", () => {
  const keyRoot = "u/usr_550e8400-e29b-41d4-a716-446655440000/";

  function capture(): { calls: string[][]; run: Runner } {
    const calls: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      calls.push(args.map(String));
      return { code: 0, stdout: "{}", stderr: "" };
    };
    return { calls, run };
  }

  it("prefixes reads and deletes with the key root", async () => {
    const { calls, run } = capture();
    const deps = { bucket: "b", remote: true, keyRoot, run };
    await readObject("index/list.json", deps);
    await deleteObject("readings/2026/06/18T000000Z-rd_a/manifest.json", deps);
    expect(calls[0]![3]).toBe(`b/${keyRoot}index/list.json`);
    expect(calls[1]![3]).toBe(`b/${keyRoot}readings/2026/06/18T000000Z-rd_a/manifest.json`);
  });

  it("writes index/list.json under the key root", async () => {
    const { calls, run } = capture();
    await writeListIndex([], { bucket: "b", remote: true, keyRoot, run });
    const put = calls.find((c) => c[2] === "put");
    expect(put?.[3]).toBe(`b/${keyRoot}index/list.json`);
  });

  it("roots the single-manifest put the same way", async () => {
    const { calls, run } = capture();
    const { putManifest } = await import("../../../scripts/corpus-lib/wrangler-put");
    await putManifest("readings/2026/06/18T000000Z-rd_a", { id: "rd_a" }, {
      bucket: "b", remote: true, keyRoot, run,
    });
    const put = calls.find((c) => c[2] === "put");
    expect(put?.[3]).toBe(`b/${keyRoot}readings/2026/06/18T000000Z-rd_a/manifest.json`);
  });

  it("scopes a by-vector-id query to the tenant namespace when given", async () => {
    const { calls, run } = capture();
    await queryByVectorId("idx", "rd_a", 5, { run, namespace: "usr_x" });
    expect(calls[0]).toContain("--namespace");
    expect(calls[0]![calls[0]!.indexOf("--namespace") + 1]).toBe("usr_x");
    await queryByVectorId("idx", "rd_a", 5, { run });
    expect(calls[1]).not.toContain("--namespace");
  });

  it("keeps the global layout when the key root is empty", async () => {
    const { calls, run } = capture();
    await readObject("index/list.json", { bucket: "b", remote: true, keyRoot: "", run });
    expect(calls[0]![3]).toBe("b/index/list.json");
  });
});
