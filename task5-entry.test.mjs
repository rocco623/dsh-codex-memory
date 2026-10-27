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
 return {home,ctx,config,call,tools,sections,logs,effects,handlers,get streamCalls(){return streamCalls}}
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

test('config rejects values outside native ranges before saving',{skip:!target},async t=>{
 const f=await fixture(t)
 for(const [key,value] of [['maxRawMemoriesForConsolidation',0],['maxRawMemoriesForConsolidation',4097],['maxRolloutsPerStartup',0],['maxRolloutsPerStartup',129],['minRolloutIdleHours',0],['minRolloutIdleHours',49],['maxUnusedDays',366],['maxRolloutAgeDays',91]])assert.equal((await f.call('/config',{values:{[key]:value}})).status,400,key)
 const saved=await f.call('/config',{values:{maxRawMemoriesForConsolidation:4096,maxRolloutsPerStartup:128,minRolloutIdleHours:48,maxUnusedDays:365,maxRolloutAgeDays:90}})
 assert.equal(saved.status,200);assert.equal(saved.values.maxRawMemoriesForConsolidation,4096)
})
test('shutdown cancels config validation before persistent save',{skip:!target},async t=>{
 const f=await fixture(t);let entered,release,receivedSignal
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),prepare=f.ctx.llm.prepareCall
 f.ctx.llm.prepareCall=async function(config,signal,...rest){receivedSignal=signal;entered();await new Promise((resolve,reject)=>{gate.then(resolve);signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})});return prepare.call(this,config,signal,...rest)}
 const request=f.call('/config',{values:{stage1Provider:'p',stage1Model:'m'}});await started
 const stopping=f.effects[0]();release();const result=await request;await stopping
 assert.equal(receivedSignal?.aborted,true);assert.equal(result.error,'disposed');assert.equal(f.config.stage1Provider.get(),undefined)
})
test('enable retains external events after its observed cursor',{skip:!target},async t=>{
 const f=await fixture(t),{openMemoryStore}=await import('./db.js'),store=openMemoryStore(join(f.home,'memory_state.db'))
 try{
  store.initializeSource({id:'race',createdAt:0},{fresh:true,disableOnExternalContext:true});store.setSourceMode('race','polluted',{eventSeq:1})
  let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
  f.ctx.sessionQuery.observeSession=async()=>{entered();await gate;return {cursor:1,[Symbol.dispose](){}}}
  const request=f.call('/thread-mode',{thread_id:'race',mode:'enabled'});await started
  for(const handler of f.handlers.get('session/event'))handler({id:'race'},{type:'tool/call',seq:2,data:{name:'web_fetch'}})
  release();assert.equal((await request).status,200);assert.equal(store.getSource('race').memory_mode,'polluted');assert.equal(store.getSource('race').mode_event_seq,2)
 }finally{store.close()}
})

test('shutdown drains metadata and observation services that ignore cancellation',{skip:!target},async t=>{
 for(const kind of ['capabilities','thread-mode'])await t.test(kind,async t=>{
  const f=await fixture(t),{openMemoryStore}=await import('./db.js'),store=openMemoryStore(join(f.home,'memory_state.db'))
  let entered,release,signal,disposed=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
  try{
   store.initializeSource({id:'drain',createdAt:0});store.setSourceMode('drain','disabled')
   f.ctx.llm.resolveModelInfo=async(p,m,s)=>{signal=s;entered();await gate;return {}}
   f.ctx.sessionQuery.observeSession=async(id,options)=>{signal=options.signal;entered();await gate;return {cursor:1,[Symbol.dispose](){disposed++}}}
   const request=kind==='capabilities'?f.call('/capabilities?provider=p&model=m'):f.call('/thread-mode',{thread_id:'drain',mode:'enabled'})
   await started;let stopped=false;const stopping=f.effects[0]().then(()=>{stopped=true})
   await Promise.resolve();assert.equal(signal.aborted,true);assert.equal(stopped,false)
   release();assert.equal((await request).error,'disposed');await stopping
   assert.equal(disposed,kind==='thread-mode'?1:0);assert.equal(store.getSource('drain').memory_mode,'disabled')
  }finally{release?.();store.close()}
 })
})
test('shutdown drains a pending editor and rejects a late configuration callback',{skip:!target},async t=>{
 const f=await fixture(t),get=f.ctx.get;let entered,release
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 f.ctx.get=name=>{const value=get(name);if(name!=='configEditor')return value;return {async edit(...args){entered();await gate;return value.edit(...args)}}}
 const request=f.call('/config',{values:{generateMemories:false}});await started
 let stopped=false;const stopping=f.effects[0]().then(()=>{stopped=true});await Promise.resolve();assert.equal(stopped,false)
 release();assert.equal((await request).error,'disposed');await stopping;assert.equal(f.config.generateMemories.get(),undefined)
})
