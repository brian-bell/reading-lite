import { describe, expect, it } from 'vitest';
import { stagingPrepareContextCommand, type PrepareContextDeps } from '../../../scripts/ops-lib/commands/staging-prepare-context';
import { vi } from 'vitest';
import { prepareContextCopy } from '../../../scripts/staging-lib/context-copy';
import { createHash } from 'node:crypto';
const source = 'usr_550e8400-e29b-41d4-a716-446655440000', destination = 'usr_550e8400-e29b-41d4-a716-446655440001';
const id = 'rd_0000000001', prefix = 'readings/2026/09/01T000000Z-' + id, url = 'https://example.com/article';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
    const m = { id, url, url_hash: hash(url), status: 'ready', title: 'Title', tldr: 'Summary', content_type: 'text/markdown', content_status: 'captured', content_bytes: 4, extracted_bytes: 4, content_sha256: hash('text'), created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z' };
    const files: Record<string, string> = { ['index/by-id/' + id]: JSON.stringify({ key_prefix: prefix }), ['index/by-url/' + hash(url)]: JSON.stringify({ id, key_prefix: prefix }), [prefix + '/manifest.json']: JSON.stringify(m), [prefix + '/raw.md']: 'text', [prefix + '/extracted.md']: 'text' };
    const dest: Record<string, string> = { 'index/list.json': JSON.stringify({ version: 1, items: [] }) };
    const readers = { ledgerIds: [] as string[], source: { read: async (k: string) => files[k] === undefined ? null : { body: Buffer.from(files[k]), etag: 'source-etag', contentType: 'text/plain' }, list: async (p: string) => Object.keys(files).filter(k => k.startsWith(p)) }, destination: { read: async (k: string) => dest[k] === undefined ? null : { body: Buffer.from(dest[k]), etag: 'list-etag', contentType: 'application/json' }, list: async (p: string) => Object.keys(dest).filter(k => k.startsWith(p)) }, vectors: async (ids: string[], staging: boolean) => staging ? [] : ids.map(id => ({ id, namespace: source, values: Array(1536).fill(0.1), metadata: { url, title: 'Title', tldr: 'Summary', tenant_id: source } })) };
    return { files, dest, readers };
}
describe('context copy artifact', () => {
    it('prepares staging-only identities, ledger-before-vector instructions, and CAS list without copying checkpoints', async () => {
        const f = fixture();
        f.files[prefix + '/processing/old.json'] = 'checkpoint';
        f.files[prefix + '/attempts/old.json'] = 'old';
        const p = await prepareContextCopy({ sourceTenant: source, destinationTenant: destination, ids: [id], targets: [{ id, contentSha256: hash('text') }], now: '2026-09-06T00:00:00.000Z' }, f.readers);
        expect(p.objects).toHaveLength(5);
        expect(p.objects.some(o => o.key.includes('processing'))).toBe(false);
        expect(p.vectors[0]).toMatchObject({ id: destination + ':' + id, namespace: destination, metadata: { tenant_id: destination } });
        expect(p.list.expectedEtag).toBe('list-etag');
        expect(p.targets[0].action).toBe('reprocess');
        expect(p.ledgerIds).toEqual([id]);
    });
    it('projects stale historical ready attempts like the API but refuses fresh active work',async()=>{
      const f=fixture();const key=prefix+'/manifest.json';const m=JSON.parse(f.files[key]!);
      m.active_attempt={id:'at_old',trigger:'reprocess',status:'running',started_at:'2026-06-18T19:20:07.533Z'};
      f.files[key]=JSON.stringify(m);
      const input={sourceTenant:source,destinationTenant:destination,ids:[id],targets:[],now:'2026-09-06T00:00:00Z'};
      const artifact=await prepareContextCopy(input,f.readers);
      const item=artifact.objects.find(o=>o.key.endsWith('manifest.json'))!;
      expect(JSON.parse(Buffer.from(artifact.blobs.get(item.blob)!).toString()).active_attempt).toBeUndefined();
      m.active_attempt.started_at='2026-09-05T23:59:00Z';f.files[key]=JSON.stringify(m);
      await expect(prepareContextCopy(input,f.readers)).rejects.toThrow('identity/state mismatch');
    });
    it('preserves existing list rows and binds the update to their observed ETag',async()=>{
      const f=fixture();const row={id:'rd_0000000002',key_prefix:'existing-prefix',url:'https://example.com/existing',status:'failed',created_at:'2026-08-01T00:00:00Z',tags:['keep']};
      f.dest['index/list.json']=JSON.stringify({version:1,items:[row]});
      const p=await prepareContextCopy({sourceTenant:source,destinationTenant:destination,ids:[id],targets:[],now:'2026-09-06T00:00:00Z'},f.readers);
      const list=JSON.parse(Buffer.from(p.blobs.get(p.list.blob)!).toString());
      expect(list.items).toContainEqual(row);expect(list.items).toHaveLength(2);expect(p.list.preservedRows).toBe(1);expect(p.list.expectedEtag).toBe('list-etag');
    });
    it('rejects same-size Markdown drift against a frozen cohort hash',async()=>{
      const f=fixture();f.files[prefix+'/extracted.md']='else';
      await expect(prepareContextCopy({sourceTenant:source,destinationTenant:destination,ids:[id],targets:[{id,contentSha256:hash('text'),markdownSha256:hash('text')}],now:'2026-09-06T00:00:00Z'},f.readers)).rejects.toThrow('Markdown hash changed');
    });
    it('refuses destination ownership or orphaned content before preparing a write', async () => {
        const f = fixture();
        f.dest[prefix + '/orphan'] = 'existing';
        await expect(prepareContextCopy({ sourceTenant: source, destinationTenant: destination, ids: [id], targets: [], now: '2026-09-06T00:00:00Z' }, f.readers)).rejects.toThrow('destination');
    });
    it('preserves the real production vector context and reports title/TLDR drift explicitly',async()=>{
      const f=fixture();const original=f.readers.vectors;
      f.readers.vectors=async(ids,staging)=>(await original(ids,staging)).map(v=>({...v,metadata:{...v.metadata,tldr:'Older indexed summary'}}));
      const p=await prepareContextCopy({sourceTenant:source,destinationTenant:destination,ids:[id],targets:[],now:'2026-09-06T00:00:00Z'},f.readers);
      expect(p.metadataDrift).toEqual([{id,title:false,tldr:true,copiedContext:'stored-vector'}]);
      expect(p.vectors[0]!.metadata.tldr).toBe('Older indexed summary');
    });
    it('refuses content drift and cross-namespace vectors', async () => {
        const f = fixture();
        f.files[prefix + '/raw.md'] = 'changed';
        await expect(prepareContextCopy({ sourceTenant: source, destinationTenant: destination, ids: [id], targets: [], now: '2026-09-06T00:00:00Z' }, f.readers)).rejects.toThrow('hash');
        const g = fixture();
        g.readers.vectors = async (ids) => ids.map(id => ({ id, namespace: destination, values: Array(1536).fill(1), metadata: { url, title: 'Title', tldr: 'Summary', tenant_id: source } }));
        await expect(prepareContextCopy({ sourceTenant: source, destinationTenant: destination, ids: [id], targets: [], now: '2026-09-06T00:00:00Z' }, g.readers)).rejects.toThrow('vector');
    });
    it('rejects unsafe IDs and same-tenant copies before any source access', async () => {
        const f = fixture();
        await expect(prepareContextCopy({ sourceTenant: source, destinationTenant: source, ids: [id], targets: [], now: '2026-09-06T00:00:00Z' }, f.readers)).rejects.toThrow();
        await expect(prepareContextCopy({ sourceTenant: source, destinationTenant: destination, ids: ['../escape'], targets: [], now: '2026-09-06T00:00:00Z' }, f.readers)).rejects.toThrow();
    });
});
describe('context preparation command boundaries', () => {
    function deps() { const f = fixture(); return { io: { stdout: vi.fn(), stderr: vi.fn() }, now: () => "2026-09-06T00:00:00Z", readInput: async () => ({ ids: [id], targets: [] }), readers: async () => f.readers, save: vi.fn() } satisfies PrepareContextDeps; }
    const args = ['--source-tenant', source, '--tenant', destination, '--input', 'selection.json'];
    it('default plan does not write a local packet', async () => { const d = deps(); expect(await stagingPrepareContextCommand.run(args, d)).toBe(0); expect(d.save).not.toHaveBeenCalled(); });
    it('execute materializes only the local artifact through its injected save seam', async () => { const d = deps(); expect(await stagingPrepareContextCommand.run([...args, '--execute', '--output-dir', 'private-packet'], d)).toBe(0); expect(d.save).toHaveBeenCalledOnce(); expect(d.io.stdout).toHaveBeenCalledWith(expect.stringContaining('"remoteWrites": 0')); });
    it('refuses an output directory without explicit local execution', async () => { const d = deps(); await expect(stagingPrepareContextCommand.run([...args, '--output-dir', 'private-packet'], d)).rejects.toThrow(); expect(d.save).not.toHaveBeenCalled(); });
});
