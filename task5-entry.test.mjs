import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks,createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Readable} from 'node:stream'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs'
import {join,resolve,dirname,basename} from 'node:path'
import {tmpdir} from 'node:os'
const target=!!process.versions.electron
let plugin,native,schema,cosmo,core
if(target){
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',require=createRequire(root+'/package.json')
 registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(!specifier.startsWith('@deepseek-ai/'))throw error;return {url:pathToFileURL(require.resolve(specifier)).href,shortCircuit:true}}}})
 plugin=await import('./index.js');native=require('@deepseek-ai/dsh-llm');schema=require('@deepseek-ai/dsh-tools');cosmo=require('@deepseek-ai/cosmokit');core=require('@deepseek-ai/cordis')
}
async function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'dsh-memory-entry-')),previous=process.env.DSH_HOME
 process.env.DSH_HOME=home
 const effects=[],handlers=new Map(),tools=new Map(),sections=[],logs=[];let route,streamCalls=0
 const config=core.resolveConfig(plugin,{})
 const ctx={logger:{warn:(...x)=>logs.push(x),info:(...x)=>logs.push(x)},fiber:{entry:{}},agents:{},sessions:{get:()=>undefined},
  sessionPersistence:{locate:h=>({kind:'jsonl',path:join(home,'logs','project',h.id,'session.v4.jsonl')}),list:async()=>[]},
  sessionQuery:{listSessions:async()=>[],observeSession:async id=>({header:{id},cursor:0,[Symbol.dispose](){}})},
  on(event,handler){const list=handlers.get(event)??[];list.push(handler);handlers.set(event,list)},
  effect(create){const dispose=create();if(dispose)effects.push(dispose);return dispose},
  inject(names,callback){callback(ctx)},
  systemPrompt:{section(value){sections.push(value)}},
  tools:{register(tool){try{schema.assertSupportedJsonSchema(tool.parameters);schema.assertSupportedJsonSchema(tool.output.schema)}catch(error){logs.push({tool:tool.name,violations:error.violations,message:error.message});throw error};assert.equal(tools.has(tool.name),false);tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
  webServer:{register(value){route=value.handler;return()=>{route=undefined}}},
  llm:{async resolveModelInfo(){return {context:{contextWindow:100000},reasoning:{efforts:[{id:'off'},{id:'low'},{id:'high'}],defaultEffort:'low'}}},async prepareCall(selection,signal,configure){const info=await this.resolveModelInfo();const result={...selection,...configure({},info)};if(result.reasoningEffort&&!info.reasoning.efforts.some(x=>x.id===result.reasoningEffort))throw new native.LlmError('unsupported','UNSUPPORTED_REASONING_EFFORT');return {config:result,stream(){streamCalls++;throw new Error('real model dispatch forbidden in entry tests')}}}},
  get(name){if(name==='configEditor')return {async edit(entry,update){const next=core.resolveConfig(plugin,update());for(const key of Object.keys(next))cosmo.updateVolatile(config[key],next[key]);for(const fn of handlers.get('loader/volatile-update')??[])fn()}}},
 }
 plugin.apply(ctx,config)
 t.after(async()=>{for(const dispose of effects.reverse())await dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('dsh-memory-entry-'));rmSync(resolve(home),{recursive:true})})
 const call=async(path,body,headers={})=>{
  const request=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);request.url='/dsh-codex-memory'+path;request.method=body===undefined?'GET':'POST';request.headers={host:'127.0.0.1:4321','content-type':'application/json',...headers}
  let status,value;const response={writeHead(code){status=code},end(data){value=JSON.parse(data)}}
  await route(request,response);return {status,...value}
 }
 return {home,ctx,config,call,tools,sections,logs,get streamCalls(){return streamCalls}}
}
test('native entry preserves absent defaults, gates schemas and rejects malformed or unsupported settings',{skip:!target},async t=>{
 const f=await fixture(t),initial=await f.call('/config')
 assert.equal(initial.values.stage2ReasoningEffort,'codex');assert.equal(initial.origins.stage2ReasoningEffort,'default');assert.equal(f.tools.size,0)
 assert.equal((await f.call('/config',{})).status,400)
 assert.equal((await f.call('/config',{values:{...initial.values,agentTimeoutMs:4294967296}})).status,400)
 assert.equal((await f.call('/config')).values.agentTimeoutMs,0)
 assert.equal((await f.call('/config',{values:{stage1Provider:'synthetic'}})).status,400)
 const rejected=await f.call('/config',{values:{...initial.values,stage2Provider:'p',stage2Model:'m'}})
 assert.equal(rejected.error,'UNSUPPORTED_REASONING_EFFORT')
 assert.equal((await f.call('/config')).values.stage2Provider,'')
 const saved=await f.call('/config',{values:{...initial.values,dedicatedTools:true}})
 assert.equal(saved.status,200,JSON.stringify({saved,logs:f.logs}));assert.equal(f.tools.size,5);assert.ok(f.tools.has('memory_add_ad_hoc_note'))
 assert.equal((await f.call('/config',{values:{...saved.values,useMemories:false}})).status,200);assert.equal(f.tools.size,0)
 assert.equal(f.streamCalls,0)
})
test('failed tool registration rolls back the whole set and allows retry',{skip:!target},async t=>{
 const f=await fixture(t),initial=await f.call('/config'),register=f.ctx.tools.register
 f.ctx.tools.register=tool=>{if(tool.name==='memory_note')throw Object.assign(new Error('synthetic collision'),{code:'DUPLICATE_TOOL'});return register(tool)}
 assert.equal((await f.call('/config',{values:{...initial.values,dedicatedTools:true}})).status,400)
 assert.equal(f.tools.size,0)
 f.ctx.tools.register=register
 assert.equal((await f.call('/config',{values:{...initial.values,dedicatedTools:true}})).status,200)
 assert.equal(f.tools.size,5)
})
test('busy reset reports 409 without clearing state',{skip:!target},async t=>{
 const f=await fixture(t),{openMemoryStore}=await import('./db.js'),store=openMemoryStore(join(f.home,'memory_state.db'))
 try{
  store.run("INSERT INTO jobs(kind,job_key,status,ownership_token,lease_until,retry_remaining,generation) VALUES('memory_consolidate_global','global','running','synthetic-review',?,3,0)",Math.floor(Date.now()/1000)+600)
  assert.equal((await f.call('/reset',{confirm:'clear-v2-memory'})).status,409)
  assert.equal(store.control().reset_pending,0)
 }finally{store.close()}
})
test('configuration readiness and status expose metadata without model dispatch',{skip:!target},async t=>{
 const f=await fixture(t),initial=await f.call('/config')
 assert.equal(initial.validation.stage1.state,'runtime');assert.equal(initial.validation.stage2.state,'runtime')
 const saved=await f.call('/config',{values:{...initial.values,stage1Provider:'p',stage1Model:'m',stage2Provider:'p',stage2Model:'m',stage2ReasoningEffort:'high'}})
 assert.equal(saved.status,200);assert.equal(saved.validation.stage2.state,'ready')
 const status=await f.call('/status');assert.equal(status.summary_valid,false);assert.equal(status.stage1_count,0);assert.equal(status.running_jobs,0);assert.equal(status.failed_jobs,0);assert.equal(typeof status.sources.total,'number');assert.equal(status.validation.stage2.state,'ready')
 f.ctx.llm.resolveModelInfo=async()=>({context:{contextWindow:100000},reasoning:{efforts:[{id:'low'}]}})
 const blocked=await f.call('/config');assert.equal(blocked.validation.stage2.state,'blocked');assert.equal(blocked.values.stage2ReasoningEffort,'high')
 assert.equal(f.streamCalls,0)
})
test('thread-mode accepts approved thread_id and rejects ambiguous aliases',{skip:!target},async t=>{
 const f=await fixture(t),{openMemoryStore}=await import('./db.js'),store=openMemoryStore(join(f.home,'memory_state.db'))
 try{
  store.initializeSource({id:'synthetic-mode',createdAt:0})
  assert.equal((await f.call('/thread-mode',{thread_id:'synthetic-mode',mode:'disabled'})).status,200)
  assert.equal(store.getSource('synthetic-mode').memory_mode,'disabled')
  assert.equal((await f.call('/thread-mode',{sessionId:'synthetic-mode',mode:'enabled'})).status,200)
  assert.equal((await f.call('/thread-mode',{thread_id:'synthetic-mode',sessionId:'synthetic-mode',mode:'enabled'})).status,400)
  assert.equal((await f.call('/thread-mode',{thread_id:'unknown',mode:'disabled'})).status,404)
 }finally{store.close()}
})
test('control API guards origin, JSON and confirmation; summary provider never appends user messages',{skip:!target},async t=>{
 const f=await fixture(t)
 assert.equal((await f.call('/config',{}, {origin:'http://untrusted.invalid'})).status,403)
 assert.equal((await f.call('/config','broken')).status,400)
 assert.equal((await f.call('/config',{}, {'content-type':'text/plain'})).status,415)
 const root=join(f.home,'memories_v2');mkdirSync(root)
 writeFileSync(join(root,'memory_summary.md'),'synthetic memory')
 assert.match(f.sections[0].text(),/synthetic memory/)
 assert.equal((await f.call('/reset',{confirm:'wrong'})).status,400);assert.ok(existsSync(join(root,'memory_summary.md')))
 assert.equal((await f.call('/reset',{confirm:'clear-v2-memory'})).status,200);assert.equal(existsSync(join(root,'memory_summary.md')),false)
 assert.equal(f.streamCalls,0)
})
