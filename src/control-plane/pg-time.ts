// The one place control-plane time crosses the PostgreSQL boundary (ADR 0005).
// The TypeScript domain is epoch milliseconds throughout; the columns are
// timestamptz. Parameters go in as a Date and rows come back through the
// seam's ISO-8601 parser (src/modules/db/sql.ts), so both directions keep the
// millisecond. Never convert ad hoc in a query module.

export function toTimestamp(ms: number): Date;
export function toTimestamp(ms: number | null | undefined): Date | null;
export function toTimestamp(ms: number | null | undefined): Date | null {
  if (ms === null || ms === undefined) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not an epoch-millisecond timestamp: ${ms}`);
  return date;
}

export function fromTimestamp(iso: string): number;
export function fromTimestamp(iso: string | null | undefined): number | null;
export function fromTimestamp(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Not a timestamp: ${iso}`);
  return ms;
}
