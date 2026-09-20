import { applyStaleness } from "../../src/modules/staleness";
// Produces a private, content-addressed COPY ARTIFACT. This module has no write,
// queue, or provider capability. Destination is always the staging bucket;
// materializing an artifact is separate from approving/applying its mutations.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ManifestSchema, ByUrlPointerSchema } from '../../src/schemas/manifest';
import { ListIndexSchema } from '../../src/schemas/api';
import { manifestToIndexItem } from '../../src/modules/stores/list-index';
import { buildKeyPrefix, r2KeyLayout } from '../../src/modules/stores/layout';
import { parseTenantId } from '../../src/control-plane/ids';
export type CopyObject = {
    body: Uint8Array;
    etag: string;
    contentType: string | null;
};
export interface CopyReader {
    read(key: string): Promise<CopyObject | null>;
    list(prefix: string): Promise<string[]>;
}
export interface CopyReaders {
    source: CopyReader;
    destination: CopyReader;
    vectors(ids: string[], staging: boolean): Promise<unknown[]>;
}
export interface CopyInput {
    sourceTenant: string;
    destinationTenant: string;
    ids: string[];
    targets: {
        id: string;
        contentSha256: string;
        markdownSha256?: string;
    }[];
    now: string;
}
const ReadingId = z.string().regex(/^rd_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
const Vector = z.object({ id: z.string(), namespace: z.string(), values: z.array(z.number().finite()).length(1536), metadata: z.record(z.string(), z.unknown()) });
export const copyHash = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
function rawExt(type: string) { const t = type.split(';')[0]!.trim().toLowerCase(); return t === 'text/html' || t === 'application/xhtml+xml' ? 'html' : t === 'text/markdown' ? 'md' : t === 'application/pdf' ? 'pdf' : t === 'application/json' ? 'json' : t.startsWith('text/') ? 'txt' : 'bin'; }
export async function prepareContextCopy(input: CopyInput, readers: CopyReaders) {
    const sourceTenant = parseTenantId(input.sourceTenant), destinationTenant = parseTenantId(input.destinationTenant);
    if (!sourceTenant || !destinationTenant || sourceTenant === destinationTenant)
        throw Error('Distinct canonical tenants required');
    const ids = z.array(ReadingId).min(1).max(200).parse(input.ids).sort();
    if (new Set(ids).size !== ids.length)
        throw Error('Duplicate seed IDs');
    const targets = z.array(z.object({ id: ReadingId, contentSha256: z.string().regex(/^[a-f0-9]{64}$/), markdownSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(200).parse(input.targets);
    if (new Set(targets.map(t => t.id)).size !== targets.length)
        throw Error('Duplicate target IDs');
    const layout = r2KeyLayout();
    const list = await readers.destination.read(layout.listIndexKey());
    if (!list?.etag)
        throw Error('Existing destination list with ETag required');
    const existing = ListIndexSchema.parse(JSON.parse(Buffer.from(list.body).toString()));
    // Occupancy is read from the destination's own list index. It used to come
    // from the operator vector ledger, retired in reading-lite-gh347.4.6;
    // reading-lite-gh347.4.3 ports this read to `readings`.
    if (existing.items.some(item => ids.includes(item.id)))
        throw Error('Occupied destination reading ID');
    const blobs = new Map<string, Uint8Array>();
    const blob = (body: Uint8Array | string) => { const bytes = typeof body === 'string' ? Buffer.from(body) : body; const hash = copyHash(bytes); blobs.set(hash, bytes); return hash; };
    const objects: {
        key: string;
        blob: string;
        contentType: string | null;
        expected: 'absent';
        sourceKey: string | null;
        sourceSha256: string | null;
    }[] = [];
    const sourceChecks: {
        key: string;
        sha256: string;
    }[] = [];
    const manifests = new Map<string, Awaited<ReturnType<typeof readManifest>>>();
    async function sourceRead(key: string) { const object = await readers.source.read(key); if (!object)
        throw Error('Missing source object ' + key); sourceChecks.push({ key, sha256: copyHash(object.body) }); return object; }
    async function readManifest(id: string) {
        const pointer = await sourceRead(layout.byIdKey(id));
        const parsed = z.object({ key_prefix: z.string() }).parse(JSON.parse(Buffer.from(pointer.body).toString()));
        if (!/^readings\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}T[0-9]{6}Z-rd_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(parsed.key_prefix))
            throw Error('Unsafe source prefix');
        const raw = await sourceRead(layout.manifestKey(parsed.key_prefix));
        // Match the read API's ready projection, without changing production.
        // A fresh active attempt still refuses the copy. Historical stale
        // markers are omitted along with all attempt/checkpoint artifacts.
        const m = applyStaleness(ManifestSchema.parse(JSON.parse(Buffer.from(raw.body).toString())), 900, input.now);
        if (m.id !== id || m.status !== 'ready' || m.active_attempt || m.preserve_ready_manifest || buildKeyPrefix(m.id, m.created_at) !== parsed.key_prefix || copyHash(m.url) !== m.url_hash)
            throw Error(`Source manifest identity/state mismatch ${id}: ${JSON.stringify({ actualId: m.id, status: m.status, active: !!m.active_attempt, preserved: !!m.preserve_ready_manifest, prefixMatches: buildKeyPrefix(m.id, m.created_at) === parsed.key_prefix, urlHashMatches: copyHash(m.url) === m.url_hash })}`);
        const byUrl = await sourceRead(layout.byUrlKey(m.url_hash));
        const owner = ByUrlPointerSchema.parse(JSON.parse(Buffer.from(byUrl.body).toString()));
        if (owner.id !== id || owner.key_prefix !== parsed.key_prefix)
            throw Error('Source URL ownership mismatch');
        return { m, prefix: parsed.key_prefix, pointer, byUrl };
    }
    async function destAbsent(key: string) { if (await readers.destination.read(key))
        throw Error('Occupied destination ' + key); }
    async function each<T>(items: T[], fn: (item: T) => Promise<void>) {
        for (let i = 0; i < items.length; i += 4) await Promise.all(items.slice(i, i + 4).map(fn));
    }
    await each([...new Set([...ids, ...targets.map(t => t.id)])], async id => {
        const entry = await readManifest(id);
        manifests.set(id, entry);
        if (existing.items.some(r => r.id === id || r.url === entry.m.url))
            throw Error('Occupied destination list identity');
        await destAbsent(layout.byIdKey(id));
        await destAbsent(layout.byUrlKey(entry.m.url_hash));
        if ((await readers.destination.list(layout.readingObjectsPrefix(entry.prefix))).length)
            throw Error('Occupied destination reading prefix');
    });
    const vectors: z.infer<typeof Vector>[] = [];
    const metadataDrift: {id:string;title:boolean;tldr:boolean;copiedContext:'stored-vector'}[] = [];
    for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const wanted = chunk.map(id => `${sourceTenant}:${id}`);
        const found = z.array(Vector).parse(await readers.vectors(wanted, false));
        if (found.length !== chunk.length || new Set(found.map(v => v.id)).size !== chunk.length || found.some(v => !wanted.includes(v.id)))
            throw Error('Missing/duplicate source vector');
        if ((await readers.vectors(chunk.map(id => `${destinationTenant}:${id}`), true)).length)
            throw Error('Occupied destination vector');
        for (const v of found) {
            const id = v.id.slice(sourceTenant.length + 1);
            const m = manifests.get(id)!.m;
            if (v.namespace !== sourceTenant || v.metadata.tenant_id !== sourceTenant || v.metadata.url !== m.url)
                throw Error('Source vector namespace/metadata mismatch '+id);
            if(v.metadata.title!==m.title || v.metadata.tldr!==m.tldr) metadataDrift.push({id,title:v.metadata.title!==m.title,tldr:v.metadata.tldr!==m.tldr,copiedContext:'stored-vector'});
            // The Worker uses indexed metadata as prompt context. Preserve it
            // exactly; repairing source drift would change the measured workload.
            vectors.push({ ...v, id: `${destinationTenant}:${id}`, namespace: destinationTenant, metadata: { ...v.metadata, tenant_id: destinationTenant } });
        }
    }
    await each(ids, async id => {
        const { m, prefix, pointer, byUrl } = manifests.get(id)!;
        const rawKey = layout.rawKey(prefix, rawExt(m.content_type));
        const raw = await sourceRead(rawKey);
        if (copyHash(raw.body) !== m.content_sha256 || raw.body.byteLength !== m.content_bytes)
            throw Error(`Raw content hash/size mismatch ${id}: hashMatches=${copyHash(raw.body) === m.content_sha256}, actualBytes=${raw.body.byteLength}, expectedBytes=${m.content_bytes}`);
        const add = (key: string, body: Uint8Array | string, contentType: string | null, sourceKey: string | null, sourceSha256: string | null) => objects.push({ key: `u/${destinationTenant}/${key}`, blob: blob(body), contentType, expected: 'absent', sourceKey: sourceKey === null ? null : `u/${sourceTenant}/${sourceKey}`, sourceSha256 });
        add(rawKey, raw.body, raw.contentType, rawKey, copyHash(raw.body));
        if (m.content_status === 'captured') {
            const key = layout.extractedKey(prefix), extracted = await sourceRead(key);
            if (m.extracted_bytes !== undefined && m.extracted_bytes !== extracted.body.byteLength)
                throw Error('Extracted size mismatch');
            add(key, extracted.body, extracted.contentType, key, copyHash(extracted.body));
        }
        else if (m.content_status !== 'raw_only')
            throw Error('Unsupported context content state');
        // Historical diagnostics/checkpoints are not copied into this measurement.
        const { last_attempt: _last, ...clean } = m;
        const sourceManifest = sourceChecks.find(c => c.key === layout.manifestKey(prefix))!;
        add(layout.manifestKey(prefix), JSON.stringify(clean), 'application/json', sourceManifest.key, sourceManifest.sha256);
        add(layout.byIdKey(id), pointer.body, 'application/json', layout.byIdKey(id), copyHash(pointer.body));
        add(layout.byUrlKey(m.url_hash), byUrl.body, 'application/json', layout.byUrlKey(m.url_hash), copyHash(byUrl.body));
    });
    const targetRecords: { sourceId: string; url: string; title?: string; contentSha256: string; markdownBlob: string; action: string; stagingId?: string }[] = [];
    await each(targets, async target => {
        const { m, prefix } = manifests.get(target.id)!;
        if (m.content_status !== 'captured' || m.content_sha256 !== target.contentSha256)
            throw Error('Target content hash/state changed');
        const raw = await sourceRead(layout.rawKey(prefix, rawExt(m.content_type)));
        if (copyHash(raw.body) !== m.content_sha256)
            throw Error('Target raw hash changed');
        const markdown = await sourceRead(layout.extractedKey(prefix));
        if (m.extracted_bytes !== undefined && markdown.body.byteLength !== m.extracted_bytes)
            throw Error('Target Markdown size changed');
        if (target.markdownSha256 && copyHash(markdown.body) !== target.markdownSha256)
            throw Error('Target Markdown hash changed');
        targetRecords.push({ sourceId: target.id, url: m.url, title: m.title, contentSha256: m.content_sha256, markdownBlob: blob(markdown.body), action: ids.includes(target.id) ? 'reprocess' : 'import', ...(ids.includes(target.id) ? { stagingId: target.id } : {}) });
    });
    objects.sort((a,b)=>a.key.localeCompare(b.key));
    targetRecords.sort((a,b)=>targets.findIndex(t=>t.id===a.sourceId)-targets.findIndex(t=>t.id===b.sourceId));
    const additions = ids.map(id => { const { m, prefix } = manifests.get(id)!; const { last_attempt: _last, ...clean } = m; return manifestToIndexItem(clean, prefix); });
    const merged = ListIndexSchema.parse({ version: 1, items: [...existing.items, ...additions].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)) });
    return { sourceProjection: 'applyStaleness/900s; omit historical attempts/checkpoints', format: 'reading-lite-staging-context-v1' as const, createdAt: input.now, source: { bucket: 'reading-lite', tenant: sourceTenant, index: 'reading-lite' }, destination: { bucket: 'reading-lite-staging', tenant: destinationTenant, index: 'reading-lite-staging' }, objects, vectors, metadataDrift, readingIds: ids,
        sourceChecks: [...new Map(sourceChecks.map(c => [c.key, c])).values()].map(c => ({ ...c, key: `u/${sourceTenant}/${c.key}` })),
        list: { key: `u/${destinationTenant}/${layout.listIndexKey()}`, expectedEtag: list.etag, expectedSha256: copyHash(list.body), blob: blob(JSON.stringify(merged)), preservedRows: existing.items.length, addedRows: ids.length }, targets: targetRecords,
        applyOrder: ['revalidate source hashes, destination absence, active tenant, disabled paid work, and sole-writer window', 'insert missing staging vector-ledger rows (refuse deleting/submitted rows)', 'create content/manifests with If-None-Match:*', 'upsert and verify staging vectors; never delete production or legacy vectors', 'create ownership pointers with If-None-Match:*', 'CAS list against expected ETag; never overwrite a changed list'],
        blobs };
}
