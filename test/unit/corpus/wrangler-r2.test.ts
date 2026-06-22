import { describe, expect, it } from "vitest";
import {
  isObjectNotFound,
  keysForReading,
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
      keysForReading(id, prefix, url, { bucket: "b", remote: true, run }),
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
      keysForReading(id, prefix, url, { bucket: "b", remote: true, run }),
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
