import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {normalizeOptions,stageRoute,configOrigins} from './config.js'
import {createMemoryDriver,estimateHistoryTokens,dropOldestItem,buildCompactedHistory,COMPACT_PROMPT,COMPACT_PREFIX} from './model.js'
const native=process.versions.electron?createRequire(import.meta.url)('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm'):null
const options=normalizeOptions({stage2ReasoningEffort:'high'})
function mock(replies){
 const requests=[];let preparations=0
 const llm={async prepareCall(config,signal,configure){preparations++;signal?.throwIfAborted();const info={context:{contextWindow:100000},reasoning:{efforts:['off','low','high'],defaultEffort:'low'}}
  const proposed=configure?{...config,...configure({},info)}:config
  if(proposed.reasoningEffort&&!info.reasoning.efforts.includes(proposed.reasoningEffort))throw new native.LlmError('unsupported effort','INVALID_REASONING')
  return {config:proposed,context:info.context,retryPolicy:{mode:'normal',maxRetries:0,retryableCodes:['TRANSPORT'],initialDelayMs:1,maxDelayMs:1,jitterRatio:0},stream(request){requests.push(request);return (async function*(){const next=replies.shift();if(next instanceof Error)throw next;yield* next})()}}
 }}
 return {llm,requests,get preparations(){return preparations}}
}
const call=(name,args,id='call-1')=>[{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]
const text=value=>[{type:'text-delta',index:0,text:value},{type:'finish',reason:{kind:'stop'}}]
test('compact templates match fixed c260087 upstream blobs, including final newline',()=>{
 assert.equal(createHash('sha256').update(COMPACT_PROMPT).digest('hex'),'ab0c334d4faca17e3afbb9b16967c1b2fdcc7242a9a0880af57949fa236d6d07')
 assert.equal(createHash('sha256').update(COMPACT_PREFIX).digest('hex'),'e9b088e794a6bb9082ac053fcc760bd818d7e720ee4bcdc72c6e480de7b7cb0e')
})
test('new defaults and legacy empty/explicit route provenance are preserved',()=>{
 const defaults=normalizeOptions({});assert.equal(defaults.disableOnExternalContext,false);assert.equal(defaults.agentTimeoutMs,0)
 assert.equal(stageRoute(defaults,1,{provider:'p',model:'m'}).reasoningEffort,'low')
 assert.equal(stageRoute(defaults,2,{provider:'p',model:'m'}).reasoningEffort,'medium')
 assert.equal(stageRoute(normalizeOptions({stage1ReasoningEffort:''}),1,{provider:'p',model:'m',reasoningEffort:'high'}).reasoningEffort,'high')
 assert.equal(configOrigins({stage1ReasoningEffort:'low'}).stage1ReasoningEffort,'legacy')
 assert.throws(()=>normalizeOptions({stage1Provider:'p'}),e=>e.code==='INCOMPLETE_ROUTE')
})
test('model-visible estimation excludes transport ids and reasoning; pair removal is exact',()=>{
 const messages=[{id:'not-counted'.repeat(1000),role:'assistant',content:[{type:'tool-call',id:'c',name:'x',arguments:'{}'}]},{role:'tool',toolCallId:'c',content:[{type:'text',text:'out'}]}]
 assert.equal(estimateHistoryTokens('',[],messages),Math.ceil(Buffer.byteLength('functionsx{}')/4)+Math.ceil(Buffer.byteLength('cout')/4))
 assert.deepEqual(dropOldestItem(messages),[])
})
test('stage1 only declares its output tool and validates normal completion',{skip:!native},async()=>{
 const m=mock([call('memory_stage1_write_output',{rollout_summary:'summary',rollout_slug:'slug'})]),driver=createMemoryDriver(m.llm,native)
 const plan=await driver.prepare(1,options,{provider:'p',model:'m'})
 const result=await driver.extract(plan,{items:[{type:'message',role:'user',content:[{type:'input_text',text:'all evidence'}]}],rolloutPath:'synthetic',rolloutCwd:'/synthetic'})
 assert.equal(result.rolloutSummary,'summary');assert.deepEqual(m.requests[0].tools.map(x=>x.name),['memory_stage1_write_output'])
 assert.match(m.requests[0].messages.map(x=>x.content[0].text).join(''),/all evidence/)
 const bad=mock([[...call('memory_stage1_write_output',{rollout_summary:'x',rollout_slug:'y'}).slice(0,-1)]]),other=createMemoryDriver(bad.llm,native)
 await assert.rejects(other.extract(await other.prepare(1,options,{provider:'p',model:'m'}),{items:[]}),e=>e.code==='MEMORY_INCOMPLETE_RESPONSE')
})
test('unsupported codex Medium is rejected in preflight, never dispatched',{skip:!native},async()=>{
 const m=mock([]),driver=createMemoryDriver(m.llm,native)
 await assert.rejects(driver.prepare(2,normalizeOptions({}),{provider:'p',model:'m'}),e=>e.code==='INVALID_REASONING')
 assert.equal(m.requests.length,0)
})
test('private tool results are paired and an overflow compacts without replaying writes',{skip:!native},async()=>{
 const overflow=new native.LlmError('synthetic overflow','CONTEXT_WINDOW_EXCEEDED')
 const m=mock([call('memory_workspace_write',{path:'memory_summary.md',content:'synthetic'}),overflow,text('handoff summary'),text('done')]),driver=createMemoryDriver(m.llm,native)
 let writes=0;const tools={tools:[{name:'memory_workspace_write',parameters:{type:'object'}}],dispatch(){writes++;return {}}}
 await driver.consolidate(await driver.prepare(2,options,{provider:'p',model:'m'}),{system:'isolated',input:'consolidate',workspace:tools})
 assert.equal(writes,1);assert.equal(m.requests.length,4)
 assert.equal(m.requests[2].tools.length,0)
 assert.match(m.requests[3].messages.map(x=>x.content.map(b=>b.text??'').join('')).join(''),new RegExp(COMPACT_PREFIX.slice(0,20)))
 assert.equal(m.requests.every(x=>x.system==='isolated'),true)
})
test('compaction overflow trims only its working copy and non-window errors do not trim',{skip:!native},async()=>{
 const e=new native.LlmError('synthetic overflow','CONTEXT_WINDOW_EXCEEDED')
 const m=mock([e,e,text('checkpoint'),text('done')]),driver=createMemoryDriver(m.llm,native)
 await driver.consolidate(await driver.prepare(2,options,{provider:'p',model:'m'}),{system:'isolated',input:'original user',workspace:{tools:[],dispatch(){assert.fail()}}})
 assert.equal(m.requests[1].messages.length,2);assert.equal(m.requests[2].messages.length,1)
 assert.equal(m.requests[3].messages[0].content[0].text,'original user')
 const denied=mock([new native.LlmError('synthetic auth','AUTH')]),other=createMemoryDriver(denied.llm,native)
 await assert.rejects(other.consolidate(await other.prepare(2,options,{provider:'p',model:'m'}),{system:'x',input:'y',workspace:{tools:[]}}),e=>e.code==='AUTH')
 assert.equal(denied.requests.length,1)
})
test('native in-band context failure follows the same recovery path',{skip:!native},async()=>{
 const m=mock([[{type:'finish',reason:{kind:'error',failure:{code:native.CONTEXT_WINDOW_EXCEEDED_CODE,message:'synthetic'}}}],text('checkpoint'),text('done')])
 const driver=createMemoryDriver(m.llm,native)
 await driver.consolidate(await driver.prepare(2,options,{provider:'p',model:'m'}),{system:'isolated',input:'job',workspace:{tools:[]}})
 assert.equal(m.requests.length,3);assert.deepEqual(m.requests[1].tools,[])
})
test('native provider retries discard partial attempts and retain request identity',{skip:!native},async()=>{
 const m=mock([new native.LlmError('synthetic transport','TRANSPORT'),call('memory_stage1_write_output',{rollout_summary:'ok',rollout_slug:''})])
 const original=m.llm.prepareCall
 m.llm.prepareCall=async(...args)=>{const bound=await original(...args);return {...bound,retryPolicy:{...bound.retryPolicy,maxRetries:1}}}
 const driver=createMemoryDriver(m.llm,native)
 assert.equal((await driver.extract(await driver.prepare(1,options,{provider:'p',model:'m'}),{items:[]})).rolloutSummary,'ok')
 assert.equal(m.requests.length,2);assert.deepEqual(m.requests[0].messages,m.requests[1].messages)
})
test('20k retention uses native UTF8 token marker and excludes old checkpoints',{skip:!native},()=>{
 const user=native.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'界'.repeat(26668)}]})
 const old=native.createUserMessage({source:{kind:'memory-compaction'},content:[{type:'text',text:COMPACT_PREFIX+'\nold'}]})
 const history=buildCompactedHistory([user,old],'new',native)
 assert.equal(history.length,2)
 assert.equal(history[0].content[0].text,'界'.repeat(13333)+'…1 tokens truncated…'+'界'.repeat(13333))
 assert.equal(history[1].content[0].text,COMPACT_PREFIX+'\nnew')
})
test('cancellation before dispatch never starts a model or writes a tool',{skip:!native},async()=>{
 const m=mock([]),driver=createMemoryDriver(m.llm,native),controller=new AbortController()
 const plan=await driver.prepare(2,options,{provider:'p',model:'m'});controller.abort(new Error('synthetic cancel'))
 await assert.rejects(driver.consolidate(plan,{system:'x',input:'y',workspace:{tools:[],dispatch(){assert.fail()}}},{signal:controller.signal}),/synthetic cancel/)
 assert.equal(m.requests.length,0)
})
test('failed stream close is not hidden by cancellation',{skip:!native},async()=>{
 const m=mock([]),controller=new AbortController(),original=m.llm.prepareCall
 m.llm.prepareCall=async(...args)=>({...await original(...args),stream(){return {[Symbol.asyncIterator](){return {async next(){controller.abort(new Error('synthetic cancel'));return {done:false,value:{type:'finish',reason:{kind:'stop'}}}},async return(){throw new Error('synthetic close failure')}}}}}})
 const driver=createMemoryDriver(m.llm,native),plan=await driver.prepare(2,options,{provider:'p',model:'m'})
 await assert.rejects(driver.consolidate(plan,{system:'x',input:'y',workspace:{tools:[]}},{signal:controller.signal}),e=>e.code==='MEMORY_STREAM_CLOSE_FAILED'&&e.cause?.message==='synthetic close failure')
})
