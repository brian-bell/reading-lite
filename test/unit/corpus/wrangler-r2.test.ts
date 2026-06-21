import { describe, expect, it } from "vitest";
import { keysForReading, type Runner } from "../../../scripts/corpus-lib/wrangler-r2";

// A Runner that answers the one `r2 object get` keysForReading makes (the
// manifest read) with the given JSON, and errors on anything else.
const manifestRunner = (manifest: unknown): Runner => async (_cmd, args) => {
  const isManifestGet = args[0] === "r2" && args[1] === "object" && args[2] === "get"
    && String(args[3]).endsWith("/manifest.json");
  return isManifestGet
    ? { code: 0, stdout: JSON.stringify(manifest), stderr: "" }
    : { code: 1, stdout: "", stderr: "unexpected" };
};

describe("keysForReading", () => {
  const id = "rd_a";
  const prefix = "readings/2026/06/18T000000Z-rd_a";
  const deps = (manifest: unknown) => ({ bucket: "b", remote: true, run: manifestRunner(manifest) });

  it("covers the manifest, content, by-id pointer and common raw extensions", async () => {
    const keys = await keysForReading(id, prefix, deps({}));
    expect(keys).toContain(`${prefix}/manifest.json`);
    expect(keys).toContain(`${prefix}/extracted.md`);
    expect(keys).toContain(`index/by-id/${id}`);
    expect(keys).toContain(`${prefix}/raw.html`);
    expect(keys).toContain(`${prefix}/raw.pdf`);
  });

  it("deletes the manifest-referenced attempt files (active + last)", async () => {
    const keys = await keysForReading(id, prefix, deps({
      active_attempt: { id: "at_ACTIVE" },
      last_attempt: { id: "at_LAST" },
    }));
    expect(keys).toContain(`${prefix}/attempts/at_ACTIVE.json`);
    expect(keys).toContain(`${prefix}/attempts/at_LAST.json`);
  });

  it("deletes the by-url pointer when the manifest records a url hash", async () => {
    const keys = await keysForReading(id, prefix, deps({ url_hash: "a".repeat(64) }));
    expect(keys).toContain(`index/by-url/${"a".repeat(64)}`);
  });

  it("tolerates a missing/unreadable manifest (still returns the static keys)", async () => {
    const failRunner: Runner = async () => ({ code: 1, stdout: "", stderr: "not found" });
    const keys = await keysForReading(id, prefix, { bucket: "b", remote: true, run: failRunner });
    expect(keys).toContain(`${prefix}/manifest.json`);
    expect(keys).toContain(`index/by-id/${id}`);
  });
});
