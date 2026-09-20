import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { prepareContextCopy, copyHash, type CopyInput, type CopyReaders } from '../../staging-lib/context-copy';
import { r2InventoryClientFromVars } from '../../lib/cf-clients';
import { loadDotVars } from '../../lib/dotvars';
import { resolveActivationAuth } from '../tenant-activation-preflight';
import { policyDb } from '../../system-lib/policy';
import { parseTenantId } from '../../../src/control-plane/ids';
import { UsageError, type BaseDeps, type CommandDefinition } from '../contract';
export interface PrepareContextDeps extends BaseDeps {
    readInput(path: string): Promise<unknown>;
    readers(source: string, destination: string, corpusVars?: string): Promise<CopyReaders>;
    save(path: string, artifact: Awaited<ReturnType<typeof prepareContextCopy>>): Promise<void>;
    now(): string;
}
export const stagingPrepareContextCommand: CommandDefinition<PrepareContextDeps> = {
    group: 'staging', name: 'prepare-context', safety: 'plan-first', summary: 'Prepare a private production-to-staging context copy artifact (no remote writes)',
    helpText: `Usage: npm run ops -- staging prepare-context --source-tenant usr_… --tenant usr_… --input <json> [--output-dir <new-directory> --execute]
--corpus-vars <path> selects S3 inventory credentials (default .corpus.vars).
Input JSON: {ids: [reading IDs], targets: [{id, contentSha256}]}.
Reads production source objects/vectors and staging destination preconditions.
Default prints the artifact summary without writing files. --execute ONLY writes
local private payload files; it never copies remote data, enqueues, or calls providers.
Source/destination buckets and indexes are fixed to production/staging. Existing
output directories are refused. Review the resulting plan and obtain separate
approval before applying its remote mutations. --help shows this message.`,
    defaultDeps: io => ({ io, now: () => new Date().toISOString(), readInput: async (path) => JSON.parse(await readFile(path, 'utf8')),
        readers: async (source, destination, corpusVars) => {
            const { accountId, auth } = await resolveActivationAuth('');
            const vars = { ...loadDotVars(corpusVars ?? '.corpus.vars'), ...process.env };
            if ((vars.CORPUS_R2_ACCOUNT_ID ?? vars.CLOUDFLARE_ACCOUNT_ID) !== accountId || !vars.CORPUS_R2_ACCESS_KEY || !vars.CORPUS_R2_SECRET_KEY)
                throw Error('Matching-account S3 inventory credentials required for complete destination prefix checks');
            const db = policyDb('staging');
            const state = await db.first<{
                status: string;
                paid_work_enabled: number;
            }>("SELECT u.status, sp.paid_work_enabled FROM users u CROSS JOIN system_policy sp WHERE u.id = ? AND sp.id = 1", destination);
            if (state?.status !== 'active' || state.paid_work_enabled !== 0)
                throw Error('Staging tenant must be active and paid work disabled');
            const readFetch: typeof fetch = async (input, init) => {
                if (init?.method !== undefined && !['GET', 'HEAD'].includes(init.method))
                    throw Error('Read-only artifact transport');
                const headers = new Headers(init?.headers);
                headers.delete('authorization');
                for (const [key, value] of Object.entries(auth))
                    headers.set(key, value);
                return fetch(input, { ...init, headers });
            };
            const reader = (bucket: string, tenant: string) => {
                const root = `u/${tenant}/`;
                const client = r2InventoryClientFromVars(vars, bucket, async (input, init) => { if (init?.method !== undefined && !['GET', 'HEAD'].includes(init.method))
                    throw Error('Read-only S3 transport'); return fetch(input, init); });
                return { read: async (key: string) => {
                        // Binary-safe read and ETag in the same observation.
                        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${(root + key).split('/').map(encodeURIComponent).join('/')}`;
                        const r = await readFetch(url, { method: 'GET' });
                        if (r.status === 404)
                            return null;
                        if (!r.ok)
                            throw Error(`R2 read failed (${r.status})`);
                        return { body: new Uint8Array(await r.arrayBuffer()), etag: (r.headers.get('etag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, ''), contentType: r.headers.get('content-type') };
                    }, list: async (prefix: string) => (await client.listObjects(root + prefix)).map(o => o.key.slice(root.length)) };
            };
            // The vector ledger is retired (ADR 0005, migration 0003): an
            // embedding is a row of reading_embeddings that cascades with its
            // reading, so there is no separate id ledger. The ids this copy
            // needs are the destination tenant's readings that own one.
            const embedded = await db.all<{
                reading_id: string;
            }>("SELECT reading_id FROM reading_embeddings WHERE tenant_id = ?", destination);
            return { ledgerIds: embedded.map(row => row.reading_id), source: reader('reading-lite', source), destination: reader('reading-lite-staging', destination), vectors: async (ids, staging) => {
                    // This POST is Vectorize's read-only get-by-id API; no provider dispatch.
                    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${staging ? 'reading-lite-staging' : 'reading-lite'}/get_by_ids`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
                    if (!r.ok)
                        throw Error(`Vector read failed (${r.status})`);
                    const data = await r.json() as {
                        success?: boolean;
                        result?: unknown[];
                    };
                    if (data.success !== true || !Array.isArray(data.result))
                        throw Error('Invalid vector response');
                    return data.result;
                } };
        },
        save: async (path, artifact) => {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await mkdir(path, { mode: 0o700 });
            await mkdir(join(path, 'blobs'), { mode: 0o700 });
            for (const [hash, body] of artifact.blobs)
                await writeFile(join(path, 'blobs', hash), body, { flag: 'wx', mode: 0o600 });
            const { blobs: _blobs, ...plan } = artifact;
            const body = JSON.stringify(plan, null, 2) + '\n';
            await writeFile(join(path, 'plan.json'), body, { flag: 'wx', mode: 0o600 });
            await writeFile(join(path, 'SHA256SUMS'), `${copyHash(body)}  plan.json\n` + [...artifact.blobs.keys()].sort().map(hash => `${hash}  blobs/${hash}\n`).join(''), { flag: 'wx', mode: 0o600 });
        } }),
    async run(argv, deps) {
        let values;
        try {
            ({ values } = parseArgs({ args: argv, options: { 'source-tenant': { type: 'string' }, tenant: { type: 'string' }, input: { type: 'string' }, 'corpus-vars': { type: 'string' }, 'output-dir': { type: 'string' }, execute: { type: 'boolean' } } }));
        }
        catch {
            throw new UsageError('Invalid preparation arguments');
        }
        const source = parseTenantId(values['source-tenant'] ?? ''), destination = parseTenantId(values.tenant ?? '');
        if (!source || !destination || source === destination || !values.input || (!!values.execute !== !!values['output-dir']))
            throw new UsageError('Distinct tenants, input, and output-dir together with execute required');
        const raw = await deps.readInput(values.input);
        const parsed = z.object({ ids: z.array(z.string()).min(1).max(200), targets: z.array(z.object({ id: z.string(), contentSha256: z.string(), markdownSha256: z.string().optional() })).max(200) }).parse(raw);
        const args: CopyInput = { ...parsed, sourceTenant: source, destinationTenant: destination, now: deps.now() };
        const plan = await prepareContextCopy(args, await deps.readers(source, destination, values["corpus-vars"]));
        deps.io.stdout(JSON.stringify({ mode: values.execute ? 'local-artifact' : 'plan', source: plan.source, destination: plan.destination, readings: plan.ledgerIds.length, objects: plan.objects.length, vectors: plan.vectors.length, metadataDrift: plan.metadataDrift.length, list: plan.list, targets: plan.targets.length, reprocesses: plan.targets.filter(t => t.action === 'reprocess').length, privatePayloadBytes: [...plan.blobs.values()].reduce((n, b) => n + b.byteLength, 0), providerCalls: 0, remoteWrites: 0 }, null, 2));
        if (values.execute)
            await deps.save(values['output-dir']!, plan);
        return 0;
    }
};
