import { describe, expect, it } from "vitest";
import {
  byUrlPointerKeyIfOwned,
  keysForDroppedReading,
} from "../../../scripts/corpus-lib/delete-plan";
import { urlHash } from "../../../scripts/corpus-lib/url-hash";

const url = "https://example.com/post";
const id = "rd_dropped";
const prefix = "readings/2026/06/18T000000Z-rd_dropped";
const pointerKey = `index/by-url/${urlHash(url)}`;

const deps = (opts: { manifest?: unknown; objects?: Record<string, string> }) => ({
  readManifest: async () => opts.manifest ?? null,
  readObject: async (key: string) => opts.objects?.[key] ?? null,
});

describe("byUrlPointerKeyIfOwned", () => {
  it("includes the pointer key when the stored pointer is owned by the dropped id", async () => {
    const read = async () => JSON.stringify({ id, key_prefix: prefix });
    expect(await byUrlPointerKeyIfOwned(id, url, read)).toBe(pointerKey);
  });

  it("excludes the pointer key when it is owned by another (surviving) reading", async () => {
    const read = async () => JSON.stringify({ id: "rd_survivor", key_prefix: "readings/other" });
    expect(await byUrlPointerKeyIfOwned(id, url, read)).toBeNull();
  });

  it("excludes the pointer key when no pointer object is present", async () => {
    const read = async () => null;
    expect(await byUrlPointerKeyIfOwned(id, url, read)).toBeNull();
  });

  it("excludes the pointer key when the pointer object is unparseable", async () => {
    const read = async () => "not json";
    expect(await byUrlPointerKeyIfOwned(id, url, read)).toBeNull();
  });

  it("excludes the pointer key when the stored object has no id field", async () => {
    const read = async () => JSON.stringify({ key_prefix: prefix });
    expect(await byUrlPointerKeyIfOwned(id, url, read)).toBeNull();
  });

  it("excludes the pointer key when the stored id is not a string", async () => {
    const read = async () => JSON.stringify({ id: 123, key_prefix: prefix });
    expect(await byUrlPointerKeyIfOwned(id, url, read)).toBeNull();
  });

  it("propagates a read error rather than treating an unreadable pointer as absent", async () => {
    // A transient/permission read failure must NOT be collapsed into "not owned":
    // doing so would delete the reading and rewrite list.json while a pointer it
    // genuinely owns lingers. The reader signals an untrusted read by throwing;
    // ownership stays undetermined and the drop aborts.
    const read = async () => {
      throw new Error("could not read index/by-url/...: Internal Server Error");
    };
    await expect(byUrlPointerKeyIfOwned(id, url, read)).rejects.toThrow(/could not read/);
  });
});

describe("keysForDroppedReading", () => {
  it("includes index/by-url/{hash} when the dropped reading owns the pointer", async () => {
    const keys = await keysForDroppedReading(
      id,
      prefix,
      url,
      deps({ objects: { [pointerKey]: JSON.stringify({ id, key_prefix: prefix }) } }),
    );
    expect(keys).toContain(pointerKey);
  });

  it("omits the pointer when it is owned by a surviving ready reading", async () => {
    const keys = await keysForDroppedReading(
      id,
      prefix,
      url,
      deps({
        objects: { [pointerKey]: JSON.stringify({ id: "rd_survivor", key_prefix: "readings/y" }) },
      }),
    );
    expect(keys).not.toContain(pointerKey);
  });

  it("omits the pointer when no pointer object exists", async () => {
    const keys = await keysForDroppedReading(id, prefix, url, deps({}));
    expect(keys).not.toContain(pointerKey);
  });

  it("aborts (propagates) when the pointer read cannot be trusted", async () => {
    const failing = {
      readManifest: async () => null,
      readObject: async () => {
        throw new Error("could not read index/by-url/...: 503 Service Unavailable");
      },
    };
    await expect(keysForDroppedReading(id, prefix, url, failing)).rejects.toThrow(/could not read/);
  });

  it("always covers the id-scoped static keys and manifest attempt files", async () => {
    const keys = await keysForDroppedReading(
      id,
      prefix,
      url,
      deps({ manifest: { active_attempt: { id: "at_A" }, last_attempt: { id: "at_B" } } }),
    );
    expect(keys).toContain(`${prefix}/manifest.json`);
    expect(keys).toContain(`${prefix}/extracted.md`);
    expect(keys).toContain(`index/by-id/${id}`);
    expect(keys).toContain(`${prefix}/raw.html`);
    expect(keys).toContain(`${prefix}/attempts/at_A.json`);
    expect(keys).toContain(`${prefix}/attempts/at_B.json`);
  });
});
