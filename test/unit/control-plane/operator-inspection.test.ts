import { describe, expect, it } from 'vitest';
import { inspectLeases, inspectSpend, inspectTenant } from '../../../src/control-plane/operator-inspection';
const now = Date.parse('2026-09-06T01:00:00Z');
function storage(values: Record<string, unknown>) {
    return { get: async (key: string) => values[key], list: async ({ prefix, limit }: {
            prefix: string;
            limit: number;
        }) => new Map(Object.entries(values).filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit)) } as unknown as Pick<DurableObjectStorage, 'get' | 'list'>;
}
describe('read-only operator inspection', () => {
    it('keeps expired in-flight leases occupied without exposing fences', async () => {
        expect(await inspectLeases(storage({ 'lease:a': { fence: 'secret', expiresAt: now - 1, inFlight: true }, 'lease:b': { fence: 'other', expiresAt: now - 1, inFlight: false } }), now)).toEqual({ complete: true, records: [{ key: 'lease:a', expiresAtMs: now - 1, inFlight: true, occupiesSlot: true }, { key: 'lease:b', expiresAtMs: now - 1, inFlight: false, occupiesSlot: false }] });
    });
    it('reports retained unsettled operations across midnight without refunding expired holds', async () => {
        const base = { tenantId: 'usr_one', policyVersion: 1, quote: { dayKey: '2026-09-05', catalogVersion: 1, requestFingerprint: 'private', maxMicrodollars: 90 } };
        const result = await inspectSpend(storage({ 'spend:op:usr_one:a': { ...base, state: 'reserved', expiresAtMs: now - 1 }, 'spend:op:usr_one:b': { ...base, state: 'dispatched' }, 'spend:op:usr_one:c': { ...base, state: 'settled', actualMicrodollars: 12 } }));
        expect(result.complete).toBe(true);
        expect(result.records.map(r => [r.state, r.chargedMicrodollars])).toEqual([['reserved', 90], ['dispatched', 90], ['settled', 12]]);
        expect(JSON.stringify(result)).not.toContain('private');
    });
    it('marks a bounded scan incomplete rather than claiming zero outstanding work', async () => {
        const data = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => ['lease:' + i, { fence: 'x', expiresAt: now + 1, inFlight: false }]));
        const r = await inspectLeases(storage(data), now);
        expect(r.complete).toBe(false);
        expect(r.records).toHaveLength(1000);
    });
    it('shows admission counters conservatively, including expired unswept reading holds', async () => {
        const limits = { policy_version: 5, submissions_per_hour: 20, monthly_readings: 200, max_concurrent_work: 2 };
        const r = await inspectTenant(storage({ 'h:2026-09-06T01': { count: 3 }, 'm:2026-09': { count: 198 }, req: { start: now - 3600001, count: 20 }, 'op:x': { status: 'held', hourKey: '2026-09-06T00', monthKey: '2026-09', expiresAt: now - 1 } }), now, limits);
        expect(r.hourly.remaining).toBe(17);
        expect(r.monthly.remaining).toBe(2);
        expect(r.requests.remaining).toBe(20);
        expect(r.reservations.records[0].expired).toBe(true);
    });
    it('fails closed on malformed counters, spend, and leases', async () => {
        await expect(inspectTenant(storage({ 'm:2026-09': { count: -1 } }), now, { policy_version: 1, submissions_per_hour: 20, monthly_readings: 200, max_concurrent_work: 2 })).rejects.toThrow();
        await expect(inspectSpend(storage({ 'spend:op:x': { state: 'reserved' } }))).rejects.toThrow();
        await expect(inspectLeases(storage({ 'lease:x': { expiresAt: now } }), now)).rejects.toThrow();
    });
});
