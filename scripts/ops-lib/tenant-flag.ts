// The shared --tenant flag contract for corpus commands (reading-lite-
// s1k.4.3): every command that reads or mutates corpus state must state whose
// corpus it addresses before planning anything. The selector is resolved by
// corpus-lib/tenant.ts; this wrapper maps a missing or malformed selector onto
// the CLI's UsageError (exit 2) so commands fail closed before any R2 or
// PostgreSQL traffic.

import { resolveOperatorTenant, type OperatorTenant } from "../corpus-lib/tenant";
import { UsageError } from "./contract";

export const TENANT_FLAG_HELP =
  "--tenant <selector>  REQUIRED. Whose corpus to address: a tenant id (usr_…) or 'global' for the pre-tenant layout.";

export function requireOperatorTenant(selector: string | undefined): OperatorTenant {
  const out = resolveOperatorTenant(selector);
  if (!out.ok) throw new UsageError(out.reason);
  return out.tenant;
}
