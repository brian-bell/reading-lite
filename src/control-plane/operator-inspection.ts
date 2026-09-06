// Private operator diagnostics only. Reads never run cleanup, renew leases,
// refund holds, or alter admission counters. Bounded scans explicitly say when
// incomplete; absent detail on an older Worker is not an empty/healthy result.
import { z } from 'zod';
const Amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Positive = Amount.refine(n => n > 0);
const Page = <T extends z.ZodType>(record: T) => z.object({ complete: z.boolean(), records: z.array(record) });
export const LeaseInspectionSchema = Page(z.object({ key: z.string(), expiresAtMs: Amount, inFlight: z.boolean(), occupiesSlot: z.boolean() }));
export const SpendInspectionSchema = Page(z.object({ key: z.string(), tenantId: z.string(), dayKey: z.string(), state: z.enum(['reserved', 'dispatched', 'settled', 'released']), maxMicrodollars: Amount, chargedMicrodollars: Amount, expiresAtMs: Amount.optional() }));
const Headroom = z.object({ count: Amount, limit: Positive, remaining: Amount, resetAtMs: Amount });
export const TenantInspectionSchema = z.object({ observedAtMs: Amount, policyVersion: Positive, requests: Headroom, hourly: Headroom, monthly: Headroom, maxConcurrentWork: Positive, reservations: Page(z.object({ key: z.string(), status: z.enum(['held', 'consumed', 'released']), hourKey: z.string(), monthKey: z.string(), expiresAtMs: Amount, expired: z.boolean() })), leases: LeaseInspectionSchema });
export const OperatorDetailsSchema = z.object({ observedAtMs: Amount, spend: SpendInspectionSchema, leases: LeaseInspectionSchema });
type Storage = Pick<DurableObjectStorage, 'get' | 'list'>;
const LIMIT = 1000;
async function page(storage: Pick<Storage, 'list'>, prefix: string) {
    const entries = [...await storage.list({ prefix, limit: LIMIT })];
    return { complete: entries.length < LIMIT, entries: entries.slice(0, LIMIT) };
}
export async function inspectLeases(storage: Pick<Storage, 'list'>, now: number) {
    const rows = await page(storage, 'lease:');
    const schema = z.object({ fence: z.string().min(1), expiresAt: Amount, inFlight: z.boolean().optional() });
    return { complete: rows.complete, records: rows.entries.map(([key, value]) => {
            const r = schema.parse(value);
            const inFlight = r.inFlight === true;
            return { key, expiresAtMs: r.expiresAt, inFlight, occupiesSlot: inFlight || r.expiresAt > now };
        }) };
}
export async function inspectSpend(storage: Pick<Storage, 'list'>) {
    const rows = await page(storage, 'spend:op:');
    const schema = z.object({ tenantId: z.string().min(1), policyVersion: Positive, state: z.enum(['reserved', 'dispatched', 'settled', 'released']), quote: z.object({ dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), maxMicrodollars: Amount, catalogVersion: Amount, requestFingerprint: z.string().min(1) }), actualMicrodollars: Amount.optional(), expiresAtMs: Amount.optional() });
    return { complete: rows.complete, records: rows.entries.map(([key, value]) => {
            const r = schema.parse(value);
            if (r.state === 'settled' && (r.actualMicrodollars === undefined || r.actualMicrodollars > r.quote.maxMicrodollars))
                throw Error('Invalid settled spend');
            return { key, tenantId: r.tenantId, dayKey: r.quote.dayKey, state: r.state, maxMicrodollars: r.quote.maxMicrodollars, chargedMicrodollars: r.state === 'released' ? 0 : r.state === 'settled' ? r.actualMicrodollars! : r.quote.maxMicrodollars, ...(r.expiresAtMs === undefined ? {} : { expiresAtMs: r.expiresAtMs }) };
        }) };
}
export async function inspectGlobal(storage: Pick<Storage, 'list'>, now: number) {
    return { observedAtMs: now, spend: await inspectSpend(storage), leases: await inspectLeases(storage, now) };
}
export async function inspectTenant(storage: Storage, now: number, rawLimits: unknown) {
    const limits = z.object({ policy_version: Positive, submissions_per_hour: Positive, monthly_readings: Positive, max_concurrent_work: Positive }).parse(rawLimits);
    const iso = new Date(now).toISOString();
    const d = new Date(now);
    async function counter(key: string) { const r = await storage.get(key); return r === undefined ? 0 : z.object({ count: Amount }).parse(r).count; }
    const head = (count: number, limit: number, resetAtMs: number) => ({ count, limit, remaining: Math.max(0, limit - count), resetAtMs });
    const rawReq = await storage.get('req');
    const req = rawReq === undefined ? undefined : z.object({ start: Amount, count: Amount }).parse(rawReq);
    const reqActive = req !== undefined && now < req.start + 3600000;
    const rows = await page(storage, 'op:');
    const reservation = z.object({ status: z.enum(['held', 'consumed', 'released']), hourKey: z.string(), monthKey: z.string(), expiresAt: Amount });
    return { observedAtMs: now, policyVersion: limits.policy_version,
        requests: head(reqActive ? req.count : 0, limits.submissions_per_hour, reqActive ? req.start + 3600000 : now + 3600000),
        hourly: head(await counter('h:' + iso.slice(0, 13)), limits.submissions_per_hour, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)),
        monthly: head(await counter('m:' + iso.slice(0, 7)), limits.monthly_readings, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
        maxConcurrentWork: limits.max_concurrent_work,
        reservations: { complete: rows.complete, records: rows.entries.map(([key, value]) => { const r = reservation.parse(value); return { key, status: r.status, hourKey: r.hourKey, monthKey: r.monthKey, expiresAtMs: r.expiresAt, expired: r.status === 'held' && r.expiresAt <= now }; }) },
        leases: await inspectLeases(storage, now) };
}
