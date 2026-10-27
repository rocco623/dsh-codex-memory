import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,mkdirSync,symlinkSync,utimesSync} from 'node:fs'
import {join,resolve,dirname,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {createMemoryPipeline} from './pipeline.js'
import {normalizeOptions} from './config.js'
import {parseMemoryCitation} from './citations.js'
const native=process.versions.electron?createRequire(import.meta.url)('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm'):null
const valid="v1\n\n## User Profile\nprofile\n\n## User preferences\npreferences\n\n## General Tips\ntips\n\n## What's in Memory\n- supported\n"
test('only genuine outer citation bodies count and ranges are strict u32',()=>{
 assert.equal(parseMemoryCitation(['<rollout_ids>session-one</rollout_ids>']),null)
 const value=parseMemoryCitation(['<oai-mem-citation><citation_entries>a.md:1junk-2|note=[bad]\nb.md:+1-4294967295|note=[good]\nc.md:1-4294967296|note=[bad]</citation_entries><rollout_ids>session-one</rollout_ids></oai-mem-citation>text<oai-mem-citation><rollout_ids>session-two\nsession-one</rollout_ids></oai-mem-citation>'])
 assert.deepEqual(value.rolloutIds,['session-one','session-two']);assert.equal(value.entries.length,1)
 assert.equal(value.entries[0].lineEnd,4294967295)
})
function fixture(t,{llm,options={},codec={},parseFilename=()=>undefined}={}){
 const home=mkdtempSync(join(tmpdir(),'dsh-memory-task5-')),events=[]
 const session={id:'current',header:{id:'current',createdAt:0,version:4},seq:0,snapshotEvents:()=>events}
 const ctx={llm,sessions:{get:id=>id==='current'?session:undefined},sessionQuery:{listSessions:async()=>[{header:session.header,live:true,persisted:false}]},workspaceRegistry:{archivedSessionIds:[]}}
 const messages=[];const pipeline=createMemoryPipeline(ctx,{home,readOptions:()=>normalizeOptions({stage2ReasoningEffort:'high',phase2SuccessCooldownSeconds:0,...options}),runtime:native,codec,parseFilename,report:(...x)=>messages.push(x)})
 t.after(async()=>{await pipeline.stop();assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('dsh-memory-task5-'));rmSync(resolve(home),{recursive:true})})
 return {pipeline,session,home,messages,ctx,events}
}
test('fresh mode snapshot survives resume and citations are replay-idempotent',{skip:!native},t=>{
 const {pipeline,session}=fixture(t);pipeline.handleCreated({agent:{session},source:'startup'})
 assert.equal(pipeline.store.getSource('current').mode_origin,'creation')
 pipeline.store.setSourceMode('current','disabled')
 pipeline.handleCreated({agent:{session},source:'resume'})
 assert.equal(pipeline.store.getSource('current').memory_mode,'disabled')
 const citation={type:'assistant/message',seq:1,data:{message:{id:'answer',content:[{type:'text',text:'<oai-mem-citation><rollout_ids>current</rollout_ids></oai-mem-citation>'}]}}}
 pipeline.handleEvent(session,citation);pipeline.handleEvent(session,citation)
 assert.equal(pipeline.store.db.prepare('SELECT COUNT(*) AS n FROM citation_messages').get().n,1)
})
test('confirmed reset preserves modes, clears generated files and does not follow symlinks',{skip:!native},t=>{
 const {pipeline,session,home}=fixture(t);pipeline.handleCreated({agent:{session},source:'startup'})
 mkdirSync(pipeline.memoryRoot,{recursive:true});writeFileSync(join(pipeline.memoryRoot,'memory_summary.md'),valid)
 const outside=join(home,'outside');writeFileSync(outside,'keep');symlinkSync(outside,join(pipeline.memoryRoot,'outside-link'))
 assert.throws(()=>pipeline.reset('wrong'),e=>e.code==='invalid_confirmation')
 pipeline.reset('clear-v2-memory')
 assert.equal(existsSync(join(pipeline.memoryRoot,'memory_summary.md')),false)
 assert.equal(readFileSync(outside,'utf8'),'keep');assert.equal(pipeline.store.getSource('current').memory_mode,'enabled')
})
function model(replies){
 const requests=[]
 return {requests,async prepareCall(config,signal,configure){
  const info={context:{contextWindow:100000},reasoning:{efforts:[{id:'low'},{id:'high'}]}}
  const controls=configure({},info)
  return {config:{...config,...controls},context:info.context,stream(request){requests.push(request);return(async function*(){const response=replies.shift();if(!response)throw new Error('unexpected request');yield*response})()}}
 }}
}
const final=[{type:'text-delta',index:0,text:'done'},{type:'finish',reason:{kind:'stop'}}]
const summaryCall=[{type:'block-end',index:0,block:{type:'tool-call',id:'synthetic-write',name:'memory_workspace_write',arguments:JSON.stringify({path:'memory_summary.md',content:valid})}},{type:'finish',reason:{kind:'tool-calls'}}]
test('whole consolidation publishes one baseline and runs again in the same session without re-sampling unchanged files',{skip:!native},async t=>{
 const llm=model([summaryCall,final]),{pipeline,messages}=fixture(t,{llm})
 await pipeline.run({sessionId:'current',route:{provider:'synthetic',model:'synthetic'}})
 assert.equal(readFileSync(join(pipeline.memoryRoot,'memory_summary.md'),'utf8'),valid,JSON.stringify(messages))
 assert.equal(pipeline.status().jobs[0].status,'done');assert.equal(pipeline.status().progress.max_thread_count,0)
 await pipeline.run({sessionId:'current',route:{provider:'synthetic',model:'synthetic'}})
 assert.equal(llm.requests.length,2,JSON.stringify(messages));assert.equal(pipeline.status().jobs[0].status,'done')
})
test('known fresh creation overrides a raced legacy bootstrap default but never a user mode',{skip:!native},t=>{
 const {pipeline,session}=fixture(t,{options:{generateMemories:false}})
 pipeline.store.initializeSource(session.header)
 pipeline.handleCreated({agent:{session},source:'startup'})
 assert.equal(pipeline.store.getSource('current').memory_mode,'disabled')
 pipeline.store.setSourceMode('current','enabled')
 pipeline.handleCreated({agent:{session},source:'startup'})
 assert.equal(pipeline.store.getSource('current').memory_mode,'enabled')
})
test('v4 extraction and consolidation preserve original log bytes',{skip:!native},async t=>{
 const require=createRequire(import.meta.url),root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/'
 const codec=require(root+'dsh-session-format-v3-to-v4').releasedV4SessionFormatCodec,parseFilename=require(root+'dsh-session-format').parseSessionFormatLogFilename
 const extract=[{type:'block-end',index:0,block:{type:'tool-call',id:'synthetic-output',name:'memory_stage1_write_output',arguments:JSON.stringify({rollout_summary:'synthetic retained evidence',rollout_slug:'synthetic'})}},{type:'finish',reason:{kind:'tool-calls'}}]
 const llm=model([extract,summaryCall,final]),{pipeline,home,ctx,session,messages}=fixture(t,{llm,codec,parseFilename})
 const time=Date.now()-7*3600000,header={version:4,id:'old-source',createdAt:time-1000,isSeeded:false,delegationDepth:0,cwd:'/synthetic'}
 const event={seq:0,time,type:'user/message',data:native.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'synthetic original evidence'}]})}
 const path=join(home,'logs','project',header.id,'session.v4.jsonl');mkdirSync(dirname(path),{recursive:true})
 const bytes=JSON.stringify(codec.encodeHeader(header,0))+'\n'+JSON.stringify(codec.encodeEvent(event))+'\n';writeFileSync(path,bytes);utimesSync(path,new Date(time),new Date(time))
 const persisted={header,revision:'opaque-version',sizeBytes:Buffer.byteLength(bytes)}
 ctx.sessionPersistence={locate:h=>({kind:'jsonl',path:join(home,'logs','project',h.id,'session.v4.jsonl')}),list:async()=>[persisted],stat:async id=>id===header.id?persisted:undefined}
 ctx.sessionQuery.listSessions=async()=>[{header:session.header,live:true,persisted:false},{header,live:false,persisted:true}]
 await pipeline.run({sessionId:'current',route:{provider:'synthetic',model:'synthetic'}})
 assert.equal(llm.requests.length,3,JSON.stringify(messages));assert.match(llm.requests[0].messages.map(x=>x.content[0].text).join(''),/synthetic original evidence/)
 assert.equal(pipeline.store.db.prepare('SELECT rollout_summary FROM stage1_outputs').get().rollout_summary,'synthetic retained evidence')
 assert.equal(pipeline.status().progress.max_thread_count,1);assert.equal(readFileSync(path,'utf8'),bytes)
})
