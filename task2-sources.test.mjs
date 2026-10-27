import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import {join,resolve,dirname,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {openMemoryStore} from './db.js'
import {syncSourceCatalog,validateSourceSnapshot} from './sources.js'
const parseFilename=name=>{const m=/^session(?:\.v([1-9][0-9]*))?\.jsonl$/.exec(name);return m?Number(m[1]??0):undefined}
async function fixture(t){
 const root=await fs.mkdtemp(join(tmpdir(),'dsh-memory-sources-'));const logs=join(root,'logs');await fs.mkdir(join(logs,'project','fork'),{recursive:true})
 const db=openMemoryStore(join(root,'state.sqlite'));t.after(async()=>{db.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('dsh-memory-sources-'));await fs.rm(resolve(root),{recursive:true})})
 const header={id:'fork',version:4,createdAt:1,isSeeded:false,delegationDepth:0,parentSession:'parent',cwd:'/synthetic'}
 const path=join(logs,'project','fork','session.v4.jsonl');await fs.writeFile(path,'synthetic, not decoded by catalog');await fs.utimes(path,100,100)
 let records=[{header,live:false,persisted:true}]
 const ctx={sessions:{get(){return undefined}},workspaceRegistry:{archivedSessionIds:new Set(['fork'])},sessionQuery:{listSessions:async()=>records},sessionPersistence:{locate(h){return {kind:'jsonl',path:join(logs,'project',h.id,'session.v4.jsonl')}},list:async()=>records.map(x=>({header:x.header,revision:'opaque:without-a-timestamp'})),stat:async()=>({header,revision:'opaque:without-a-timestamp'})}}
 return {root,logs,db,header,path,ctx,setRecords:r=>{records=r}}
}
test('catalog preserves fork/archived identity, native mtime and immutable snapshot validation',async t=>{
 const {db,ctx,path}=await fixture(t);const result=await syncSourceCatalog(ctx,db,{parseFilename})
 assert.equal(result.certain,true);const source=db.getSource('fork')
 assert.equal(source.parent_id,'parent');assert.equal(source.archived,1);assert.equal(source.source_updated_at_ms,100000)
 assert.equal(source.snapshot.kind,'v4');assert.equal(await validateSourceSnapshot(ctx,source.snapshot,{parseFilename}),true)
 await fs.appendFile(path,'changed');assert.equal(await validateSourceSnapshot(ctx,source.snapshot,{parseFilename}),false)
})
test('bad/unattributable physical directory prevents false deletion',async t=>{
 const {db,ctx,logs,setRecords}=await fixture(t);await syncSourceCatalog(ctx,db,{parseFilename});setRecords([])
 await fs.mkdir(join(logs,'project','unknown-bad-session'))
 const result=await syncSourceCatalog(ctx,db,{parseFilename});assert.equal(result.certain,false);assert.equal(db.getSource('fork').presence,'present')
 const bad=resolve(logs,'project','unknown-bad-session'),old=resolve(logs,'project','fork')
 assert.equal(dirname(bad),join(logs,'project'));assert.equal(dirname(old),join(logs,'project'))
 await fs.rmdir(bad);await fs.rm(old,{recursive:true})
 assert.equal((await syncSourceCatalog(ctx,db,{parseFilename})).certain,true);assert.equal(db.getSource('fork').presence,'missing')
})
test('newest future generation and duplicate identities never fall back to old v4',async t=>{
 const {db,ctx,logs}=await fixture(t);await fs.writeFile(join(logs,'project','fork','session.v5.jsonl'),'future')
 await syncSourceCatalog(ctx,db,{parseFilename});assert.equal(db.getSource('fork').read_status,'unsupported')
 await fs.mkdir(join(logs,'second-project','fork'),{recursive:true});await fs.writeFile(join(logs,'second-project','fork','session.v4.jsonl'),'duplicate')
 assert.equal((await syncSourceCatalog(ctx,db,{parseFilename})).certain,false);assert.equal(db.getSource('fork').read_status,'conflict')
})
