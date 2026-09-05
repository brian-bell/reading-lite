/** Inventory reads fail closed: a malformed page is never an empty/end page.
 * XML accepts the S3 listing dialect only (no DTDs or external entities).
 * Keep parsing separate from request/retry policy and validate before returning
 * any objects to callers that use a complete inventory to authorize repair.
 */
import { z } from "zod";

const text = z.string().min(1);
const size = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const timestamp = z.string().refine((value) => value.trim() !== "" && Number.isFinite(Date.parse(value)));
const object = z.object({
  key: text,
  size,
  etag: text.transform((value) => value.replace(/^W\//, "").replaceAll('"', "")).pipe(text),
  lastModified: timestamp.optional(),
});
const restPage = z.object({
  success: z.literal(true),
  result: z.array(z.object({
    key: z.unknown(), size: z.unknown(), etag: z.unknown(),
    uploaded: timestamp.optional(), last_modified: timestamp.optional(),
  }).transform((item) => object.parse({ ...item, lastModified: item.last_modified ?? item.uploaded }))),
  result_info: z.object({ is_truncated: z.boolean(), cursor: z.string().nullish() }),
});
export function parseRestListPage(value: unknown) {
  const page = restPage.parse(value);
  return { objects: page.result, truncated: page.result_info.is_truncated, token: page.result_info.cursor };
}
export function nextListToken(truncated: boolean, token: string | null | undefined, seen: Set<string>) {
  if (!truncated) return undefined;
  if (!token?.trim() || seen.has(token)) throw new Error("R2 LIST invalid/non-advancing continuation token/cursor");
  seen.add(token);
  return token;
}

interface Element { name: string; text: string; children: Element[] }
function malformed(): never { throw new Error("R2 LIST malformed S3 XML page"); }
function decode(value: string): string {
  // Reject unknown/bare entities rather than inventorying a different key.
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) malformed();
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) malformed();
    return String.fromCodePoint(code);
  });
}
function parseXml(xml: string): Element {
  const document: Element = { name: "", text: "", children: [] };
  const stack = [document];
  const source = xml.trim().replace(/^<\?xml\s+[^?]*\?>\s*/, "");
  for (const token of source.match(/<[^>]*>|[^<]+|</g) ?? []) {
    const parent = stack[stack.length - 1]!;
    if (!token.startsWith("<")) {
      parent.text += decode(token);
      continue;
    }
    const end = /^<\/([A-Za-z][\w.-]*)\s*>$/.exec(token);
    if (end) {
      if (stack.length === 1 || parent.name !== end[1]) malformed();
      stack.pop();
      continue;
    }
    // S3 uses unprefixed elements and a default namespace on the root.
    const start = /^<([A-Za-z][\w.-]*)(?:\s+xmlns=(?:"[^"<>]*"|'[^'<>]*'))?\s*(\/?)>$/.exec(token);
    if (!start) malformed();
    const node: Element = { name: start[1]!, text: "", children: [] };
    parent.children.push(node);
    if (!start[2]) stack.push(node);
  }
  if (stack.length !== 1 || document.text.trim() || document.children.length !== 1) malformed();
  return document.children[0]!;
}
function field(node: Element, name: string, required = true): string | undefined {
  const matches = node.children.filter((child) => child.name === name);
  if (!matches.length && !required) return undefined;
  if (matches.length !== 1 || matches[0]!.children.length) malformed();
  return matches[0]!.text;
}
export function parseS3ListPage(xml: string) {
  const root = parseXml(xml);
  if (root.name !== "ListBucketResult" || root.text.trim()) malformed();
  // No delimiter is requested: nested non-object entries (e.g. grouped
  // prefixes) cannot stand in for an object inventory.
  if (root.children.some((node) => node.name !== "Contents" && node.children.length)) malformed();
  const truncated = field(root, "IsTruncated");
  if (truncated !== "true" && truncated !== "false") malformed();
  const objects = root.children.filter((node) => node.name === "Contents").map((node) => {
    if (node.text.trim()) malformed();
    return object.parse({ key: field(node, "Key"), size: field(node, "Size"),
      etag: field(node, "ETag"), lastModified: field(node, "LastModified", false) });
  });
  // Without delimiter grouping, every declared key must have a Contents entry.
  // Older fixtures/providers may omit KeyCount; a supplied count is authoritative.
  const keyCount = field(root, "KeyCount", false);
  if (keyCount !== undefined && size.parse(keyCount) !== objects.length) malformed();
  return { objects, truncated: truncated === "true", token: field(root, "NextContinuationToken", false) };
}
