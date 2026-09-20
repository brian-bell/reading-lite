import type { Env as WorkerEnv } from "../src/index";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface ProvidedEnv extends WorkerEnv {}
}
