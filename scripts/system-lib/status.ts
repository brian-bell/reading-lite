import { fileURLToPath } from "node:url";
import {
  SpendStatusSchema,
  type SpendStatus,
} from "../../src/control-plane/spend-status";
import type { PolicyEnvironment } from "./policy";

// Wrangler authenticates the service binding with the operator's Cloudflare
// credentials. Use a separate config so no R2/DO/D1 local stand-in can yield
// a convincing but false zero. No application deployment or policy/ledger
// write occurs; Wrangler manages the temporary remote proxy session.
export async function remoteSpendStatus(
  env: PolicyEnvironment,
  tenant?: string,
  details = false,
): Promise<SpendStatus> {
  try {
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy<{ STATUS: Fetcher }>({
      configPath: fileURLToPath(
        new URL("./wrangler-status.toml", import.meta.url),
      ),
      environment: env,
      persist: false,
      remoteBindings: true,
    });
    try {
      const response = await proxy.env.STATUS.fetch(
        `https://operator/status${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}${details ? `${tenant ? "&" : "?"}details=1` : ""}`,
      );
      if (!response.ok) throw new Error("unavailable");
      const status = SpendStatusSchema.parse(await response.json());
      if (
        (details && (!status.details || (tenant !== undefined && !status.tenantDetails))) ||
        status.tenantId !== tenant ||
        (tenant !== undefined && status.tenantChargedMicrodollars === undefined)
      )
        throw new Error("tenant mismatch");
      return status;
    } finally {
      await proxy.dispose();
    }
  } catch {
    throw new Error(
      "Accounting unavailable: verify Cloudflare credentials and deployment of OperatorStatus",
    );
  }
}
