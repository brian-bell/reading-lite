#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { bootstrapFounder, signupModeForEnv, type SignupMode } from "../src/control-plane/bootstrap";
import { parseAuthRootKeyVersion, parseAuthRootSecret } from "../src/control-plane/crypto";
import { redactEmail } from "../src/control-plane/email";
import type { ControlPlaneDb, SqlStatement } from "../src/control-plane/db";
import { loadDotVars } from "./lib/dotvars";

export type BootstrapEnvName = "local" | "staging" | "production";

export interface FounderBootstrapCliArgs {
  execute: boolean;
  email?: string;
  env: BootstrapEnvName;
  confirmProduction: boolean;
}

export interface FounderBootstrapRunResult {
  exitCode: number;
}

export interface FounderBootstrapDeps {
  envVars: Record<string, string | undefined>;
  nowMs: number;
  write: (line: string) => void;
  openDb: (env: BootstrapEnvName) => Promise<ControlPlaneDb>;
}

const ENV_NAMES = new Set<BootstrapEnvName>(["local", "staging", "production"]);

const DATABASE_BY_ENV: Record<BootstrapEnvName, string> = {
  local: "reading-lite-control-dev",
  staging: "reading-lite-control-staging",
  production: "reading-lite-control",
};

const DOTVARS_BY_ENV: Record<BootstrapEnvName, string> = {
  local: ".dev.vars",
  staging: ".stg.vars",
  production: ".prd.vars",
};

export function parseFounderBootstrapArgs(
  argv: string[] = process.argv.slice(2),
): FounderBootstrapCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      execute: { type: "boolean", default: false },
      email: { type: "string" },
      env: { type: "string", default: "local" },
      "confirm-production": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    throw new HelpRequested();
  }
  const env = values.env ?? "local";
  if (!ENV_NAMES.has(env as BootstrapEnvName)) {
    throw new Error(`unknown --env ${env} (expected local|staging|production)`);
  }
  return {
    execute: values.execute === true,
    ...(values.email ? { email: values.email } : {}),
    env: env as BootstrapEnvName,
    confirmProduction: values["confirm-production"] === true,
  };
}

export class HelpRequested extends Error {
  constructor() {
    super("help");
  }
}

export async function runFounderBootstrap(
  args: FounderBootstrapCliArgs,
  deps: FounderBootstrapDeps,
): Promise<FounderBootstrapRunResult> {
  if (args.env === "production" && args.execute && !args.confirmProduction) {
    deps.write("refusing production write without --confirm-production\n");
    return { exitCode: 2 };
  }

  const email = args.email ?? deps.envVars.FOUNDER_EMAIL;
  const legacyToken = deps.envVars.READER_API_TOKEN;
  const rootSecret = deps.envVars.AUTH_ROOT_SECRET;
  if (!email) {
    deps.write("missing founder email (pass --email or set FOUNDER_EMAIL)\n");
    return { exitCode: 2 };
  }
  if (!legacyToken) {
    deps.write("missing READER_API_TOKEN\n");
    return { exitCode: 2 };
  }
  if (!rootSecret) {
    deps.write("missing AUTH_ROOT_SECRET\n");
    return { exitCode: 2 };
  }

  const signupMode: SignupMode = signupModeForEnv(args.env);
  const db = await deps.openDb(args.env);
  const previousRootSecret = deps.envVars.AUTH_PREVIOUS_ROOT_SECRET;
  const result = await bootstrapFounder(
    db,
    {
      email,
      legacyToken,
      signupMode,
      nowMs: deps.nowMs,
      authRoot: {
        secret: parseAuthRootSecret(rootSecret),
        version: parseAuthRootKeyVersion(deps.envVars.AUTH_ROOT_KEY_VERSION),
      },
      ...(previousRootSecret
        ? {
            previousAuthRoot: {
              secret: parseAuthRootSecret(previousRootSecret),
              version: parseAuthRootKeyVersion(deps.envVars.AUTH_PREVIOUS_ROOT_KEY_VERSION),
            },
          }
        : {}),
    },
    { apply: args.execute },
  );

  deps.write(`founder email: ${redactEmail(email)}\n`);
  deps.write(`environment:   ${args.env} (signup_mode=${signupMode})\n`);
  deps.write(`user:          ${result.userId} (${result.createdUser ? "create" : "resolve"})\n`);
  deps.write(`legacy token:  ${result.tokenId} (${result.createdToken ? "import" : "resolve"})\n`);
  for (const action of result.actions) {
    deps.write(`  - ${action}\n`);
  }

  if (!args.execute) {
    deps.write("\n[DRY RUN] not writing. Pass --execute to apply.\n");
    return { exitCode: 0 };
  }
  deps.write("\n[EXECUTE] founder principal and imported legacy token are in D1.\n");
  return { exitCode: 0 };
}

export function makeWranglerD1(opts: {
  database: string;
  wranglerEnv?: Exclude<BootstrapEnvName, "local">;
  local: boolean;
  run?: (args: string[]) => Promise<{ stdout: string; code: number; stderr: string }>;
}): ControlPlaneDb {
  const run = opts.run ?? runWrangler;
  const exec = async (sql: string, params: readonly unknown[]) => {
    const args = [
      "d1",
      "execute",
      opts.database,
      "--command",
      renderSql(sql, params),
      "--json",
    ];
    if (opts.local) args.push("--local");
    else args.push("--remote");
    if (opts.wranglerEnv) args.push("--env", opts.wranglerEnv);
    const result = await run(args);
    if (result.code !== 0) {
      throw new Error(result.stderr || `wrangler d1 execute failed (${result.code})`);
    }
    return parseWranglerD1Rows(result.stdout);
  };

  return {
    async first<T>(sql: string, ...params: unknown[]) {
      const rows = await exec(sql, params);
      return (rows[0] as T | undefined) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return (await exec(sql, params)) as T[];
    },
    async batch(statements: readonly SqlStatement[]) {
      for (const statement of statements) {
        await exec(statement.sql, statement.params);
      }
    },
  };
}

export function renderSql(sql: string, params: readonly unknown[]): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    if (index >= params.length) throw new Error("missing sql parameter");
    return sqlLiteral(params[index++]);
  });
}

function sqlLiteral(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error("unsupported sql parameter");
}

function parseWranglerD1Rows(stdout: string): Record<string, unknown>[] {
  const parsed = JSON.parse(stdout) as unknown;
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!block || typeof block !== "object" || !("results" in block)) return [];
  const results = (block as { results?: unknown }).results;
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
}

function runWrangler(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function printUsage(): void {
  process.stderr.write(`Usage: npm run founder-bootstrap -- [--email <addr>] [--env local|staging|production] [--execute] [--confirm-production]

Idempotently creates or resolves the founder user, default settings,
explicit placeholder tenant limits, and imports READER_API_TOKEN as a
90-day legacy-format API token. Dry-run by default.

  --email                  Founder address. Default: FOUNDER_EMAIL.
  --env                    local (default), staging, or production.
  --execute                Apply writes. Otherwise prints the plan.
  --confirm-production     Required with --execute --env production.
  --help                   Show this message.

Credentials: AUTH_ROOT_SECRET and READER_API_TOKEN from the environment
or .dev.vars / .stg.vars / .prd.vars. Apply D1 migrations first:

  wrangler d1 migrations apply reading-lite-control-dev --local
  wrangler d1 migrations apply reading-lite-control-staging --env staging --remote
  wrangler d1 migrations apply reading-lite-control --env production --remote
`);
}

function resolveEnvVars(env: BootstrapEnvName): Record<string, string | undefined> {
  return {
    ...loadDotVars(DOTVARS_BY_ENV[env]),
    ...process.env,
  };
}

async function main(): Promise<void> {
  let args: FounderBootstrapCliArgs;
  try {
    args = parseFounderBootstrapArgs();
  } catch (error) {
    if (error instanceof HelpRequested) {
      printUsage();
      process.exit(0);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    printUsage();
    process.exit(2);
  }

  const result = await runFounderBootstrap(args, {
    envVars: resolveEnvVars(args.env),
    nowMs: Date.now(),
    write: (line) => void process.stderr.write(line),
    openDb: async (env) =>
      makeWranglerD1({
        database: DATABASE_BY_ENV[env],
        local: env === "local",
        ...(env === "local" ? {} : { wranglerEnv: env }),
      }),
  });
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
