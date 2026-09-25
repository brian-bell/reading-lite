// Reads a ZIP32 file the archive writer emits: local bytes, then central
// directory fragments, then one end-of-central-directory record with no comment.
import { expect } from "vitest";
import { crc32 } from "../../src/modules/archive-zip";
import { sha256Bytes } from "../../src/modules/extractor/response-bytes";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.byteLength < EOCD_SIZE) throw new Error("zip is shorter than an end-of-central-directory record");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - EOCD_SIZE;
  if (view.getUint32(eocd, true) !== EOCD_SIGNATURE) throw new Error("missing end-of-central-directory signature");
  const entries = view.getUint16(eocd + 10, true);
  const centralBytes = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset + centralBytes !== eocd) throw new Error("central directory does not end at the eocd");

  const out = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error("bad central-directory signature");
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error(`bad local header for ${name}`);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + compressed);
    const data = method === 0 ? payload : method === 8 ? await inflateRaw(payload) : null;
    if (!data) throw new Error(`unsupported method ${method} for ${name}`);
    if (data.byteLength !== uncompressed) throw new Error(`size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    if (out.has(name)) throw new Error(`duplicate entry ${name}`);
    out.set(name, data);
  }
  if (cursor !== eocd) throw new Error("central directory length mismatch");
  return out;
}

// checksums.sha256 lists every other entry, GNU sha256sum text mode, sorted by path.
export async function expectChecksums(entries: Map<string, Uint8Array>): Promise<void> {
  const text = new TextDecoder().decode(entries.get("checksums.sha256"));
  expect(text.endsWith("\n")).toBe(true);
  const listed = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    expect(match, line).not.toBeNull();
    listed.set(match![2]!, match![1]!);
  }
  const names = [...entries.keys()].filter((name) => name !== "checksums.sha256").sort();
  expect([...listed.keys()].sort()).toEqual(names);
  for (const name of names) {
    expect(listed.get(name)).toBe(await sha256Bytes(entries.get(name)!));
  }
}
