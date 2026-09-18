// Checks a built frontend before deploy (ADR 0003): dist/server/wrangler.json
// must target the named environment, match that environment of wrangler.jsonc
// on the fields that decide where it deploys, and bind only its own backend.
// Run from app/ after `CLOUDFLARE_ENV=<env> npm run build`:
//
//   node scripts/check-build.ts production
//
// Runs directly under Node 22's type stripping.

import { readFileSync } from "node:fs";
import {
  BACKEND_BINDING,
  checkBuiltConfig,
  parseBuiltConfig,
  readEnvironment,
  readEnvironments,
} from "../config/backend-bindings.ts";

const label = process.argv[2];
if (label !== "staging" && label !== "production") {
  console.error("usage: node scripts/check-build.ts staging|production");
  process.exit(2);
}

const built = parseBuiltConfig(readFileSync("dist/server/wrangler.json", "utf8"));
const errors = checkBuiltConfig(label, built, readEnvironment("wrangler.jsonc", label), readEnvironments("../wrangler.toml"));

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
const backend = built.services.find(({ binding }) => binding === BACKEND_BINDING);
console.log(`built ${built.name} for ${label}; ${BACKEND_BINDING} binds ${backend?.service}`);
