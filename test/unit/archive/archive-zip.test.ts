import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZipLimitError, writeZipEocd, writeZipSegment } from "../../../src/modules/archive-zip";
import { readZipEntries } from "../../helpers/read-zip";

const MODIFIED = new Date("2026-08-16T12:00:00.000Z");

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function assemble(
  segments: ReadonlyArray<{ local: Uint8Array; central: Uint8Array; entries: number }>,
): Uint8Array {
  const local = concat(segments.map((segment) => segment.local));
  const central = concat(segments.map((segment) => segment.central));
  const eocd = writeZipEocd({
    entries: segments.reduce((total, segment) => total + segment.entries, 0),
    centralBytes: central.byteLength,
    centralOffset: local.byteLength,
  });
  return concat([local, central, eocd]);
}

function expectUnzipAccepts(bytes: Uint8Array, names: readonly string[]): void {
  const dir = mkdtempSync(join(tmpdir(), "archive-zip-"));
  const path = join(dir, "archive.zip");
  writeFileSync(path, bytes);
  const output = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
  expect(output).toMatch(/No errors detected/);
  for (const name of names) {
    if (/[^\u0000-\u007f]/.test(name)) continue;
    expect(output).toContain(name);
  }
}

describe("writeZipSegment", () => {
  it("round-trips deflated, stored, and empty entries, and unzip -t accepts the file", async () => {
    const photo = Uint8Array.from({ length: 32 }, (_, index) => index);
    const segment = await writeZipSegment(
      [
        { name: "export.json", data: new TextEncoder().encode('{"format_version":1}') },
        { name: "notes/café.txt", data: new TextEncoder().encode("é") },
        { name: "media/photo.PNG", data: photo },
        { name: "notes/empty.txt", data: new Uint8Array() },
      ],
      { offset: 0, modifiedAt: MODIFIED },
    );
    const bytes = assemble([segment]);
    const entries = await readZipEntries(bytes);
    expect(new TextDecoder().decode(entries.get("export.json"))).toBe('{"format_version":1}');
    expect(new TextDecoder().decode(entries.get("notes/café.txt"))).toBe("é");
    expect(entries.get("media/photo.PNG")).toEqual(photo);
    expect(entries.get("notes/empty.txt")).toEqual(new Uint8Array());
    expectUnzipAccepts(bytes, ["export.json", "notes/café.txt", "media/photo.PNG", "notes/empty.txt"]);
  });

  it("records absolute offsets so a later segment still extracts", async () => {
    const first = await writeZipSegment([{ name: "a.txt", data: new TextEncoder().encode("one") }], {
      offset: 0,
      modifiedAt: MODIFIED,
    });
    const second = await writeZipSegment([{ name: "b.txt", data: new TextEncoder().encode("two") }], {
      offset: first.local.byteLength,
      modifiedAt: MODIFIED,
    });
    const bytes = assemble([first, second]);
    const entries = await readZipEntries(bytes);
    expect(new TextDecoder().decode(entries.get("a.txt"))).toBe("one");
    expect(new TextDecoder().decode(entries.get("b.txt"))).toBe("two");
    expectUnzipAccepts(bytes, ["a.txt", "b.txt"]);
  });

  it.each(["", "/abs.txt", "a\\b.txt", "dir/../secret.txt"])("refuses the entry name %j", async (name) => {
    await expect(
      writeZipSegment([{ name, data: new Uint8Array([1]) }], { offset: 0, modifiedAt: MODIFIED }),
    ).rejects.toThrow(/invalid zip entry name/);
  });

  it("refuses a zip that would pass a ZIP32 limit", async () => {
    await expect(
      writeZipSegment([{ name: "a.txt", data: new Uint8Array([1]) }], {
        offset: 0xffffffff,
        modifiedAt: MODIFIED,
      }),
    ).rejects.toBeInstanceOf(ZipLimitError);
    // A later segment counts the entries the earlier ones already hold.
    await expect(
      writeZipSegment([{ name: "a.txt", data: new Uint8Array([1]) }], {
        offset: 0,
        entriesBefore: 65535,
        modifiedAt: MODIFIED,
      }),
    ).rejects.toBeInstanceOf(ZipLimitError);
    expect(() => writeZipEocd({ entries: 65536, centralBytes: 0, centralOffset: 0 })).toThrow(ZipLimitError);
    await expect(
      writeZipSegment([], { offset: 0, modifiedAt: new Date("1970-01-01T00:00:00.000Z") }),
    ).rejects.toBeInstanceOf(ZipLimitError);
  });
});
