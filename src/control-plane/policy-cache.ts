// A short-lived, per-Durable-Object cache for the policy rows the usage guards
// read on every RPC (tenant_limits, system_policy's concurrency). Each such
// read is a fresh PostgreSQL client through withControlPlane, and one
// processing attempt makes a dozen guard RPCs, so without this every intake
// request and every lease RPC paid a full connection handshake for a row
// that changes only when an operator runs a command.
//
// What may be cached is deliberately narrow: numeric limits, whose only
// writer is the operator CLI, and whose propagation delay is this TTL. Reads
// that carry the account-deletion fence (`users.status`) or the paid-work
// kill switch stay uncached and are not routed through here. A missing or
// invalid row is never cached, so a tenant provisioned a moment ago is seen
// on the next RPC, and purge_tenant clears the instance's entries.
//
// The TTL comes from GUARD_POLICY_CACHE_MS. Unset, or anything but a positive
// integer, means no caching: the test environment leaves it unset, because
// its fixtures change limits between RPCs on the same guard instance.

export function policyCacheTtlMs(env: { GUARD_POLICY_CACHE_MS?: string }): number {
  const raw = env.GUARD_POLICY_CACHE_MS;
  if (raw === undefined || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

export class PolicyCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  async get<T>(key: string, load: () => Promise<T | null>, now = Date.now()): Promise<T | null> {
    if (this.ttlMs > 0) {
      const hit = this.entries.get(key);
      if (hit && hit.expiresAt > now) return hit.value as T;
    }
    const value = await load();
    if (value !== null && this.ttlMs > 0) this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
