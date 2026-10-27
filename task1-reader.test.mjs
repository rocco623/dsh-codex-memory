import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { zstdCompressSync } from 'node:zlib'
import { readEvidenceSnapshot, normalizeSessionEvents } from './sessions.js'
const validateVersion=async()=>true
import { readRecentRolloutItems, MAX_RECORD_BYTES, MAX_ROLLOUT_BYTES, serializeRolloutItem, serializeTieredInput } from './rollout-input.js'
import { decodeZstdStream, decodeZstdFrames } from './zstd.js'
const msg=text=>({type:'message',role:'user',content:[{type:'input_text',text}]})
const header={version:4,id:'synthetic-child',createdAt:0,isSeeded:false,delegationDepth:0,parentSession:'synthetic-parent'}
async function temporary(body) {
 const directory=await mkdtemp(join(tmpdir(),'dsh-memory-task1-test-'))
 try {return await body(directory)} finally {
  const absolute=resolve(directory)
  assert.equal(dirname(absolute),resolve(tmpdir()));assert.ok(basename(absolute).startsWith('dsh-memory-task1-test-'))
  await rm(absolute,{recursive:true,force:true})
 }
}
const meta=JSON.stringify({timestamp:'2026-10-12T00:00:00Z',type:'session_meta',payload:{id:'synthetic-child'}})+'\n'
const row=item=>JSON.stringify({timestamp:'2026-10-12T00:00:00Z',type:'response_item',payload:item})+'\n'
test('native recent scan record limit and 8MiB sanitizer-before-cost boundary',()=>temporary(async directory=>{
 const path=join(directory,'canonical.jsonl')
 const large=msg('older evidence'.repeat(20000)),cost=Buffer.byteLength(serializeRolloutItem(large))
 const history=row(large).repeat(Math.floor(MAX_ROLLOUT_BYTES/cost)+2)
 const latest=[msg('recent question'),msg('latest correction 🦀')]
 await writeFile(path,meta+history+'x'.repeat(MAX_RECORD_BYTES+1)+'\n'+row(latest[0])+Buffer.from([255]).toString('latin1')+'\n'+row(latest[1]))
 const result=await readRecentRolloutItems(path)
 assert.deepEqual(result.items.slice(-2).map(x=>x.payload),latest)
 const retained=result.items.reduce((n,x)=>n+Buffer.byteLength(serializeRolloutItem(x.payload)),0)
 assert.ok(retained<=MAX_ROLLOUT_BYTES);assert.ok(retained+cost>MAX_ROLLOUT_BYTES)
 // Raw >1MiB is skipped even though sanitizing would make it small.
 await writeFile(path,meta+row({...msg('small'),encrypted_content:'x'.repeat(MAX_RECORD_BYTES)})+row(msg('new')))
 assert.deepEqual((await readRecentRolloutItems(path)).items.map(x=>x.payload),[msg('new')])
 // Under record cap, encrypted content is removed before charging the 8MiB window.
 await writeFile(path,meta+row({...msg('small'),encrypted_content:'x'.repeat(900000)}).repeat(12)+row(msg('new')))
 assert.equal((await readRecentRolloutItems(path)).items.length,13)
}))
test('canonical scanner rejects future header and skips invalid UTF8 evidence',()=>temporary(async directory=>{
 const path=join(directory,'canonical.jsonl')
 await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'synthetic-child',history_mode:'future'}})+'\n'+row(msg('new')))
 await assert.rejects(readRecentRolloutItems(path),/metadata/)
 const prefix=Buffer.from(meta+'{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"')
 const suffix=Buffer.from('"}]}}\n'+row(msg('valid')))
 await writeFile(path,Buffer.concat([prefix,Buffer.from([255]),suffix]))
 assert.equal((await readRecentRolloutItems(path)).items.length,1)
}))
test('8MiB scan stops at next over-budget record, never picks smaller older records',()=>temporary(async directory=>{
 const path=join(directory,'canonical.jsonl'),large=msg('A'.repeat(800000))
 await writeFile(path,meta+row(msg('must not backfill'))+row(large).repeat(11))
 const result=await readRecentRolloutItems(path)
 assert.equal(result.items.length,10)
 assert.ok(result.items.every(x=>x.payload.content[0].text!=='must not backfill'))
}))
test('multi-frame streamed zstd and strict truncated frame errors',async()=>{
 const frames=[zstdCompressSync(Buffer.from('first\n')),zstdCompressSync(Buffer.from('中🐈last\n'))]
 const joined=Buffer.concat(frames),chunks=[]
 async function* tiny(){for(let i=0;i<joined.length;i+=3)yield joined.subarray(i,i+3)}
 for await(const chunk of decodeZstdStream(tiny()))chunks.push(chunk)
 assert.equal(Buffer.concat(chunks).toString(),'first\n中🐈last\n')
 assert.equal(decodeZstdFrames(joined).toString(),'first\n中🐈last\n')
 assert.throws(()=>decodeZstdFrames(joined.subarray(0,-1)),/truncated/)
 await assert.rejects(async()=>{for await(const ignored of decodeZstdStream([joined.subarray(0,-1)]))void ignored},/truncated/)
})
test('exact leases retain fork identity, provenance, release and stale/read failures',()=>temporary(async directory=>{
 let disposed=0,reads=0
 const events=[{type:'user/message',seq:0,time:1,data:{id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'synthetic'}]}}]
 const sessionQuery={async observeSession(id,options){reads++;assert.equal(id,header.id);assert.equal(options.projectionMode,'none');return {header,events,cursor:0,revision:'opaque:one',[Symbol.dispose](){disposed++}}}}
 const snapshot={sessionId:header.id,kind:'exact',sourceVersion:'version:1',revision:'opaque:one',cursor:0}
 const result=await readEvidenceSnapshot(snapshot,{sessionQuery,validateVersion,tempRoot:directory})
 assert.equal(result.status,'ready');assert.equal(result.metadata.parentSession,'synthetic-parent');assert.equal(disposed,1)
 assert.equal(result.provenance[0].messageId,'u');assert.equal(result.provenance[0].seq,0)
 assert.deepEqual(await readdir(directory),[])
 const stale=await readEvidenceSnapshot({...snapshot,revision:'different'},{sessionQuery,validateVersion,tempRoot:directory})
 assert.equal(stale.status,'stale');assert.equal(disposed,2)
 const bad=await readEvidenceSnapshot(snapshot,{sessionQuery:{observeSession(){throw new Error('synthetic IO failure')}},validateVersion,tempRoot:directory})
 assert.equal(bad.status,'read_failed');assert.ok(bad.error.cause);assert.deepEqual(await readdir(directory),[])
 const controller=new AbortController();controller.abort(new Error('synthetic cancellation'))
 const canceled=await readEvidenceSnapshot(snapshot,{sessionQuery,validateVersion,tempRoot:directory,signal:controller.signal})
 assert.equal(canceled.status,'read_failed');assert.equal(reads,2);assert.deepEqual(await readdir(directory),[])
}))
test('exact public rc3 v4 codec, multi-frame source immutability and cleanup',{skip:!process.versions.electron},()=>temporary(async directory=>{
 const require=createRequire(import.meta.url),root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/'
 const codec=require(root+'dsh-session-format-v3-to-v4').releasedV4SessionFormatCodec
 const {assembleAssistantStream,fileHandleText}=require(root+'dsh-llm')
 const events=[{type:'user/message',seq:0,time:1,data:{id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'合成 user'}]}},{type:'assistant/message',seq:1,time:2,data:{turn:0,step:0,interrupted:true,message:{id:'a',role:'assistant',source:{kind:'model',provider:'synthetic',model:'synthetic'},content:[{type:'text',text:'合成 final 🐈'}]},stream:[]}}]
 events[0].data.content.push({type:'file',attachment:{attachmentId:'sha256:'+'a'.repeat(64),name:'synthetic.xlsx',bytes:42,mediaType:'application/octet-stream'}})
 const raw=Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(codec.encodeHeader(header,0))+'\n')),zstdCompressSync(Buffer.from(events.map(e=>JSON.stringify(codec.encodeEvent(e))+'\n').join('')))])
 const path=join(directory,'synthetic.jsonl.zstd'),tempRoot=join(directory,'tmp');await mkdir(tempRoot);await writeFile(path,raw)
 const result=await readEvidenceSnapshot({kind:'v4',sessionId:header.id,sourceVersion:'synthetic:1',path},{codec,assembleAssistantStream,fileHandleText,validateVersion,tempRoot})
 assert.equal(result.status,'ready',result.error?.stack);assert.equal(result.items.length,2)
 assert.match(serializeTieredInput(result.items,3000),/assistant final/)
 assert.match(result.items[0].payload.content[1].text,/synthetic\.xlsx/)
 assert.match(result.items[0].payload.content[1].text,/42 bytes, sha256:aaaaaaaa/)
 assert.deepEqual(await readFile(path),raw);assert.deepEqual(await readdir(tempRoot),[])
 // A future header cannot silently fall back to an older generation.
 const future=join(directory,'future.jsonl');await writeFile(future,JSON.stringify({...codec.encodeHeader(header,0),version:5})+'\n')
 assert.equal((await readEvidenceSnapshot({kind:'v4',sessionId:header.id,path:future},{codec,assembleAssistantStream,fileHandleText,validateVersion,tempRoot})).status,'unsupported')
}))
