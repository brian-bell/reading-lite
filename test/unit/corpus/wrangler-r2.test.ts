import { describe, expect, it } from "vitest";
import {
  deleteObject,
  isObjectNotFound,
  readObject,
  type Runner,
} from "../../../scripts/corpus-lib/wrangler-r2";

describe("isObjectNotFound", () => {
  it("matches genuine key-not-found signals", () => {
    expect(isObjectNotFound("The specified key does not exist.")).toBe(true);
    expect(isObjectNotFound("NoSuchKey")).toBe(true);
    expect(isObjectNotFound("error: not found")).toBe(true);
    expect(isObjectNotFound("no such key")).toBe(true);
  });

  it("does not match a transient error whose text merely contains '404'", () => {
    expect(isObjectNotFound("503 Service Unavailable: GET b/readings/2026/06/18T000000Z-rd_aa404bb/extracted.md")).toBe(false);
    expect(isObjectNotFound("403 Forbidden")).toBe(false);
    expect(isObjectNotFound("Internal Server Error (500)")).toBe(false);
  });
});

// reading-lite-s1k.4.3: the wrangler helpers address the bucket through the
// tenant key root carried on R2Deps. Plan-level keys (what keysForReading
// returns, what delete plans print) stay RELATIVE — the root is applied only
// where a key becomes a bucket path, mirroring the worker's layout contract.
describe("tenant-rooted R2Deps", () => {
  const keyRoot = "u/usr_550e8400-e29b-41d4-a716-446655440000/";
  const extracted = "readings/2026/06/18T000000Z-rd_a/extracted.md";
  const revision = "readings/2026/06/18T000000Z-rd_a/revisions/att_1/extracted.md";

  function capture(): { calls: string[][]; run: Runner } {
    const calls: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      calls.push(args.map(String));
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  it("prefixes reads and deletes with the key root", async () => {
    const { calls, run } = capture();
    const deps = { bucket: "b", remote: true, keyRoot, run };
    await readObject(extracted, deps);
    await deleteObject(revision, deps);
    expect(calls[0]![3]).toBe(`b/${keyRoot}${extracted}`);
    expect(calls[1]![3]).toBe(`b/${keyRoot}${revision}`);
  });

  it("keeps the global layout when the key root is empty", async () => {
    const { calls, run } = capture();
    await readObject(extracted, { bucket: "b", remote: true, keyRoot: "", run });
    expect(calls[0]![3]).toBe(`b/${extracted}`);
  });
});

describe("defaultRunner", () => {
  it("decodes UTF-8 that straddles stdout chunk boundaries (em dash split across writes)", async () => {
    const { defaultRunner } = await import("../../../scripts/corpus-lib/wrangler-r2");
    // Emit "Code — Debate" with the 3-byte em dash split across two writes.
    const script =
      'process.stdout.write(Buffer.from([0x43,0x6f,0x64,0x65,0x20,0xe2,0x80]));' +
      'setTimeout(() => { process.stdout.write(Buffer.from([0x94,0x20,0x44,0x65,0x62,0x61,0x74,0x65])); }, 30);';
    const { code, stdout } = await defaultRunner(process.execPath, ["-e", script]);
    expect(code).toBe(0);
    expect(stdout).toBe("Code — Debate");
    expect(stdout).not.toContain("�");
  });
});
