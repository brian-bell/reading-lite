import { fileURLToPath } from "node:url";
import type { SpendRpc } from "../../src/control-plane/paid-dispatch";
import type { PolicyEnvironment } from "./policy";

// reading-lite-gh319.1: the operator's route to the central spend authority.
// Wrangler authenticates the OperatorSpend service binding with the operator's
// Cloudflare credentials, as status.ts does for OperatorStatus. One proxy per
// command run, disposed at the end.
//
// Nothing here throws. A proxy that cannot be built, a non-200, or an answer
// that is not a decision all become {ok:false}, which createPaidFetch turns
// into a refused dispatch: no authority means no permission to spend.

export interface OperatorSpendSession {
  rpc: SpendRpc;
  dispose: () => Promise<void>;
}

export type OpenOperatorSpend = (env: PolicyEnvironment) => Promise<OperatorSpendSession>;

const UNAVAILABLE = { ok: false, reason: "unavailable" } as const;

export function spendRpcOver(binding: Pick<Fetcher, "fetch">): SpendRpc {
  return async (body) => {
    try {
      const response = await binding.fetch("https://operator/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return UNAVAILABLE;
      const value: unknown = await response.json();
      if (value && typeof value === "object" && "ok" in value && typeof value.ok === "boolean") {
        return value as Awaited<ReturnType<SpendRpc>>;
      }
    } catch { /* No successful response means no permission. */ }
    return UNAVAILABLE;
  };
}

export const openRemoteOperatorSpend: OpenOperatorSpend = async (env) => {
  try {
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy<{ SPEND: Fetcher }>({
      configPath: fileURLToPath(new URL("./wrangler-spend.toml", import.meta.url)),
      environment: env,
      persist: false,
      remoteBindings: true,
    });
    return { rpc: spendRpcOver(proxy.env.SPEND), dispose: () => proxy.dispose() };
  } catch {
    // Said once, here: every refusal that follows reads only "unavailable".
    console.error(
      "Spend authority unavailable: verify Cloudflare credentials and deployment of OperatorSpend",
    );
    return { rpc: async () => UNAVAILABLE, dispose: async () => {} };
  }
};
