import { open } from 'node:fs/promises'
import { redactSecrets } from './redact.js'

export const MAX_RECORD_BYTES = 1024 * 1024
export const MAX_ROLLOUT_BYTES = 8 * MAX_RECORD_BYTES
export const OMITTED = '[... response items omitted ...]\n'
const bytes = text => Buffer.byteLength(text)
const utf8 = new TextDecoder('utf-8',{fatal:true})
const allowed = new Set(['message','agent_message','local_shell_call','function_call','tool_search_call','function_call_output','tool_search_output','custom_tool_call','custom_tool_call_output','web_search_call'])
const marked = (text,start,end) => {
 if(typeof text!=='string')return false
 let left=0,right=text.length
 while(left<right&&/\p{White_Space}/u.test(text[left]))left++
 while(right>left&&/\p{White_Space}/u.test(text[right-1]))right--
 const asciiLower=value=>value.replace(/[A-Z]/g,ch=>ch.toLowerCase())
 return right-left>=Math.max(start.length,end.length)&&asciiLower(text.slice(left,left+start.length))===asciiLower(start)&&asciiLower(text.slice(right-end.length,right))===asciiLower(end)
}

// ResponseItem field order is the fixed protocol enum's serde order, not input key order.
const fields = {
 message:['status','id','role','content','phase','internal_chat_message_metadata_passthrough'],
 agent_message:['id','author','recipient','content','internal_chat_message_metadata_passthrough'],
 function_call:['status','id','name','namespace','arguments','encrypted_function_args','call_id','internal_chat_message_metadata_passthrough'],
 function_call_output:['id','call_id','name','namespace','output','internal_chat_message_metadata_passthrough'],
 custom_tool_call:['id','status','call_id','name','namespace','input','internal_chat_message_metadata_passthrough'],
 custom_tool_call_output:['id','call_id','name','output','internal_chat_message_metadata_passthrough'],
 local_shell_call:['id','call_id','status','action','internal_chat_message_metadata_passthrough'],
 tool_search_call:['id','call_id','status','execution','arguments','internal_chat_message_metadata_passthrough'],
 tool_search_output:['id','call_id','status','execution','tools','internal_chat_message_metadata_passthrough'],
 web_search_call:['id','status','action','internal_chat_message_metadata_passthrough'],
}
// serde_json::Value uses sorted object keys; declared struct fields use protocol order.
export function serdeJson(value, order) {
 if(value===null||typeof value!=='object')return JSON.stringify(value)
 if(Array.isArray(value))return `[${value.map(v=>serdeJson(v)).join(',')}]`
 const keys=order??Object.keys(value).sort()
 return `{${keys.filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${serdeJson(value[k])}`).join(',')}}`
}
const contentFields={input_text:['type','text'],output_text:['type','text','annotations','logprobs'],input_image:['type','image_url','file_id','detail'],input_audio:['type','audio_url'],encrypted_content:['type','encrypted_content']}
export function serializeResponseItem(item) {
 const parts=[`"type":${JSON.stringify(item.type)}`]
 for(const key of fields[item.type]) {
  if(item[key]===undefined)continue
  let text
  if(key==='content'||key==='output'&&Array.isArray(item[key]))text=`[${item[key].map(p=>serdeJson(p,contentFields[p.type])).join(',')}]`
  else if(key==='action')text=serdeJson(item[key],{exec:['type','command','timeout_ms','working_directory','env','user'],search:['type','query','queries'],open_page:['type','url'],find_in_page:['type','url','pattern'],other:['type']}[item[key].type])
  else if(key==='internal_chat_message_metadata_passthrough')text=serdeJson(item[key],['turn_id','create_time','content_item_kinds','content_item_metadata','cell_id','executed_tool_calls','tool_calls_complete'])
  else text=serdeJson(item[key])
  parts.push(`${JSON.stringify(key)}:${text}`)
 }
 return `{${parts.join(',')}}`
}
export function serializeRolloutItem(item) {return `{"type":"response_item","payload":${serializeResponseItem(item)}}`}
export function sanitizeResponseItem(source) {
 if (!source || !allowed.has(source.type) || source.type==='message' && source.role==='developer') return null
 const item={type:source.type}
 for(const key of fields[source.type]) if(source[key] != null) item[key]=structuredClone(source[key])
 if(['local_shell_call','tool_search_output'].includes(item.type)&&source.call_id==null)item.call_id=null
 if(item.type==='message' && item.role==='user') {
  delete item.status
  item.content=(item.content||[]).filter(p=>!(p.type==='input_text' && (marked(p.text,'# AGENTS.md instructions','</INSTRUCTIONS>')||marked(p.text,'<skill>','</skill>'))))
  if(!item.content.length) return null
 }
 return item
}
export function truncateMiddle(text,budget) {
 if(bytes(text)<=budget) return text
 const leftBudget=Math.floor(budget/2),rightStart=bytes(text)-(budget-leftBudget)
 let position=0,left='',right='',removed=0
 for(const ch of text) {
  const end=position+bytes(ch)
  if(end<=leftBudget) left+=ch
  else if(position>=rightStart) right+=ch
  else removed++
  position=end
 }
 return `${left}…${removed} chars truncated…${right}`
}
function tierOf(item,question) {
 if(question!==undefined) return 0
 if(item.type==='agent_message') return 2
 if(item.type!=='message') return 5
 const kinds=item.internal_chat_message_metadata_passthrough?.content_item_kinds||[]
 const texts=item.content.filter(p=>p.type==='input_text'||p.type==='output_text').map(p=>p.text)
 let communication=false
 if(texts.length===1&&item.content.length===1) {
  try {const value=JSON.parse(texts[0]);communication=typeof value.author==='string'&&typeof value.recipient==='string'&&typeof value.content==='string'&&typeof value.trigger_turn==='boolean'} catch { /* Only valid InterAgentCommunication JSON changes provenance. */ }
 }
 if(communication||kinds.some(k=>k.startsWith('multi_agent.'))||texts.some(t=>{
  const lines=t.trimStart().split('\n')
  return t.trimStart().startsWith('<subagent_notification>')||lines[0].startsWith('Message Type:')&&lines[1]?.startsWith('Task name:')&&lines[2]?.startsWith('Sender:')&&lines[3]==='Payload:'
 })) return 2
 if(item.role==='user') return kinds.length&&kinds.every(k=>!k.startsWith('user.'))||texts.some(t=>marked(t,'<environment_context>','</environment_context>'))?4:0
 return item.phase==='commentary'?3:1
}
const labels=['human user','assistant final','other agent','assistant commentary','harness context','tool']
function communicationItem(message) {
 const item={type:'agent_message'}
 if(message.id!=null)item.id=message.id
 item.author=message.author;item.recipient=message.recipient
 item.content=message.encrypted_content==null?[{type:'input_text',text:message.content}]:[
  {type:'input_text',text:`Message Type: ${message.trigger_turn?'NEW_TASK':'MESSAGE'}\nTask name: ${message.recipient}\nSender: ${message.author}\nPayload:\n`},
  {type:'encrypted_content',encrypted_content:message.encrypted_content},
 ]
 if(message.internal_chat_message_metadata_passthrough!=null)item.internal_chat_message_metadata_passthrough=message.internal_chat_message_metadata_passthrough
 return item
}
function serializeCommunication(message) {return serdeJson(message,['id','author','recipient','other_recipients','content','encrypted_content','internal_chat_message_metadata_passthrough','trigger_turn'])}
export function serializeTieredInput(items,tokenLimit) {
 if(!Number.isSafeInteger(tokenLimit)||tokenLimit<0) throw new RangeError('token limit must be a nonnegative safe integer')
 const rows=[],questions=new Map()
 for(const wrapped of items) {
  const item=wrapped.type==='inter_agent_communication'?communicationItem(wrapped.payload):sanitizeResponseItem(wrapped.type==='response_item'?wrapped.payload:wrapped)
  if(!item) continue
  if(item.type==='message') item.content=item.content.map(p=>p.type==='input_image'?{type:'input_text',text:'[image omitted]'}:p.type==='input_audio'?{type:'input_text',text:'[audio omitted]'}:p)
  let question
  if(item.type==='function_call'&&item.name==='request_user_input'&&(!item.namespace||item.namespace==='functions')) questions.set(item.call_id,item.arguments)
  else if(item.type==='function_call_output'&&questions.has(item.call_id)) {
   let reply
   try {reply=JSON.parse(typeof item.output==='string'?item.output:'')} catch { /* Non-JSON tool output is valid Tool evidence, never a human reply. */ }
   if(reply?.answers&&Object.values(reply.answers).some(a=>Array.isArray(a?.answers)&&a.answers.some(t=>typeof t==='string'&&t.trim()))) {question=questions.get(item.call_id);questions.delete(item.call_id)}
  }
  const tier=tierOf(item,question)
  let text=redactSecrets(question===undefined?serializeResponseItem(item):`Assistant question: ${question}\nHuman reply: ${serializeResponseItem(item)}`)
  if(tier===5&&['function_call_output','custom_tool_call_output','tool_search_output'].includes(item.type)) text=truncateMiddle(text,8000-96)
  text=truncateMiddle(text,10000-96)
  rows.push({tier,text:`[${labels[tier]}]\n${text}\n`})
 }
 let remaining=Math.max(0,tokenLimit*4-bytes(OMITTED))
 const selected=Array(rows.length).fill(null)
 for(let tier=0;tier<6;tier++) for(let i=rows.length-1;i>=0;i--) {
  if(rows[i].tier!==tier||remaining<=bytes(OMITTED)+96) continue
  const budget=remaining-bytes(OMITTED)
  const text=bytes(rows[i].text)<=budget?rows[i].text:truncateMiddle(rows[i].text,budget-96)
  remaining=Math.max(0,remaining-bytes(text)-bytes(OMITTED));selected[i]=text
 }
 let rendered='',gap=false
 for(const text of selected) {
  if(text!==null) {rendered+=text;gap=false}
  else if(!gap) {rendered+=OMITTED;gap=true}
 }
 return bytes(rendered)>tokenLimit*4?'':rendered
}
export function extractionChunks(text) {
 const chunks=[];let chunk='',size=0
 for(const ch of text) {const n=bytes(ch);if(size+n>8900){chunks.push(chunk);chunk='';size=0}chunk+=ch;size+=n}
 if(chunk) chunks.push(chunk)
 return chunks
}
export function stage1TokenBudget(modelInfo={}) {
 const window=modelInfo.contextWindow
 return Number.isSafeInteger(window)&&window>0?Math.max(1,Math.floor(window*70/100)):150000
}

// Reverse scan uses a fixed buffer. Oversized or malformed evidence is skipped, not loaded.
export async function readRecentRolloutItems(path,{signal}={}) {
 const file=await open(path,'r')
 try {
  const size=(await file.stat()).size,header=Buffer.alloc(Math.min(size,MAX_RECORD_BYTES))
  const {bytesRead}=await file.read(header,0,header.length,0)
  const newline=header.subarray(0,bytesRead).indexOf(10)
  let meta
  try {meta=JSON.parse(utf8.decode(header.subarray(0,newline<0?bytesRead:newline)))} catch(cause) {throw new Error('canonical session header invalid',{cause})}
  if(meta.type!=='session_meta'||!meta.payload?.id||meta.payload.history_mode!==undefined&&!['legacy','paginated'].includes(meta.payload.history_mode)||newline<0&&size>MAX_RECORD_BYTES) throw new Error('canonical session metadata required within record limit')
  const retained=[],positions=[];let remaining=MAX_ROLLOUT_BYTES,position=size,parts=[],length=0,oversized=false,stop=false
  const consume=(offset)=>{
   if(!length&&!oversized)return
   if(!oversized) {
    let row
    try {row=JSON.parse(utf8.decode(Buffer.concat(parts.reverse())))} catch { /* Native reverse scanner skips malformed individual records. */ }
    if(row?.type==='response_item'||row?.type==='inter_agent_communication') {
     const item=row.type==='response_item'?sanitizeResponseItem(row.payload):row.payload
     if(item) {
      const canonical={type:row.type,payload:item}
      const cost=bytes(row.type==='response_item'?serializeRolloutItem(item):`{"type":"inter_agent_communication","payload":${serializeCommunication(item)}}`)
      if(cost>remaining)stop=true;else {remaining-=cost;retained.push(canonical);positions.push(offset)}
     }
    }
   }
   parts=[];length=0;oversized=false
  }
  while(position>0&&!stop) {
   signal?.throwIfAborted()
   const start=Math.max(0,position-65536),buffer=Buffer.alloc(position-start)
   await file.read(buffer,0,buffer.length,start)
   let end=buffer.length
   for(let i=buffer.length-1;i>=0&&!stop;i--) if(buffer[i]===10) {
    const segment=buffer.subarray(i+1,end);length+=segment.length
    if(length>MAX_RECORD_BYTES){parts=[];oversized=true}else if(!oversized)parts.push(segment)
    consume(start+i+1);end=i
   }
   if(!stop&&end){const segment=buffer.subarray(0,end);length+=segment.length;if(length>MAX_RECORD_BYTES){parts=[];oversized=true}else if(!oversized)parts.push(segment)}
   position=start
  }
  if(!stop)consume(0)
  return {items:retained.reverse(),positions:positions.reverse(),metadata:meta.payload}
 } finally {await file.close()}
}
