// `ops provider-keys reencrypt` — reseal every stored tenant provider key under
// the current PROVIDER_KEY_SECRET after a rotation (reading-lite-gh341.12).
//
// ADR 0004 rotation: the Worker decrypts with PROVIDER_KEY_PREVIOUS_SECRET for a
// bounded window, and this command moves every row onto the current version so
// the previous secret can be removed. A row records only the version that
// sealed it, so a rotation that re-encrypts must bump PROVIDER_KEY_VERSION;
// equal versions are refused because nothing would tell the rows apart.
//
// Both modes trial-decrypt every row locally and print counts per key_version,
// never plaintext. A row already on the current version that the supplied
// current secret cannot open is evidence that secret is not the Worker's, so
// --execute refuses before any write: resealing under a secret the Worker does
// not have would strand every key. Otherwise --execute reseals one row per
// transaction under SELECT … FOR UPDATE (reencryptProviderCredential), then
// lists again and exits 0 only when every row is on the current version and
// opens under it. A row neither secret opens is skipped and listed; its reader
// reconnects the key.

import { parseArgs } from "node:util";
import {
  decryptProviderKey,
  readProviderKeyRoots,
  type ProviderKeyRoot,
  type ProviderKeyRoots,
} from "../../../src/control-plane/provider-key-crypto";
import {
  listProviderCredentials,
  reencryptProviderCredential,
  type ProviderCredential,
  type ReencryptOutcome,
} from "../../../src/control-plane/provider-credentials";
import { resolveEnvVars, type BootstrapEnvName } from "../../lib/founder-bootstrap";
import { bucketForDeployEnv, openOperatorSql, resolveOperatorDatabaseUrl, withOperatorControlPlane, type OpenOperatorSql } from "../../pg-lib/operator-db";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface ProviderKeysReencryptDeps extends BaseDeps {
  openSql: OpenOperatorSql;
  /** The environment's variables: .dev.vars / .stg.vars / .prd.vars, then process.env. */
  vars: (env: BootstrapEnvName) => Record<string, string | undefined>;
}

interface Args {
  env: BootstrapEnvName;
  databaseUrlEnv?: string;
  execute: boolean;
  confirmProduction: boolean;
}

type RowState = "current" | "reseal" | "undecryptable";

interface ClassifiedRow {
  row: ProviderCredential;
  state: RowState;
}

const UNPROVEN_SECRET =
  "No row is on the current key_version yet, so nothing proves the supplied PROVIDER_KEY_SECRET is the Worker's. " +
  "After deploying the rotated secrets, connect or replace any key in settings (the Worker seals it under the " +
  "current version), then rerun.";

const ENVS: readonly BootstrapEnvName[] = ["local", "staging", "production"];

function parseReencryptArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        env: { type: "string" },
        "database-url-env": { type: "string" },
        execute: { type: "boolean", default: false },
        "confirm-production": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.env === undefined) throw new UsageError("--env is required (local|staging|production)");
  if (!ENVS.includes(values.env as BootstrapEnvName)) {
    throw new UsageError(`unknown --env ${values.env} (expected local|staging|production)`);
  }
  const args: Args = {
    env: values.env as BootstrapEnvName,
    execute: values.execute === true,
    confirmProduction: values["confirm-production"] === true,
    ...(values["database-url-env"] === undefined ? {} : { databaseUrlEnv: values["database-url-env"] }),
  };
  if (args.env === "production" && args.execute && !args.confirmProduction) {
    throw new UsageError("--confirm-production is required with --execute --env production");
  }
  return args;
}

function rootsFrom(vars: Record<string, string | undefined>): ProviderKeyRoots {
  let roots: ProviderKeyRoots;
  try {
    roots = readProviderKeyRoots(vars);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (roots.previousProviderKeyRoot?.version === roots.providerKeyRoot.version) {
    throw new UsageError(
      `PROVIDER_KEY_VERSION and PROVIDER_KEY_PREVIOUS_VERSION are both ${roots.providerKeyRoot.version}: ` +
        "a rotation that re-encrypts must bump PROVIDER_KEY_VERSION, because a row records only the version that sealed it",
    );
  }
  return roots;
}

async function opens(row: ProviderCredential, root: ProviderKeyRoot): Promise<boolean> {
  try {
    await decryptProviderKey({
      roots: { providerKeyRoot: root },
      tenantId: row.tenantId,
      credentialVersion: row.credentialVersion,
      keyVersion: row.keyVersion,
      ciphertext: row.ciphertext,
      iv: row.iv,
    });
    return true;
  } catch {
    return false;
  }
}

async function classify(rows: readonly ProviderCredential[], roots: ProviderKeyRoots): Promise<ClassifiedRow[]> {
  const out: ClassifiedRow[] = [];
  for (const row of rows) {
    const { providerKeyRoot: current, previousProviderKeyRoot: previous } = roots;
    let state: RowState = "undecryptable";
    if (row.keyVersion === current.version) {
      if (await opens(row, current)) state = "current";
    } else if (previous && row.keyVersion === previous.version) {
      if (await opens(row, previous)) state = "reseal";
    }
    out.push({ row, state });
  }
  return out;
}

function byKeyVersion(classified: readonly ClassifiedRow[]) {
  const versions = new Map<number, { key_version: number; rows: number; current: number; reseal: number; undecryptable: number }>();
  for (const { row, state } of classified) {
    const entry = versions.get(row.keyVersion) ?? { key_version: row.keyVersion, rows: 0, current: 0, reseal: 0, undecryptable: 0 };
    entry.rows++;
    entry[state]++;
    versions.set(row.keyVersion, entry);
  }
  return [...versions.values()].sort((a, b) => a.key_version - b.key_version);
}

function listUndecryptable(io: CommandIo, classified: readonly ClassifiedRow[]): void {
  for (const { row } of classified.filter((c) => c.state === "undecryptable")) {
    io.stderr(
      `  ${row.tenantId} ${row.provider} key_version ${row.keyVersion} credential_version ${row.credentialVersion} (${row.status})`,
    );
  }
}

async function runProviderKeysReencrypt(argv: string[], deps: ProviderKeysReencryptDeps): Promise<number> {
  const args = parseReencryptArgs(argv);
  const vars = deps.vars(args.env);
  const roots = rootsFrom(vars);
  const { url } =
    args.env === "local"
      ? resolveOperatorDatabaseUrl({ bucket: "", local: true, databaseUrlEnv: args.databaseUrlEnv, env: vars })
      : resolveOperatorDatabaseUrl({ bucket: bucketForDeployEnv(args.env), databaseUrlEnv: args.databaseUrlEnv, env: vars });
  const { io } = deps;
  const current = roots.providerKeyRoot;
  const previous = roots.previousProviderKeyRoot;

  return withOperatorControlPlane(
    url,
    async (db) => {
      const before = await classify(await listProviderCredentials(db), roots);
      const summary = {
        mode: args.execute ? "execute" : "plan",
        env: args.env,
        current_key_version: current.version,
        previous_key_version: previous?.version ?? null,
        rows: before.length,
        by_key_version: byKeyVersion(before),
        rows_reencrypted: 0,
        rows_remaining: before.filter((c) => c.state !== "current").length,
      };
      if (!args.execute) {
        const undecryptable = before.filter((c) => c.state === "undecryptable").length;
        if (undecryptable > 0) {
          io.stderr(`${undecryptable} row(s) open under neither supplied secret:`);
          listUndecryptable(io, before);
        }
        const reseal = before.filter((c) => c.state === "reseal").length;
        if (reseal > 0 && !before.some((c) => c.state === "current")) io.stderr(UNPROVEN_SECRET);
        if (reseal > 0) io.stderr(`PLAN — nothing changed. Rerun with --execute to reseal ${reseal} row(s) under key_version ${current.version}.`);
        io.stdout(JSON.stringify(summary, null, 2));
        return 0;
      }

      const wrongSecret = before.filter((c) => c.state === "undecryptable" && c.row.keyVersion === current.version);
      if (wrongSecret.length > 0) {
        io.stderr(
          `✗ ${wrongSecret.length} row(s) already on key_version ${current.version} do not open under the supplied ` +
            "PROVIDER_KEY_SECRET, so it is not the secret the Worker seals with. Nothing was written.",
        );
        io.stdout(JSON.stringify(summary, null, 2));
        return 1;
      }

      // Resealing is only safe once a row the Worker sealed under the current
      // version opens under the supplied secret. Without one, a mistyped local
      // secret would reseal every row under a key the Worker does not have, and
      // the final check (with that same secret) would still pass.
      if (before.some((c) => c.state === "reseal") && !before.some((c) => c.state === "current")) {
        io.stderr(`✗ ${UNPROVEN_SECRET} Nothing was written.`);
        io.stdout(JSON.stringify(summary, null, 2));
        return 1;
      }

      const outcomes = new Map<ReencryptOutcome, number>();
      for (const { row } of before.filter((c) => c.state === "reseal")) {
        const outcome = await reencryptProviderCredential(db, {
          tenantId: row.tenantId,
          provider: row.provider,
          from: previous!,
          to: current,
        });
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      }
      summary.rows_reencrypted = outcomes.get("reencrypted") ?? 0;

      const after = await classify(await listProviderCredentials(db), roots);
      const left = after.filter((c) => c.state !== "current");
      summary.rows_remaining = left.length;
      if (left.length > 0) {
        io.stderr(`${left.length} row(s) are not on key_version ${current.version} after resealing:`);
        for (const { row, state } of left) {
          io.stderr(`  ${row.tenantId} ${row.provider} key_version ${row.keyVersion} credential_version ${row.credentialVersion} (${state})`);
        }
        io.stderr("Their readers reconnect their keys, or restore the secret that sealed them and rerun.");
      }
      io.stdout(JSON.stringify(summary, null, 2));
      return left.length > 0 ? 1 : 0;
    },
    deps.openSql,
  );
}

export const providerKeysReencryptCommand: CommandDefinition<ProviderKeysReencryptDeps> = {
  group: "provider-keys",
  name: "reencrypt",
  summary: "Reseal stored tenant provider keys under the current secret after a rotation",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- provider-keys reencrypt --env local|staging|production [options]

After a provider-key secret rotation, reseals every tenant_provider_credentials
row sealed under PROVIDER_KEY_PREVIOUS_SECRET with PROVIDER_KEY_SECRET, keeping
each row's credential version. Plan mode trial-decrypts every row locally and
prints counts per key_version; it writes nothing and never prints a key.

--execute refuses to write unless at least one row is already on the current
version (sealed by the Worker since the rotation deploy) and every such row opens
under the supplied PROVIDER_KEY_SECRET: that is the only proof the local secret
is the Worker's. Connect or replace any key in settings to create one.
Otherwise it reseals one row per transaction under its row lock, lists again,
and exits 1 unless every row is on the current version and opens under it.
Rows neither secret opens are listed by tenant and left for their readers to
reconnect.

The versions must differ: bump PROVIDER_KEY_VERSION when rotating, and set
PROVIDER_KEY_PREVIOUS_SECRET / PROVIDER_KEY_PREVIOUS_VERSION to the old pair.
See docs/operations.md#provider-key-rotation.

Options:
  --env <name>              local, staging or production. Required.
  --database-url-env <NAME> Staging and production: the variable holding a
                            DIRECT PostgreSQL connection string, checked
                            against the environment's pairing. Default:
                            whichever accepted name is set. Local uses the dev
                            database.
  --execute                 Reseal the rows the plan counts.
  --confirm-production      Required with --execute --env production.
  --help                    Show this message.

Secrets: PROVIDER_KEY_SECRET, PROVIDER_KEY_VERSION, PROVIDER_KEY_PREVIOUS_SECRET
and PROVIDER_KEY_PREVIOUS_VERSION from the environment or .dev.vars / .stg.vars /
.prd.vars, the same values the Worker has.`,
  defaultDeps: (io: CommandIo): ProviderKeysReencryptDeps => ({
    io,
    openSql: openOperatorSql,
    vars: resolveEnvVars,
  }),
  run: runProviderKeysReencrypt,
};
