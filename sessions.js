import { createReadStream } from 'node:fs'
import { open, mkdtemp, rm, stat, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { StringDecoder } from 'node:string_decoder'
import { decodeZstdStream } from './zstd.js'
import { serdeJson, serializeRolloutItem, readRecentRolloutItems, serializeTieredInput } from './rollout-input.js'

export const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
export class EvidenceReadError extends Error {
 constructor(code,cause) {super(`session evidence ${code}`,{cause});this.name='EvidenceReadError';this.code=code}
}
const failure=(code,cause)=>new EvidenceReadError(code,cause)
const hash=value=>createHash('sha256').update(serdeJson(value)).digest('hex')
const excluded=new Set(['agent-instructions','skill-invocation','skill-catalog','dsh-codex-memory','memory-read','compact-checkpoint','compact-basic'])
const otherAgents=new Set(['agent-message','subagent-report','subagent-settled','team-message'])
const contextual=new Set(['runtime','runtime-context','time','model-selection','working-directory','session-reference','goal','coordinator','webhook'])
function contentOf(content,role,fileHandleText) {
 return (content||[]).flatMap(block=>{
  if(block.type==='text')return [{type:role==='assistant'?'output_text':'input_text',text:block.text,...role!=='assistant'||block.annotations===undefined?{}:{annotations:block.annotations},...role!=='assistant'||block.logprobs===undefined?{}:{logprobs:block.logprobs}}]
  if(block.type==='file') {
    if(typeof fileHandleText!=='function')throw failure('unsupported',new TypeError('native file formatter required'))
    return [{type:'input_text',text:fileHandleText(block.attachment,undefined)}]
   }
   if(block.type==='image') {
   const reference=block.attachment?.attachmentId?{file_id:block.attachment.attachmentId}:{image_url:block.url??block.image??block.data}
   if(typeof(reference.file_id??reference.image_url)!=='string')throw failure('unsupported',new TypeError('image reference shape unsupported'))
   return [{type:'input_image',...reference,...block.detail===undefined?{}:{detail:block.detail}}]
  }
  if(block.type==='audio') {
   const url=block.url??block.audio??block.data
   if(typeof url!=='string')throw failure('unsupported',new TypeError('audio reference shape unsupported'))
   return [{type:'input_audio',audio_url:url}]
  }
  if(block.type==='reasoning'||block.type==='tool-call')return []
  throw failure('unsupported',new TypeError('content block type unsupported'))
 })
}
function parsePayload(content) {
 const text=content?.find(b=>b.type==='text')?.text
 try {return JSON.parse(text)} catch { /* Arbitrary tool text is not a structured question response. */ return undefined }
}
function answerOutput(content) {
 const value=parsePayload(content)
 if(!Array.isArray(value?.answers))return undefined
 const answers={}
 for(const answer of value.answers) {
  if(typeof answer.id!=='string'||!Array.isArray(answer.selected))return undefined
  answers[answer.id]={answers:[...answer.selected.filter(x=>typeof x==='string'),...(typeof answer.custom==='string'?[answer.custom]:[])]}
 }
 return JSON.stringify({answers})
}
function callItem(data) {
 const name=data.name??data.tool??data.toolName
 const callId=data.callId??data.id
 if(typeof name!=='string'||typeof callId!=='string')throw failure('read_failed',new TypeError('tool call identity missing'))
 const item={type:'function_call',name:name==='ask_user_question'&&(!data.namespace||data.namespace==='functions')?'request_user_input':name}
 if(data.namespace!==undefined)item.namespace=data.namespace
 item.arguments=typeof data.arguments==='string'?data.arguments:serdeJson(data.arguments??{})
 item.call_id=callId
 return item
}

/** Stateful only for identity/conflict detection; body ownership stays with the caller/sink. */
export function createEventNormalizer({header,emit=()=>{},remember,fileHandleText}={}) {
 const seen=new Map(),diagnostics=[]
 remember??=((kind,key,digest)=>{const identity=`${kind}:${key}`,old=seen.get(identity);if(old===undefined)seen.set(identity,digest);return old})
 const duplicate=(kind,key,value)=>{const digest=hash(value),old=remember(kind,key,digest);if(old!==undefined&&old!==digest)throw failure('conflict',new Error(`${kind} sources disagree`));return old!==undefined}
 let turn,step
 function output(item,event,blockIndex=0) {
  emit(item,{sessionId:header?.id,seq:event.seq,time:event.time,messageId:event.data?.message?.id??event.data?.id,sourceKind:event.data?.source?.kind??event.data?.message?.source?.kind,turn:event.data?.turn??turn,step:event.data?.step??step,blockIndex,callId:item.call_id})
 }
 function call(data,event,index) {
  const item=callItem(data),key=`${event.data?.turn??turn}:${event.data?.step??step}:${item.call_id}`
  if(duplicate('call',key,item))return
  output(item,event,index)
 }
 return {
  diagnostics,
  accept(event) {
   if(event.type==='turn/start'){turn=event.data.turn;return}
   if(event.type==='step/start'){step=event.data.step;return}
   if(event.type==='tool/call'){call(event.data,event,0);return}
   if(event.type==='tool/ptc-dispatch') {
    const d=event.data
    if(d.name==='ask_user_question') {
     call({...d,callId:d.subCallId},event,0)
     output({type:'function_call_output',call_id:d.subCallId,output:!d.isError?(answerOutput(d.content)??toolOutput(d.content,undefined,fileHandleText)):toolOutput(d.content,undefined,fileHandleText)},event)
    }
    return
   }
   if(!['user/message','assistant/message','tool/result'].includes(event.type))return
   // Replacement surface copies do not represent newly admitted evidence.
   if(event.surfaceOp==='replace'||event.surfaceOp?.type==='replace'||event.surfaceOp?.op==='replace')return
   const message=event.type==='user/message'?event.data:event.data.message
   if(!message)throw failure('read_failed',new TypeError('persisted message missing'))
   const identity=message.id??`seq:${event.seq}`
   if(duplicate('message',identity,message))return
   if(event.type==='tool/result') {
    const callId=message.toolCallId??message.source?.callId
    if(typeof callId!=='string')throw failure('read_failed',new TypeError('tool output identity missing'))
    const content=message.content||[],key=`${event.data.turn??turn}:${event.data.step??step}:${callId}`
    const answer=!message.isError&&!event.data.error?answerOutput(content):undefined
    const item={type:'function_call_output',call_id:callId,output:answer??toolOutput(content,event.data.error,fileHandleText)}
    if(duplicate('result',key,item))return
    output(item,event);return
   }
   const role=event.type==='assistant/message'?'assistant':'user',kind=message.source?.kind
   if(role==='user'&&excluded.has(kind))return
   if(kind==='user-question-reply') {
    const answer=answerOutput(message.content)
    if(answer!==undefined)output({type:'function_call_output',call_id:message.source.callId,output:answer},event)
    return
   }
   const content=contentOf(message.content,role,fileHandleText)
   if(otherAgents.has(kind)&&typeof message.source.author==='string'&&typeof message.source.recipient==='string') {
    output({type:'agent_message',...(message.id?{id:message.id}:{}),author:message.source.author,recipient:message.source.recipient,content:content.filter(p=>p.type==='input_text')},event)
    return
   }
   const item={type:'message',...(message.id?{id:message.id}:{}),role,content}
   if(message.phase!==undefined)item.phase=message.phase
   if(role==='user'&&kind!=='user') {
    item.internal_chat_message_metadata_passthrough={content_item_kinds:[otherAgents.has(kind)||kind?.startsWith('multi_agent.')?`multi_agent.${kind}`:`context.${kind??'unknown'}`]}
    if(!contextual.has(kind)&&!otherAgents.has(kind)&&!kind?.startsWith('multi_agent.')&&diagnostics.length<100)diagnostics.push({code:'unknown_producer',seq:event.seq})
   }
   if(content.length)output(item,event)
   if(role==='assistant') for(let index=0;index<(message.content||[]).length;index++) {
    const block=message.content[index]
    if(block.type==='tool-call')call(block,event,index)
   }
  }
 }
}
function toolOutput(content,error,fileHandleText) {
 const blocks=contentOf(content,'user',fileHandleText)
 if(error&&!blocks.length)blocks.push({type:'input_text',text:error.message??error.code??error.name??'Tool failed'})
 return blocks.every(b=>b.type==='input_text')?blocks.map(b=>b.text).join('\n'):blocks
}
export function normalizeSessionEvents(events,{header,fileHandleText}={}) {
 const items=[],provenance=[]
 const normalizer=createEventNormalizer({header,fileHandleText,emit:(item,source)=>{items.push(item);provenance.push(source)}})
 for(const event of events)normalizer.accept(event)
 return {items,provenance,metadata:header,diagnostics:normalizer.diagnostics}
}

async function* lines(input) {
 const decoder=new StringDecoder('utf8');let pending=''
 for await(const chunk of input){pending+=decoder.write(chunk);let n;while((n=pending.indexOf('\n'))>=0){yield pending.slice(0,n);pending=pending.slice(n+1)}}
 pending+=decoder.end();if(pending)yield pending
}
export async function* readV4Events(path,{codec,signal,onHeader}={}) {
 if(!codec?.createDecoder)throw failure('unsupported',new Error('current public v4 codec required'))
 const input=createReadStream(path,{highWaterMark:65536,signal})
 let decoder
 try {
  const sink={emitEvent:event=>emitted.push(event),emitRun:run=>{
   // Public compact runs own expansion; a run is not itself a settled message.
   for(const event of run.expand())emitted.push(event)
  }}
  let emitted=[]
  for await(const line of lines(path.endsWith('.zstd')?decodeZstdStream(input,{signal}):input)) {
   signal?.throwIfAborted();if(!line)continue
   const row=JSON.parse(line)
   if(!decoder) {
    if(row.version!==4)throw failure('unsupported',new Error('raw codec accepts current v4 only'))
    decoder=codec.createDecoder(row,'recoverable');onHeader?.(decoder.header);continue
   }
   emitted=[];decoder.decodeRow(row,sink)
   for(const event of emitted)yield event
  }
  if(!decoder)throw failure('read_failed',new Error('session header absent'))
  emitted=[];decoder.finish(sink);for(const event of emitted)yield event
 } finally {input.destroy()}
}
function sameIdentity(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs}
export async function readEvidenceSnapshot(snapshot,{codec,assembleAssistantStream,sessionQuery,signal,validateVersion,fileHandleText,tempRoot=tmpdir()}={}) {
 let directory,file,lease,result,index
 try {
  signal?.throwIfAborted()
  if(!await validateVersion(snapshot))throw failure('stale')
  directory=await mkdtemp(join(tempRoot,'dsh-memory-evidence-'))
  const canonicalPath=join(directory,'canonical.jsonl');file=await open(canonicalPath,'wx',0o600)
  const indexPath=join(directory,'source.sqlite');const privateIndex=await open(indexPath,'wx',0o600);await privateIndex.close()
  index=new DatabaseSync(indexPath)
  index.exec('PRAGMA journal_mode=OFF; PRAGMA cache_size=-512; CREATE TABLE seen(kind TEXT,key TEXT,digest TEXT,PRIMARY KEY(kind,key)); CREATE TABLE provenance(offset INTEGER PRIMARY KEY,source TEXT)')
  const get=index.prepare('SELECT digest FROM seen WHERE kind=? AND key=?'),put=index.prepare('INSERT INTO seen VALUES(?,?,?)'),putSource=index.prepare('INSERT INTO provenance VALUES(?,?)'),getSource=index.prepare('SELECT source FROM provenance WHERE offset=?')
  const remember=(kind,key,digest)=>{const old=get.get(kind,key)?.digest;if(old===undefined)put.run(kind,key,digest);return old}
  let header,normalizer,initialStat,offset=0
  async function start(h) {
   if(h?.id!==snapshot.sessionId)throw failure('conflict',new Error('session header identity mismatch'))
   header=h
   const timestamp=Number.isSafeInteger(h.createdAt)?new Date(h.createdAt).toISOString():''
   const line=`${JSON.stringify({timestamp,type:'session_meta',payload:{session_id:h.id,id:h.id,timestamp,cwd:h.cwd??'',originator:'deepseek-harness',cli_version:'',history_mode:'legacy'}})}\n`
   await file.writeFile(line);offset+=Buffer.byteLength(line)
   normalizer=createEventNormalizer({header:h,fileHandleText,remember,emit:(item,source)=>{
    const timestamp=Number.isSafeInteger(source.time)?new Date(source.time).toISOString():''
    pending.push({line:`{"timestamp":${JSON.stringify(timestamp)},${serializeRolloutItem(item).slice(1)}\n`,source})
   }})
  }
  let pending=[]
  const consume=async event=>{signal?.throwIfAborted();normalizer.accept(event);for(const row of pending){putSource.run(offset,JSON.stringify(row.source));await file.writeFile(row.line);offset+=Buffer.byteLength(row.line)}pending=[]}
  if(snapshot.kind==='v4') {
   initialStat=await stat(snapshot.path)
   let rawHeader
   const events=readV4Events(snapshot.path,{codec,assembleAssistantStream,signal,onHeader:h=>{rawHeader=h}})
   for await(const event of events){if(!header)await start(rawHeader);await consume(event)}
   if(!header)await start(rawHeader)
   if(!sameIdentity(initialStat,await stat(snapshot.path)))throw failure('stale')
  } else {
   if(!sessionQuery?.observeSession)throw failure('unsupported',new Error('exact observation service required'))
   lease=await sessionQuery.observeSession(snapshot.sessionId,{projectionMode:'none',signal})
   if(snapshot.revision!==undefined&&lease.revision!==snapshot.revision||snapshot.cursor!==undefined&&lease.cursor!==snapshot.cursor)throw failure('stale')
   await start(lease.header)
   for(const event of lease.events)await consume(event)
  }
  await file.close();file=undefined
  result=await readRecentRolloutItems(canonicalPath,{signal})
  if(!await validateVersion(snapshot))throw failure('stale')
  const provenance=result.positions.map(position=>JSON.parse(getSource.get(position).source))
  delete result.positions
  result={status:result.items.length?'ready':'empty',...result,provenance,metadata:header,sourceVersion:snapshot.sourceVersion,diagnostics:normalizer.diagnostics}
 } catch(cause) {
  const code=cause instanceof EvidenceReadError?cause.code:/Unsupported|unsupported|future/i.test(cause?.name??'')?'unsupported':'read_failed'
  result={status:code==='conflict'?'read_failed':code,items:[],sourceVersion:snapshot.sourceVersion,error:cause instanceof EvidenceReadError?cause:failure(code,cause)}
 } finally {
  try {index?.close()} catch(cause) {result={status:'read_failed',items:[],error:failure('read_failed',cause)}}
  try {await file?.close()} catch(cause) {result={status:'read_failed',items:[],error:failure('read_failed',cause)}}
  try {lease?.[Symbol.dispose]?.()} catch(cause) {result={status:'read_failed',items:[],error:failure('read_failed',cause)}}
  if(directory) {
   const absolute=resolve(directory)
   if(dirname(absolute)!==resolve(tempRoot)||!absolute.startsWith(join(resolve(tempRoot),'dsh-memory-evidence-')))throw failure('read_failed',new Error('temporary directory ownership mismatch'))
   try {await rm(absolute,{recursive:true,force:true})} catch(cause) {result={status:'read_failed',items:[],error:failure('read_failed',cause)}}
  }
 }
 return result
}

// Legacy callers may render already recovered event snapshots, never raw historical codecs.
export function renderSessionTranscript(events,{tokenLimit=150000,header,fileHandleText}={}) {return serializeTieredInput(normalizeSessionEvents(events,{header,fileHandleText}).items,tokenLimit)}
export const usesExternalContext=events=>events.some(event=>['tool/result','tool/call','tool/ptc-dispatch','tool/ptc-dispatch-start'].includes(event.type)&&/^(web_search|web_fetch|mcp[_.-]|browser)/i.test(event.data?.tool??event.data?.name??event.data?.toolName??''))
export async function listSessionFiles(root) {
 const paths=[]
 for(const project of await readdir(root,{withFileTypes:true}))if(project.isDirectory())for(const session of await readdir(join(root,project.name),{withFileTypes:true}))if(session.isDirectory())for(const name of await readdir(join(root,project.name,session.name)))if(/\.jsonl(?:\.zstd)?$/.test(name))paths.push(join(root,project.name,session.name,name))
 return paths
}
export async function decodeSession(path,options) {const events=[];for await(const event of readV4Events(path,options))events.push(event);return events}
export async function readThreadCandidates(root,options={}) {
 const candidates=[]
 for(const path of await listSessionFiles(root)) {
  let header
  const events=await decodeSession(path,{...options,onHeader:h=>{header=h}})
  if(header.origin==='subagent'||header.delegationDepth>0||header.id.startsWith('memory-'))continue
  candidates.push({threadId:header.id,path,cwd:header.cwd,updatedAtMs:(await stat(path)).mtimeMs,events,polluted:usesExternalContext(events)})
 }
 return candidates
}
export const threadMetaFrom=candidates=>new Map(candidates.map(c=>[c.threadId,{cwd:c.cwd,rollout_path:c.path}]))
