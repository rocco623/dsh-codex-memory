import * as fs from 'node:fs'
import {join} from 'node:path'
import z from '@deepseek-ai/schemastery'
import * as runtime from '@deepseek-ai/dsh-llm'
import {releasedV4SessionFormatCodec as codec} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {parseSessionFormatLogFilename as parseFilename} from '@deepseek-ai/dsh-session-format'
import {DEFAULTS,normalizeOptions,configOrigins,stageRoute} from './config.js'
import {createMemoryPipeline} from './pipeline.js'
import {buildReadPathInstructions} from './prompts.js'
import {truncateTokens} from './model.js'
import {extractionChunks} from './rollout-input.js'
import {dshHome} from './sessions.js'
import {memoryError,strictFields} from './memory-backend.js'

export const name='dsh-codex-memory'
export const inject=['tools','agents','sessions','sessionQuery','sessionPersistence','llm','systemPrompt']
// Optional volatile scalars preserve the difference between absent and persisted values.
export const Config=z.object(Object.fromEntries(Object.entries(DEFAULTS).map(([key,value])=>[key,(typeof value==='boolean'?z.boolean():typeof value==='number'?z.number():z.string()).volatile()])))
const codeOf=error=>typeof error?.code==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(error.code)?error.code:'INTERNAL_ERROR'
const output={schema:{},render:value=>typeof value==='string'?value:JSON.stringify(value)}
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false})

export function apply(ctx,config={}){
 const raw=()=>Object.fromEntries(Object.entries(config).map(([key,value])=>[key,value&&typeof value.get==='function'?value.get():value]).filter(([,value])=>value!==undefined))
 const options=()=>normalizeOptions(raw()),home=dshHome(),logger=ctx.logger
 const report=(level,event,detail={})=>{
  const {error,...facts}=detail,causes=[];let cause=error
  for(let n=0;cause&&n<6;n++,cause=cause.cause)causes.push({name:cause.name,code:codeOf(cause)})
  const safe={...facts,...error?{causes}:{}}
  logger[level](`memory: ${event}`,safe)
  if(options().diagnostics)try{fs.appendFileSync(join(home,'memory_diagnostics.log'),JSON.stringify({time:new Date().toISOString(),event,...safe})+'\n')}
  catch(writeError){logger.warn('memory: diagnostic write failed',{code:codeOf(writeError)})}
 }
 const pipeline=createMemoryPipeline(ctx,{home,readOptions:options,runtime,codec,parseFilename,report})
 const safely=(event,fn)=>(...args)=>{try{return fn(...args)}catch(error){report('warn',event,{error})}}
 // Subscribe before inventory: newly published sessions retain their creation policy.
 ctx.on('agent/created',safely('source initialization failed',value=>pipeline.handleCreated(value)),{global:true})
 ctx.on('session/event',safely('session observation failed',(session,event)=>pipeline.handleEvent(session,event)),{global:true})
 ctx.effect(()=>()=>pipeline.stop(),'memory: cancel and drain jobs')
 void pipeline.bootstrap()

 ctx.systemPrompt.section({name:'memory:read-path',order:60,interpolate:false,text:()=>{
  if(!options().useMemories||pipeline.store.control().reset_pending)return ''
  try{
   const summary=pipeline.backend.read({path:'memory_summary.md'}).content
   const text=buildReadPathInstructions({basePath:pipeline.memoryRoot,memorySummary:truncateTokens(summary,2500)})
   // The host accepts a single system string; reassembly preserves every byte.
   return text?extractionChunks(text).join(''):''
  }catch(error){if(error.code!=='NotFound'&&error.code!=='ENOENT')report('warn','memory read failed',{error});return ''}
 }})
 const readPathSearch={oneOf:[
  object({queries:{type:'array',items:{type:'string'}},path:{type:'string'},match_mode:{oneOf:[
   object({type:{type:'string',enum:['any']}},['type']),
   object({type:{type:'string',enum:['all_on_same_line']}},['type']),
   object({type:{type:'string',enum:['all_within_lines']},line_count:{type:'integer'}},['type','line_count']),
  ]},context_lines:{type:'integer'},cursor:{type:'string'},max_results:{type:'integer'},case_sensitive:{type:'boolean'},normalized:{type:'boolean'}},['queries']),
  object({query:{type:'string'},max_results:{type:'integer'}},['query']),
 ]}
 const tools=[
  {name:'memory_list',description:'List memory workspace entries.',parameters:object({path:{type:'string'},cursor:{type:'string'},max_results:{type:'integer'}},[]),execute:args=>pipeline.backend.list(args)},
  {name:'memory_read',description:'Read memory workspace text.',parameters:object({path:{type:'string'},line_offset:{type:'integer'},max_lines:{type:'integer'}},['path']),execute:args=>pipeline.backend.read(args)},
  {name:'memory_search',description:'Search memory workspace text.',parameters:readPathSearch,execute:args=>pipeline.backend.search(args)},
  {name:'memory_add_ad_hoc_note',description:'Record an explicit remember, forget, or correction request. Never infer permission.',parameters:object({filename:{type:'string'},note:{type:'string'}},['filename','note']),execute:args=>pipeline.backend.addAdHocNote(args)},
  {name:'memory_note',description:'Record an explicit user memory request; applied at consolidation.',parameters:object({note:{type:'string'}},['note']),execute:args=>pipeline.backend.note(args)},
 ]
 let registered=[]
 function synchronizeTools(){
  const next=options().useMemories&&options().dedicatedTools
  if(next===Boolean(registered.length))return
  for(const dispose of registered)dispose()
  registered=[]
  if(!next)return
  try{
   for(const tool of tools)registered.push(ctx.tools.register({...tool,output,execute:args=>{
    if(!options().useMemories||!options().dedicatedTools||pipeline.store.control().reset_pending)throw memoryError('memory_disabled','memory tools are disabled')
    try{return tool.execute(args)}catch(error){report('warn','memory tool failed',{error,tool:tool.name});throw error}
   }}))
  }catch(error){for(const dispose of registered)dispose();registered=[];throw error}
 }
 synchronizeTools()
 ctx.on('loader/volatile-update',synchronizeTools)
 ctx.effect(()=>()=>{for(const dispose of registered)dispose();registered=[]},'memory: unregister public tools')

 async function validateSettings(values){
  if(!values||typeof values!=='object'||Array.isArray(values))throw memoryError('INVALID_CONFIG','values object required')
  const validated=normalizeOptions(values,{strict:true})
  for(const stage of [1,2]){
   try{stageRoute(validated,stage,{})}catch(error){if(error.code==='NO_TRIGGER_ROUTE')continue;throw error}
   await pipeline.driver.prepare(stage,validated,{})
  }
  return validated
 }
 ctx.inject(['webServer'],scoped=>scoped.effect(()=>scoped.webServer.register({kind:'prefix',path:'/dsh-codex-memory',handler:async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))}
  try{
   const base=`http://${req.headers.host??'localhost'}`,url=new URL(req.url??'/',base),path=url.pathname.slice('/dsh-codex-memory'.length)
   if(req.headers.origin&&req.headers.origin!==new URL(base).origin)return send(403,{ok:false,error:'ORIGIN_MISMATCH'})
   if(!['GET','POST'].includes(req.method))return send(405,{ok:false,error:'METHOD_NOT_ALLOWED'})
   let body
   if(req.method==='POST'){
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return send(415,{ok:false,error:'JSON_REQUIRED'})
    const chunks=[];let size=0
    try{for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>1024*1024)throw memoryError('BODY_TOO_LARGE','request body exceeds limit');chunks.push(chunk)}}finally{if(!req.complete)req.resume()}
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(cause){throw memoryError('INVALID_JSON','invalid JSON',cause)}
    if(!body||typeof body!=='object'||Array.isArray(body))throw memoryError('INVALID_JSON','object required')
   }
   if(path==='/config'&&req.method==='GET')return send(200,{ok:true,values:options(),origins:configOrigins(raw())})
   if(path==='/config'&&req.method==='POST'){
    strictFields(body,['values']);const next=await validateSettings(body.values)
    const entry=ctx.fiber?.entry,editor=ctx.get('configEditor')
    if(!entry||!editor)return send(409,{ok:false,error:'NO_CONFIG_EDITOR'})
    await editor.edit(entry,()=>({...next,memoryConfigVersion:2}));synchronizeTools()
    return send(200,{ok:true,values:options(),origins:configOrigins(raw())})
   }
   if(path==='/capabilities'&&req.method==='GET'){
    const provider=url.searchParams.get('provider'),model=url.searchParams.get('model')
    if(!provider||!model)return send(400,{ok:false,error:'ROUTE_REQUIRED'})
    const info=await ctx.llm.resolveModelInfo(provider,model)
    return send(200,{ok:true,provider,model,context:info.context??null,reasoning:info.reasoning??null})
   }
   if(path==='/status'&&req.method==='GET')return send(200,{ok:true,...pipeline.status(),root:pipeline.memoryRoot})
   if(path==='/threads'&&req.method==='GET'){
    await pipeline.bootstrap()
    const offset=Number(url.searchParams.get('cursor')??0)
    if(!Number.isSafeInteger(offset)||offset<0)throw memoryError('InvalidArgument','invalid cursor')
    const all=pipeline.store.listSources(),items=all.slice(offset,offset+200).map(row=>({sessionId:row.session_id,memoryMode:row.memory_mode,modeOrigin:row.mode_origin,presence:row.presence,readStatus:row.read_status,archived:!!row.archived,updatedAtMs:row.source_updated_at_ms}))
    return send(200,{ok:true,items,nextCursor:offset+items.length<all.length?String(offset+items.length):null})
   }
   if(path==='/thread-mode'&&req.method==='POST'){
    strictFields(body,['sessionId','mode'])
    if(typeof body.sessionId!=='string'||!['enabled','disabled'].includes(body.mode))throw memoryError('InvalidArgument','invalid session mode')
    if(!pipeline.store.getSource(body.sessionId))return send(404,{ok:false,error:'UNKNOWN_SESSION'})
    let cursor
    if(body.mode==='enabled'){
     const lease=await ctx.sessionQuery.observeSession(body.sessionId,{projectionMode:'none'})
     try{cursor=lease.cursor}finally{lease[Symbol.dispose]()}
    }
    pipeline.store.setSourceMode(body.sessionId,body.mode,{eventSeq:cursor})
    return send(200,{ok:true})
   }
   if(path==='/reset'&&req.method==='POST'){
    strictFields(body,['confirm']);pipeline.reset(body.confirm);return send(200,{ok:true})
   }
   return send(404,{ok:false,error:'NOT_FOUND'})
  }catch(error){
   report('warn','control request failed',{error})
   const code=codeOf(error),status=code==='reset_busy'||code==='reset_pending'?409:code==='BODY_TOO_LARGE'?413:code==='INTERNAL_ERROR'?500:400
   return send(status,{ok:false,error:code})
  }
 }}),'memory: settings and control routes'))
}
