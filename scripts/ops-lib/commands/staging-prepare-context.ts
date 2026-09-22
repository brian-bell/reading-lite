import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  prepareContextCopy,
  copyHash,
  CopySelectionSchema,
  type CopyInput,
  type CopyReaders,
} from "../../staging-lib/context-copy";
import { r2InventoryClientFromVars } from "../../lib/cf-clients";
import { loadDotVars } from "../../lib/dotvars";
import { resolveActivationAuth } from "../tenant-activation-preflight";
import {
  withContextDatabases,
  readContextRows,
} from "../../staging-lib/context-rows";
import { parseTenantId } from "../../../src/control-plane/ids";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
export interface PrepareContextDeps extends BaseDeps {
  readInput(path: string): Promise<unknown>;
  withReaders<T>(
    source: string,
    destination: string,
    corpusVars: string | undefined,
    work: (readers: CopyReaders) => Promise<T>,
  ): Promise<T>;
  save(
    path: string,
    artifact: Awaited<ReturnType<typeof prepareContextCopy>>,
  ): Promise<void>;
  now(): string;
}
export const stagingPrepareContextCommand: CommandDefinition<PrepareContextDeps> =
  {
    group: "staging",
    name: "prepare-context",
    safety: "plan-first",
    summary:
      "Prepare a private production-to-staging context copy artifact (no remote writes)",
    helpText: `Usage: npm run ops -- staging prepare-context --source-tenant usr_… --tenant usr_… --input <json> [--output-dir <new-directory> --execute]
--corpus-vars <path> selects S3 inventory credentials (default .corpus.vars).
Input JSON: {ids: [reading IDs], targets: [{id, contentSha256}]}.
Reads production PostgreSQL rows/embeddings, referenced R2 content, and staging preconditions.
Source NEON_MAIN_DATABASE_URL and NEON_REHEARSAL_DATABASE_URL (or the paired
PRODUCTION_DATABASE_URL/STAGING_DATABASE_URL) for direct PostgreSQL connections.
Default prints the artifact summary without writing files. --execute ONLY writes
local private payload files; it never copies remote data, enqueues, or calls providers.
Source/destination buckets and databases are fixed to production/staging. Existing
output directories are refused. Review the resulting plan and obtain separate
approval before applying its remote mutations. --help shows this message.`,
    defaultDeps: (io) => ({
      io,
      now: () => new Date().toISOString(),
      readInput: async (path) => JSON.parse(await readFile(path, "utf8")),
      withReaders: async (source, destination, corpusVars, work) => {
        const { accountId, auth } = await resolveActivationAuth("");
        const vars = {
          ...loadDotVars(corpusVars ?? ".corpus.vars"),
          ...process.env,
        };
        if (
          (vars.CORPUS_R2_ACCOUNT_ID ?? vars.CLOUDFLARE_ACCOUNT_ID) !==
            accountId ||
          !vars.CORPUS_R2_ACCESS_KEY ||
          !vars.CORPUS_R2_SECRET_KEY
        )
          throw Error(
            "Matching-account S3 inventory credentials required for complete destination prefix checks",
          );
        const readFetch: typeof fetch = async (input, init) => {
          if (
            init?.method !== undefined &&
            !["GET", "HEAD"].includes(init.method)
          )
            throw Error("Read-only artifact transport");
          const headers = new Headers(init?.headers);
          headers.delete("authorization");
          for (const [key, value] of Object.entries(auth))
            headers.set(key, value);
          return fetch(input, { ...init, headers });
        };
        const reader = (bucket: string, tenant: string) => {
          const root = `u/${tenant}/`;
          const client = r2InventoryClientFromVars(
            vars,
            bucket,
            async (input, init) => {
              if (
                init?.method !== undefined &&
                !["GET", "HEAD"].includes(init.method)
              )
                throw Error("Read-only S3 transport");
              return fetch(input, init);
            },
          );
          return {
            read: async (key: string) => {
              // Binary-safe read and ETag in the same observation.
              const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${(root + key).split("/").map(encodeURIComponent).join("/")}`;
              const r = await readFetch(url, { method: "GET" });
              if (r.status === 404) return null;
              if (!r.ok) throw Error(`R2 read failed (${r.status})`);
              return {
                body: new Uint8Array(await r.arrayBuffer()),
                etag: (r.headers.get("etag") ?? "")
                  .replace(/^W\//, "")
                  .replace(/^"|"$/g, ""),
                contentType: r.headers.get("content-type"),
              };
            },
            list: async (prefix: string) =>
              (await client.listObjects(root + prefix)).map((o) =>
                o.key.slice(root.length),
              ),
          };
        };
        return withContextDatabases(vars, (sourceSql, destinationSql) =>
          work({
            source: reader("reading-lite", source),
            destination: reader("reading-lite-staging", destination),
            rows: (ids, seeds) =>
              readContextRows(
                sourceSql,
                destinationSql,
                source,
                destination,
                ids,
                seeds,
              ),
          }),
        );
      },
      save: async (path, artifact) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await mkdir(path, { mode: 0o700 });
        await mkdir(join(path, "blobs"), { mode: 0o700 });
        for (const [hash, body] of artifact.blobs)
          await writeFile(join(path, "blobs", hash), body, {
            flag: "wx",
            mode: 0o600,
          });
        const { blobs: _blobs, ...plan } = artifact;
        const body = JSON.stringify(plan, null, 2) + "\n";
        await writeFile(join(path, "plan.json"), body, {
          flag: "wx",
          mode: 0o600,
        });
        await writeFile(
          join(path, "SHA256SUMS"),
          `${copyHash(body)}  plan.json\n` +
            [...artifact.blobs.keys()]
              .sort()
              .map((hash) => `${hash}  blobs/${hash}\n`)
              .join(""),
          { flag: "wx", mode: 0o600 },
        );
      },
    }),
    async run(argv, deps) {
      let values;
      try {
        ({ values } = parseArgs({
          args: argv,
          options: {
            "source-tenant": { type: "string" },
            tenant: { type: "string" },
            input: { type: "string" },
            "corpus-vars": { type: "string" },
            "output-dir": { type: "string" },
            execute: { type: "boolean" },
          },
        }));
      } catch {
        throw new UsageError("Invalid preparation arguments");
      }
      const source = parseTenantId(values["source-tenant"] ?? ""),
        destination = parseTenantId(values.tenant ?? "");
      if (
        !source ||
        !destination ||
        source === destination ||
        !values.input ||
        !!values.execute !== !!values["output-dir"]
      )
        throw new UsageError(
          "Distinct tenants, input, and output-dir together with execute required",
        );
      const raw = await deps.readInput(values.input);
      const parsed = CopySelectionSchema.parse(raw);
      const args: CopyInput = {
        ...parsed,
        sourceTenant: source,
        destinationTenant: destination,
        now: deps.now(),
      };
      return deps.withReaders(
        source,
        destination,
        values["corpus-vars"],
        async (readers) => {
          const plan = await prepareContextCopy(args, readers);
          deps.io.stdout(
            JSON.stringify(
              {
                mode: values.execute ? "local-artifact" : "plan",
                format: plan.format,
                source: plan.source,
                destination: plan.destination,
                readings: plan.readingIds.length,
                objects: plan.objects.length,
                embeddings: plan.rows.filter((r) => r.embedding !== null)
                  .length,
                targets: plan.targets.length,
                reprocesses: plan.targets.filter(
                  (t) => t.action === "reprocess",
                ).length,
                privatePayloadBytes: [...plan.blobs.values()].reduce(
                  (n, b) => n + b.byteLength,
                  0,
                ),
                providerCalls: 0,
                remoteWrites: 0,
              },
              null,
              2,
            ),
          );
          if (values.execute) await deps.save(values["output-dir"]!, plan);
          return 0;
        },
      );
    },
  };
