// Hand-rolled ZIP32 writer (reading-lite-mxwx). A segment is local-file
// headers plus their bytes; its central-directory fragment records absolute
// offsets, so download can concatenate segments, then fragments, then one
// end-of-central-directory record. No ZIP64: past 65535 entries or 4 GiB the
// writer refuses instead of emitting a file unzip cannot read.
//
// Deflate is CompressionStream("deflate-raw"), which is the raw DEFLATE ZIP
// method 8 stores. Types that are already compressed are stored.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const STORED_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "mp3",
  "mp4",
  "m4a",
  "webm",
  "ogg",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "woff",
  "woff2",
  "pdf",
]);

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipSegment {
  local: Uint8Array;
  central: Uint8Array;
  entries: number;
}

export interface ZipSegmentOptions {
  /** Absolute offset of this segment's first local header in the finished zip. */
  offset: number;
  modifiedAt: Date;
}

const CRC_TABLE = makeCrcTable();

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertUint32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new ZipLimitError(`${what} exceeds the ZIP32 limit`);
  }
}

function assertUint16(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
    throw new ZipLimitError(`${what} exceeds the ZIP32 limit`);
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function encodeName(name: string): Uint8Array {
  if (name.length === 0 || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw new Error(`invalid zip entry name: ${name}`);
  }
  const bytes = new TextEncoder().encode(name);
  assertUint16(bytes.byteLength, "entry name");
  return bytes;
}

function storedExtension(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return STORED_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function dosStamp(date: Date): { time: number; date: number } {
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) throw new ZipLimitError("zip timestamp is outside the DOS range");
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function localHeader(input: {
  name: Uint8Array;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  time: number;
  date: number;
}): Uint8Array {
  return concat([
    u32(LOCAL_SIGNATURE),
    u16(ZIP_VERSION),
    u16(UTF8_FLAG),
    u16(input.method),
    u16(input.time),
    u16(input.date),
    u32(input.crc),
    u32(input.compressed),
    u32(input.uncompressed),
    u16(input.name.byteLength),
    u16(0),
    input.name,
  ]);
}

function centralHeader(input: {
  name: Uint8Array;
  method: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  time: number;
  date: number;
  offset: number;
}): Uint8Array {
  return concat([
    u32(CENTRAL_SIGNATURE),
    u16(ZIP_VERSION),
    u16(ZIP_VERSION),
    u16(UTF8_FLAG),
    u16(input.method),
    u16(input.time),
    u16(input.date),
    u32(input.crc),
    u32(input.compressed),
    u32(input.uncompressed),
    u16(input.name.byteLength),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(input.offset),
    input.name,
  ]);
}

export async function writeZipSegment(entries: readonly ZipEntry[], options: ZipSegmentOptions): Promise<ZipSegment> {
  assertUint32(options.offset, "segment offset");
  assertUint16(entries.length, "segment entries");
  const stamp = dosStamp(options.modifiedAt);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let cursor = options.offset;
  for (const entry of entries) {
    const name = encodeName(entry.name);
    const method = storedExtension(entry.name) ? METHOD_STORE : METHOD_DEFLATE;
    const payload = method === METHOD_STORE ? entry.data : await deflateRaw(entry.data);
    const crc = crc32(entry.data);
    assertUint32(payload.byteLength, "compressed size");
    assertUint32(entry.data.byteLength, "uncompressed size");
    assertUint32(cursor, "local header offset");
    const header = localHeader({
      name,
      method,
      crc,
      compressed: payload.byteLength,
      uncompressed: entry.data.byteLength,
      time: stamp.time,
      date: stamp.date,
    });
    locals.push(header, payload);
    centrals.push(
      centralHeader({
        name,
        method,
        crc,
        compressed: payload.byteLength,
        uncompressed: entry.data.byteLength,
        time: stamp.time,
        date: stamp.date,
        offset: cursor,
      }),
    );
    const next = cursor + header.byteLength + payload.byteLength;
    assertUint32(next, "segment end");
    cursor = next;
  }
  return { local: concat(locals), central: concat(centrals), entries: entries.length };
}

export function writeZipEocd(input: { entries: number; centralBytes: number; centralOffset: number }): Uint8Array {
  assertUint16(input.entries, "central directory entries");
  assertUint32(input.centralBytes, "central directory size");
  assertUint32(input.centralOffset, "central directory offset");
  return concat([
    u32(EOCD_SIGNATURE),
    u16(0),
    u16(0),
    u16(input.entries),
    u16(input.entries),
    u32(input.centralBytes),
    u32(input.centralOffset),
    u16(0),
  ]);
}
