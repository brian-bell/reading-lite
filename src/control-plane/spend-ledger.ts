// The spend ledger is deliberately a Durable Object-local book.  A reservation
// charges its maximum bound to the UTC day in which it was made; dispatch turns
// that hold into an irreversible authorization, and settlement replaces the
// bound with actual provider usage. Operation records expire one day after the
// admission day ends; daily aggregates keep uncertain charges. The authority
// rejects old admission days, so discarded operations cannot authorize replay.
// Each operation records who pays for it (ADR 0004); both payers share the
// tenant and global counters, so the payer labels spend without splitting caps.

export type SpendQuote = {
  /** UTC YYYY-MM-DD, selected before the first reserve and immutable thereafter. */
  dayKey: string;
  catalogVersion: number;
  requestFingerprint: string;
  maxMicrodollars: number;
};

/** `tenant` when the tenant's own provider key is billed; `operator` for deployment keys and operator tools. */
export type SpendPayer = "tenant" | "operator";

export function isSpendPayer(value: unknown): value is SpendPayer {
  return value === "tenant" || value === "operator";
}

export type SpendBody =
  | { kind: "reserve_spend"; tenantId: string; opId: string; quote: SpendQuote; nowMs: number; payer: SpendPayer }
  | { kind: "mark_spend_dispatched"; tenantId: string; opId: string; quote: SpendQuote }
  | { kind: "release_spend"; tenantId: string; opId: string; quote: SpendQuote }
  | { kind: "settle_spend"; tenantId: string; opId: string; quote: SpendQuote; actualMicrodollars: number };

export type SpendDenyReason =
  | "daily_spend"
  | "catalog_version"
  | "missing_limits"
  | "deleted_tenant"
  | "operation_conflict"
  | "operation_state"
  | "actual_exceeds_max"
  | "unavailable"
  | "paid_work_disabled";

export type SpendDecision =
  | { ok: true; state: "reserved" | "dispatched" | "settled" | "released"; fresh?: boolean }
  | { ok: false; reason: SpendDenyReason; resetAtMs?: number };

export type SpendRecord = {
  tenantId?: string;
  /** Absent only on records written before the payer was recorded. */
  payer?: SpendPayer;
  quote: SpendQuote;
  policyVersion: number;
  state: "reserved" | "dispatched" | "settled" | "released";
  actualMicrodollars?: number;
  expiresAtMs?: number;
};

type SpendCounter = { microdollars: number };
type LedgerStorage = Pick<DurableObjectStorage, "get" | "put">;
const EXPIRY_SWEEP_LIMIT = 128;
const DAY_MS = 86_400_000;
function retainUntil(quote: SpendQuote): number {
  return Date.parse(`${quote.dayKey}T00:00:00Z`) + 2 * DAY_MS;
}

export function utcSpendDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function utcSpendDayResetAt(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function validSpendQuote(value: unknown): value is SpendQuote {
  if (!value || typeof value !== "object") return false;
  const quote = value as Record<string, unknown>;
  return (
    typeof quote.dayKey === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(quote.dayKey) &&
    Number.isFinite(Date.parse(`${quote.dayKey}T00:00:00Z`)) &&
    Number.isSafeInteger(quote.catalogVersion) &&
    Number(quote.catalogVersion) >= 0 &&
    typeof quote.requestFingerprint === "string" &&
    quote.requestFingerprint.length > 0 &&
    quote.requestFingerprint.length <= 512 &&
    Number.isSafeInteger(quote.maxMicrodollars) &&
    Number(quote.maxMicrodollars) >= 0
  );
}

export function sameSpendQuote(a: SpendQuote, b: SpendQuote): boolean {
  return (
    a.dayKey === b.dayKey &&
    a.catalogVersion === b.catalogVersion &&
    a.requestFingerprint === b.requestFingerprint &&
    a.maxMicrodollars === b.maxMicrodollars
  );
}

function counterKey(dayKey: string): string {
  return `spend:day:${dayKey}`;
}
function tenantCounterKey(tenantId: string, dayKey: string): string { return `spend:tenant:${tenantId}:day:${dayKey}`; }

function expiryKey(expiresAtMs: number, opKey: string): string {
  return `spend:expiry:${String(expiresAtMs).padStart(16, "0")}:${opKey}`;
}

async function counterOf(storage: LedgerStorage, key: string): Promise<number | null> {
  const current = (await storage.get(key)) as SpendCounter | undefined;
  if (current === undefined) return 0;
  return Number.isSafeInteger(current.microdollars) && current.microdollars >= 0 ? current.microdollars : null;
}

/**
 * Reserve both budgets atomically. `opKey` includes the tenant and operation id. Calls run
 * under the guard's serialized critical section. A single multi-key `put`
 * writes the record and its day counter together, avoiding the deprecated
 * asynchronous transaction API and retaining atomic ledger/counter updates.
 */
export async function reserveSpend(
  storage: DurableObjectStorage,
  args: { opKey: string; quote: SpendQuote; payer: SpendPayer; policyVersion: number; limitMicrodollars: number; tenantId?: string; tenantLimitMicrodollars?: number; expiresAtMs?: number },
): Promise<SpendDecision> {
  const existing = (await storage.get(args.opKey)) as SpendRecord | undefined;
  if (existing) {
    if (!validRecord(existing) || !sameSpendQuote(existing.quote, args.quote) || existing.payer !== args.payer) {
      return { ok: false, reason: "operation_conflict" };
    }
    if (existing.state === "released") return { ok: false, reason: "operation_conflict" };
    return { ok: true, state: existing.state };
  }
  const charged = await counterOf(storage, counterKey(args.quote.dayKey));
  if (charged === null) return { ok: false, reason: "unavailable" };
  if (!Number.isSafeInteger(charged + args.quote.maxMicrodollars)) return { ok: false, reason: "unavailable" };
  if (charged + args.quote.maxMicrodollars > args.limitMicrodollars) {
    return { ok: false, reason: "daily_spend", resetAtMs: utcSpendDayResetAt(Date.parse(`${args.quote.dayKey}T00:00:00.000Z`)) };
  }
  let tenantCharged: number | undefined;
  if (args.tenantId && args.tenantLimitMicrodollars != null) {
    const loadedTenantCharged = await counterOf(storage, tenantCounterKey(args.tenantId, args.quote.dayKey));
    if (loadedTenantCharged === null || !Number.isSafeInteger(loadedTenantCharged + args.quote.maxMicrodollars)) return { ok: false, reason: "unavailable" };
    tenantCharged = loadedTenantCharged;
    if (tenantCharged + args.quote.maxMicrodollars > args.tenantLimitMicrodollars) return { ok: false, reason: "daily_spend", resetAtMs: utcSpendDayResetAt(Date.parse(`${args.quote.dayKey}T00:00:00.000Z`)) };
  }
  await putTogether(
    storage,
    args.opKey,
    { tenantId: args.tenantId, payer: args.payer, quote: args.quote, policyVersion: args.policyVersion, state: "reserved", expiresAtMs: args.expiresAtMs ?? Number.MAX_SAFE_INTEGER } satisfies SpendRecord,
    args.quote.dayKey,
    charged + args.quote.maxMicrodollars,
    args.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
    args.tenantId,
    tenantCharged === undefined ? undefined : tenantCharged + args.quote.maxMicrodollars,
  );
  return { ok: true, state: "reserved" };
}

export async function markSpendDispatched(
  storage: DurableObjectStorage,
  args: { opKey: string; quote: SpendQuote; nowMs?: number; limits: { globalMicrodollars: number; tenantMicrodollars: number } },
): Promise<SpendDecision> {
  const existing = (await storage.get(args.opKey)) as SpendRecord | undefined;
  if (!existing || !validRecord(existing)) return { ok: false, reason: "operation_state" };
  if (!sameSpendQuote(existing.quote, args.quote)) return { ok: false, reason: "operation_conflict" };
  if (existing.state === "reserved") {
    const nowMs = args.nowMs ?? Date.now();
    const expiresAtMs = existing.expiresAtMs;
    if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || nowMs >= expiresAtMs) {
      const expired = await expireReservedSpend(storage, args.opKey, existing);
      return expired ? { ok: false, reason: "operation_state" } : { ok: false, reason: "unavailable" };
    }
    // The counters already include this hold. Compare the original admission
    // day's totals to current policy without charging the reservation again.
    // Check only reserved work: a replay cannot undo an incurred charge.
    if (!existing.tenantId) return {ok:false, reason:"unavailable"};
    const global = await counterOf(storage, counterKey(existing.quote.dayKey));
    const tenant = await counterOf(storage, tenantCounterKey(existing.tenantId, existing.quote.dayKey));
    if (global === null || tenant === null || global < existing.quote.maxMicrodollars || tenant < existing.quote.maxMicrodollars) {
      return {ok:false, reason:"unavailable"};
    }
    if (global > args.limits.globalMicrodollars || tenant > args.limits.tenantMicrodollars) {
      return {ok:false, reason:"daily_spend", resetAtMs: utcSpendDayResetAt(Date.parse(`${existing.quote.dayKey}T00:00:00Z`))};
    }
    await storage.put(args.opKey, { ...existing, state: "dispatched" } satisfies SpendRecord);
    await storage.delete(expiryKey(expiresAtMs, args.opKey));
    return { ok: true, state: "dispatched", fresh: true };
  }
  if (existing.state === "released") return { ok: false, reason: "operation_state" };
  return { ok: true, state: existing.state, fresh: false };
}

/** Bounded expiry of unused holds and old operation records; never refunds dispatched work. */
export async function sweepExpiredSpend(storage: DurableObjectStorage, nowMs: number): Promise<number | null> {
  const entries = await storage.list({ prefix: "spend:expiry:", limit: EXPIRY_SWEEP_LIMIT });
  for (const [opKey, value] of entries) {
    const indexKey = opKey;
    // Keep the ownership check even though the native prefix query enforces
    // it: lightweight test stores may return a broader map.
    if (!indexKey.startsWith("spend:expiry:")) continue;
    const targetOpKey = typeof value === "string" ? value : "";
    const record = targetOpKey ? ((await storage.get(targetOpKey)) as SpendRecord | undefined) : undefined;
    if (!record || !validRecord(record)) {
      await storage.delete(indexKey);
      continue;
    }
    const timestamp = Number(indexKey.slice("spend:expiry:".length, "spend:expiry:".length + 16));
    if (timestamp > nowMs) continue;
    if (record.state === "reserved" && (nowMs >= (record.expiresAtMs ?? Infinity) || nowMs >= retainUntil(record.quote))) {
      if (!(await expireReservedSpend(storage, targetOpKey, record))) continue;
    }
    if (nowMs >= retainUntil(record.quote)) await storage.delete(targetOpKey);
    await storage.delete(indexKey);
  }
  const remaining = await storage.list({ prefix: "spend:expiry:", limit: 1 });
  const first = remaining.keys().next().value as string | undefined;
  if (!first) return null;
  const timestamp = Number(first.slice("spend:expiry:".length, "spend:expiry:".length + 16));
  return Number.isSafeInteger(timestamp) ? (timestamp <= nowMs ? nowMs + 1000 : timestamp) : nowMs + 1000;
}

/** Global teardown refunds only work that was never authorized to dispatch. */
export async function purgeGlobalTenantSpend(storage: DurableObjectStorage, tenantId: string): Promise<number> {
  let purged = 0;
  for (;;) {
    const entries = await storage.list({ prefix: `spend:op:${tenantId}:`, limit: EXPIRY_SWEEP_LIMIT });
    if (entries.size === 0) {
      const counters = await storage.list({prefix: `spend:tenant:${tenantId}:`, limit: EXPIRY_SWEEP_LIMIT});
      if (counters.size === 0) return purged;
      for (const key of counters.keys()) await storage.delete(key);
      continue;
    }
    for (const [opKey, value] of entries) {
      const record = value as SpendRecord;
      if (validRecord(record) && record.state === "reserved") {
        // Release writes the refunded counter and terminal tombstone together.
        // If a crash follows, the retry observes `released` and only deletes it,
        // so this cannot refund twice.
        const result = await releaseSpend(storage, { opKey, quote: record.quote });
        if (!result.ok && result.reason !== "operation_state") throw new Error("spend release failed during purge");
      }
      if (validRecord(record) && typeof record.expiresAtMs === "number") await storage.delete(expiryKey(record.expiresAtMs, opKey));
      if (validRecord(record)) await storage.delete(expiryKey(retainUntil(record.quote), opKey));
      await storage.delete(opKey);
      purged += 1;
    }
  }
}

export async function releaseSpend(
  storage: DurableObjectStorage,
  args: { opKey: string; quote: SpendQuote },
): Promise<SpendDecision> {
  const existing = (await storage.get(args.opKey)) as SpendRecord | undefined;
    // No pre-reservation cancellation protocol: callers release only holds
    // they obtained. A missing record therefore needs no tombstone.
    if (!existing) return { ok: true, state: "released" };
    if (!validRecord(existing) || !sameSpendQuote(existing.quote, args.quote)) {
      return { ok: false, reason: "operation_conflict" };
    }
    if (existing.state !== "reserved") return { ok: true, state: existing.state };
    const charged = await counterOf(storage, counterKey(existing.quote.dayKey));
    if (charged === null || charged < existing.quote.maxMicrodollars) return { ok: false, reason: "unavailable" };
    const tenantCharged = existing.tenantId ? await counterOf(storage, tenantCounterKey(existing.tenantId, existing.quote.dayKey)) : undefined;
    if (tenantCharged === null || (typeof tenantCharged === "number" && tenantCharged < existing.quote.maxMicrodollars)) return { ok: false, reason: "unavailable" };
    await putTogether(storage, args.opKey, { ...existing, state: "released" } satisfies SpendRecord, existing.quote.dayKey, charged - existing.quote.maxMicrodollars, undefined, existing.tenantId, typeof tenantCharged === "number" ? tenantCharged - existing.quote.maxMicrodollars : undefined);
    if (typeof existing.expiresAtMs === "number") await storage.delete(expiryKey(existing.expiresAtMs, args.opKey));
    return { ok: true, state: "released" };
}

export async function settleSpend(
  storage: DurableObjectStorage,
  args: { opKey: string; quote: SpendQuote; actualMicrodollars: number },
): Promise<SpendDecision> {
  const existing = (await storage.get(args.opKey)) as SpendRecord | undefined;
    if (!existing || !validRecord(existing)) return { ok: false, reason: "operation_state" };
    if (!sameSpendQuote(existing.quote, args.quote)) return { ok: false, reason: "operation_conflict" };
    if (!Number.isSafeInteger(args.actualMicrodollars) || args.actualMicrodollars < 0) {
      return { ok: false, reason: "actual_exceeds_max" };
    }
    if (existing.state === "settled") {
      return existing.actualMicrodollars === args.actualMicrodollars
        ? { ok: true, state: "settled" }
        : { ok: false, reason: "operation_conflict" };
    }
    if (existing.state !== "dispatched") return { ok: false, reason: "operation_state" };
    if (args.actualMicrodollars > existing.quote.maxMicrodollars) return { ok: false, reason: "actual_exceeds_max" };
    const charged = await counterOf(storage, counterKey(existing.quote.dayKey));
    if (charged === null || charged < existing.quote.maxMicrodollars) return { ok: false, reason: "unavailable" };
    const tenantCharged = existing.tenantId ? await counterOf(storage, tenantCounterKey(existing.tenantId, existing.quote.dayKey)) : undefined;
    if (tenantCharged === null || (typeof tenantCharged === "number" && tenantCharged < existing.quote.maxMicrodollars)) return { ok: false, reason: "unavailable" };
    await putTogether(storage, args.opKey, { ...existing, state: "settled", actualMicrodollars: args.actualMicrodollars } satisfies SpendRecord, existing.quote.dayKey, charged - existing.quote.maxMicrodollars + args.actualMicrodollars, undefined, existing.tenantId, typeof tenantCharged === "number" ? tenantCharged - existing.quote.maxMicrodollars + args.actualMicrodollars : undefined);
    return { ok: true, state: "settled" };
}

function validRecord(record: SpendRecord): boolean {
  return (
    validSpendQuote(record.quote) &&
    Number.isSafeInteger(record.policyVersion) &&
    record.policyVersion >= 0 &&
    (record.payer === undefined || isSpendPayer(record.payer)) &&
    (record.state === "reserved" || record.state === "dispatched" || record.state === "settled" || record.state === "released") &&
    (record.expiresAtMs === undefined || (Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs > 0)) &&
    (record.actualMicrodollars === undefined ||
      (Number.isSafeInteger(record.actualMicrodollars) && record.actualMicrodollars >= 0))
  );
}

async function expireReservedSpend(storage: DurableObjectStorage, opKey: string, record: SpendRecord): Promise<boolean> {
  const charged = await counterOf(storage, counterKey(record.quote.dayKey));
  if (charged === null || charged < record.quote.maxMicrodollars) return false;
  const tenantCharged = record.tenantId ? await counterOf(storage, tenantCounterKey(record.tenantId, record.quote.dayKey)) : undefined;
  if (tenantCharged === null || (typeof tenantCharged === "number" && tenantCharged < record.quote.maxMicrodollars)) return false;
  await putTogether(storage, opKey, { ...record, state: "released" } satisfies SpendRecord, record.quote.dayKey, charged - record.quote.maxMicrodollars, undefined, record.tenantId, typeof tenantCharged === "number" ? tenantCharged - record.quote.maxMicrodollars : undefined);
  if (typeof record.expiresAtMs === "number") await storage.delete(expiryKey(record.expiresAtMs, opKey));
  return true;
}

async function putTogether(
  storage: LedgerStorage,
  opKey: string,
  record: SpendRecord,
  dayKey: string,
  microdollars: number,
  expiresAtMs?: number,
  tenantId?: string,
  tenantMicrodollars?: number,
): Promise<void> {
  const entries: Record<string, unknown> = {
    [opKey]: record,
    [expiryKey(retainUntil(record.quote), opKey)]: opKey,
    [counterKey(dayKey)]: { microdollars } satisfies SpendCounter,
  };
  if (record.state === "reserved" && typeof expiresAtMs === "number") entries[expiryKey(expiresAtMs, opKey)] = opKey;
  if (tenantId && tenantMicrodollars !== undefined) entries[tenantCounterKey(tenantId, dayKey)] = { microdollars: tenantMicrodollars };
  await storage.put(entries);
}
