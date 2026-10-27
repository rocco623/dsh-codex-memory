import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {stageRoute} from './config.js'
import {serializeTieredInput,stage1TokenBudget,extractionChunks,truncateMiddle,serdeJson} from './rollout-input.js'
import {buildStageOneInput,stageOneSystemPrompt} from './prompts.js'
import {redactSecrets} from './redact.js'

export const COMPACT_PROMPT=readFileSync(new URL('./templates/compact/prompt.md',import.meta.url),'utf8')
export const COMPACT_PREFIX=readFileSync(new URL('./templates/compact/summary_prefix.md',import.meta.url),'utf8')
const error=(code,cause)=>Object.assign(new Error(`memory model ${code}`,{cause}),{code})
const count=text=>Math.ceil(Buffer.byteLength(text)/4)
const textOf=message=>(message.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('')
const outputTool={name:'memory_stage1_write_output',description:'Submit the extracted V2 memory JSON.',parameters:{type:'object',properties:{rollout_summary:{type:'string'},rollout_slug:{type:'string'}},required:['rollout_summary','rollout_slug'],additionalProperties:false}}
const delivery='Submit the required JSON object as the arguments of memory_stage1_write_output exactly once. Do not execute other tools or print a substitute JSON response.'

/** Fixed history.rs model-visible accounting; transport identities are not text. */
export function estimateHistoryTokens(system,tools,messages){
 let total=count(system)+(tools.length?count(serdeJson(tools)):0)
 for(const message of messages){
  if(message.role==='tool'){total+=count((message.toolCallId??'')+textOf(message));continue}
  const text=textOf(message);if(text)total+=count(text)
  for(const block of message.content??[])if(block.type==='tool-call')total+=count('functions'+block.name+(typeof block.arguments==='string'?block.arguments:serdeJson(block.arguments)))
 }
 return total
}
/** Remove one oldest logical item and its counterpart, never a half tool pair. */
export function dropOldestItem(history){
 if(!history.length)return []
 const [first,...rest]=history
 if(first.role!=='assistant'){
  if(first.role!=='tool')return rest
  const id=first.toolCallId
  return rest.map(m=>({...m,content:m.content.filter(b=>b.type!=='tool-call'||b.id!==id)})).filter(m=>m.content.length)
 }
 const block=first.content[0]
 if(!block)return rest
 const removingText=block.type==='text',id=block.type==='tool-call'?block.id:undefined
 const content=first.content.filter((b,index)=>removingText?b.type!=='text':index!==0)
 const source={...first.source};delete source.replayState
 const next=content.length?[{...first,id:randomUUID(),source,content},...rest]:rest
 return id?next.filter(m=>m.role!=='tool'||m.toolCallId!==id):next
}
export function truncateTokens(text,tokens){
 const budget=tokens*4;if(Buffer.byteLength(text)<=budget)return text
 const chars=Array.from(text);let left=0,right=chars.length,a=0,b=0
 const half=Math.floor(budget/2)
 while(left<right&&a+Buffer.byteLength(chars[left])<=half)a+=Buffer.byteLength(chars[left++])
 while(right>left&&b+Buffer.byteLength(chars[right-1])<=budget-half)b+=Buffer.byteLength(chars[--right])
 return chars.slice(0,left).join('')+`…${Math.ceil((Buffer.byteLength(text)-budget)/4)} tokens truncated…`+chars.slice(right).join('')
}
export function buildCompactedHistory(history,summary,runtime){
 let remaining=20000;const users=[]
 for(let i=history.length-1;i>=0&&remaining>0;i--){
  const message=history[i],text=textOf(message)
  if(message.role!=='user'||text.startsWith(COMPACT_PREFIX+'\n')||message.source?.kind==='memory-compaction')continue
  const cost=count(text),kept=cost>remaining?runtime.createUserMessage({content:[{type:'text',text:truncateTokens(text,remaining)}],source:message.source}):message
  users.push(kept);remaining=Math.max(0,remaining-cost)
 }
 users.reverse();users.push(runtime.createUserMessage({content:[{type:'text',text:COMPACT_PREFIX+'\n'+summary}],source:{kind:'memory-compaction'}}));return users
}
export function createMemoryDriver(llm,runtime){
 const check=hooks=>{hooks.signal?.throwIfAborted();hooks.assertOwnership?.()}
 const isOverflow=cause=>(cause.failure?.code??cause.code)===runtime.CONTEXT_WINDOW_EXCEEDED_CODE
 async function bind(config,signal){
  let info
  const prepared=await llm.prepareCall(config,signal,(controls,metadata)=>{info=metadata;return {...controls,...config}})
  return {prepared,info,config:prepared.config}
 }
 async function prepare(stage,options,parent,signal){return {...await bind(stageRoute(options,stage,parent),signal),stage}}
 async function rebind(plan,signal){
  const next=await bind(plan.config,signal)
  if(serdeJson(next.config)!==serdeJson(plan.config)||serdeJson(next.info?.context??{})!==serdeJson(plan.info?.context??{}))throw error('MEMORY_CAPABILITIES_CHANGED')
  return next
 }
 async function invoke(plan,{system,messages,tools},hooks={},initial){
  let prepared=initial??(await rebind(plan,hooks.signal)).prepared,retry=0
  for(;;){
   check(hooks)
   try{
    const assembler=new runtime.BlockAssembler();let ended=false
    const stream=prepared.stream({...prepared.config,system,messages:messages.map(runtime.freezeMessage),tools,signal:hooks.signal})
    for await(const chunk of stream){check(hooks);assembler.push(chunk);if(chunk.type==='finish')ended=true}
    check(hooks)
    if(!ended)throw error('MEMORY_INCOMPLETE_RESPONSE')
    if(['error','aborted'].includes(assembler.finish.kind)){
     const facts=assembler.finish.failure
     if(!facts)throw error('MEMORY_INVALID_FINISH')
     throw new runtime.LlmError(facts.message,facts.code,facts)
    }
    if(!['stop','tool-calls'].includes(assembler.finish.kind))throw error('MEMORY_INCOMPLETE_RESPONSE',assembler.finish)
    return {message:assembler.message({provider:plan.config.provider,model:plan.config.model,...assembler.replayState===undefined?{}:{replayState:assembler.replayState}}),usage:assembler.usage}
   }catch(cause){
    check(hooks)
    if(isOverflow(cause)||cause.code?.startsWith('MEMORY_'))throw cause
    const policy=prepared.retryPolicy,facts=cause.failure??cause
    if(!policy||policy.mode!=='always'&&(!policy.retryableCodes.includes(facts.code)||retry>=policy.maxRetries))throw cause
    retry++
    const server=facts.providerRetryAfterMs
    if(Number.isFinite(server)&&server>policy.maxDelayMs&&policy.mode!=='always')throw cause
    const exponential=Math.min(policy.initialDelayMs*2**Math.min(retry-1,1024),policy.maxDelayMs)
    const wait=Number.isFinite(server)&&server>0&&server<=policy.maxDelayMs?server:Math.min(exponential*(1-policy.jitterRatio+2*policy.jitterRatio*Math.random()),policy.maxDelayMs)
    await delay(wait,undefined,{signal:hooks.signal});check(hooks);prepared=(await rebind(plan,hooks.signal)).prepared
   }
  }
 }
 async function extract(plan,input,hooks={}){
  const contents=serializeTieredInput(input.items,stage1TokenBudget(plan.info?.context??{}))
  const framed=buildStageOneInput({rolloutPath:input.rolloutPath??'unknown',rolloutCwd:input.rolloutCwd??'unknown',rolloutGitBranch:input.rolloutGitBranch,rolloutContents:contents})+'\n\n'+delivery
  const messages=extractionChunks(framed).map(text=>runtime.createUserMessage({content:[{type:'text',text}],source:{kind:'dsh-codex-memory'}}))
  const result=await invoke(plan,{system:stageOneSystemPrompt(),messages,tools:[outputTool]},hooks,plan.prepared)
  const calls=result.message.content.filter(b=>b.type==='tool-call')
  if(calls.length!==1||calls[0].name!==outputTool.name)throw error('MEMORY_INVALID_OUTPUT')
  let value
  try{value=JSON.parse(calls[0].arguments)}catch(cause){throw error('MEMORY_INVALID_OUTPUT',cause)}
  if(!value||Array.isArray(value)||Object.keys(value).length!==2||typeof value.rollout_summary!=='string'||typeof value.rollout_slug!=='string')throw error('MEMORY_INVALID_OUTPUT')
  return {rolloutSummary:truncateMiddle(redactSecrets(value.rollout_summary),9000),rolloutSlug:redactSecrets(value.rollout_slug),rawMemory:''}
 }
 async function consolidate(plan,{system,input,workspace},hooks={}){
  let history=[runtime.createUserMessage({content:[{type:'text',text:input}],source:{kind:'dsh-codex-memory'}})]
  let initial=plan.prepared,usageTokens=0
  async function compact(){
   const original=history
   let working=[...original]
   const prompt=runtime.createUserMessage({content:[{type:'text',text:COMPACT_PROMPT}],source:{kind:'memory-compaction'}})
   for(;;){
    check(hooks)
    try{
     const response=await invoke(plan,{system,messages:[...working,prompt],tools:[]},hooks)
     if(response.message.content.some(b=>b.type==='tool-call'))throw error('MEMORY_INVALID_COMPACTION')
     history=buildCompactedHistory(original,textOf(response.message),runtime);usageTokens=0;return
    }catch(cause){
     if(!isOverflow(cause)||!working.length)throw cause
     working=dropOldestItem(working)
    }
   }
  }
  for(;;){
   check(hooks)
   const window=plan.info?.context?.contextWindow,estimate=Math.max(usageTokens,estimateHistoryTokens(system,workspace.tools,history))
   if(Number.isFinite(window)&&window>0&&estimate>=Math.floor(window*9/10)){await compact();initial=undefined}
   let result
   try{result=await invoke(plan,{system,messages:history,tools:workspace.tools},hooks,initial);initial=undefined}
   catch(cause){initial=undefined;if(!isOverflow(cause))throw cause;await compact();continue}
   history.push(result.message)
   usageTokens=(result.usage?.inputTokens??0)+(result.usage?.outputTokens??0)
   const calls=result.message.content.filter(b=>b.type==='tool-call')
   if(!calls.length)return
   for(const call of calls){
    check(hooks);let content,isError=false
    try{content=workspace.dispatch(call.name,JSON.parse(call.arguments));if(content&&typeof content.then==='function')throw error('MEMORY_ASYNC_TOOL')}
    catch(cause){
     if(['UnknownTool','InvalidPath','lost_ownership','reset_pending','InvalidMutationGuard'].includes(cause.code)||cause.code?.startsWith('MEMORY_'))throw cause
     content={error:{code:cause.code??'INVALID_ARGUMENT',message:'Memory workspace operation failed; correct the arguments or path.'}};isError=true
    }
    check(hooks)
    history.push(runtime.createToolResultMessage({callId:call.id,content:[{type:'text',text:JSON.stringify(content)}],isError}))
   }
  }
 }
 return {prepare,extract,consolidate}
}
