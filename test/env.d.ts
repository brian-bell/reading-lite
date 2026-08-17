import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env as WorkerEnv } from "../src/index";

type Env = WorkerEnv & {
  TEST_MIGRATIONS: D1Migration[];
};

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface ProvidedEnv extends Env {}
}
