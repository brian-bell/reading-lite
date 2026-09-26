import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import { accountRemote } from "../../account-lib/remote";
import { scanResidue, type ScanRemote } from "../../account-lib/residue";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
interface Deps extends BaseDeps {
  connect(bucket: string): ScanRemote;
}
export const accountResidueScanCommand: CommandDefinition<Deps> = {
  group: "account",
  name: "residue-scan",
  summary: "Read tenant deletion residue and explicit visibility limits",
  safety: "read-only",
  helpText: `Usage: npm run ops -- account residue-scan (--tenant <usr_…> | --all-deleted) [--bucket reading-lite-staging]
Defaults to bucket reading-lite. --all-deleted selects every account_deletions
row, including teardown attempts interrupted before users-row deletion.
Prints JSON per tenant, per-source findings and durable first-completion history.
Exit 1 for residue OR incomplete visibility, 0 only for all sources clear/expected,
2 for usage errors. DO/address-history blind spots currently prevent a full clean
certification. Live tenant data counts as present; inspect per-source findings.
Reads PostgreSQL rows and tenant content.
Never repairs or deletes data. --help shows help.`,
  defaultDeps: (io) => ({ io, connect: accountRemote }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          tenant: { type: "string" },
          "all-deleted": { type: "boolean" },
          bucket: { type: "string", default: "reading-lite" },
        },
      }));
    } catch (e) {
      throw new UsageError(String(e));
    }
    if (!!values.tenant === !!values["all-deleted"])
      throw new UsageError("choose exactly one of --tenant or --all-deleted");
    if (values.tenant && !parseTenantId(values.tenant))
      throw new UsageError("invalid tenant");
    const remote = deps.connect(values.bucket!);
    try {
      return await scan(remote, values, deps);
    } finally {
      // ops.ts sets process.exitCode rather than calling process.exit, so an
      // open control-plane socket would keep the event loop alive forever.
      await remote.closeDb?.();
    }
  },
};

async function scan(
  remote: ScanRemote,
  values: { tenant?: string | undefined; bucket?: string | undefined },
  deps: Deps,
): Promise<number> {
  {
    const tenants = values.tenant
      ? [values.tenant]
      : (
          await remote.db.all<{ tenant_id: string }>(
            "SELECT tenant_id FROM account_deletions ORDER BY tenant_id",
          )
        ).map((r) => r.tenant_id);
    let code = 0;
    for (const tenant of tenants) {
      if (!parseTenantId(tenant))
        throw new Error("invalid tenant in audit history");
      const result = await scanResidue(remote, tenant);
      deps.io.stdout(
        JSON.stringify({ bucket: values.bucket, ...result }, null, 2),
      );
      if (result.residue || result.incomplete) code = 1;
    }
    if (!tenants.length)
      deps.io.stdout("No account_deletions rows; no tenants scanned.");
    return code;
  }
}
