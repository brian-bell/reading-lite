import { applyD1Migrations, env } from "cloudflare:test";
import { bootstrapFounder } from "../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../src/control-plane/crypto";
import { fromD1 } from "../src/control-plane/db";

await applyD1Migrations(env.CONTROL_PLANE, env.TEST_MIGRATIONS);
await bootstrapFounder(fromD1(env.CONTROL_PLANE), {
  email: env.FOUNDER_EMAIL ?? "founder@test.example",
  legacyToken: env.READER_API_TOKEN,
  signupMode: "open",
  nowMs: Date.now(),
  authRoot: {
    secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET),
    version: 1,
  },
});
