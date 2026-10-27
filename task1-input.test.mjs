import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeTieredInput, extractionChunks, truncateMiddle, sanitizeResponseItem, stage1TokenBudget } from './rollout-input.js'
import { normalizeSessionEvents } from './sessions.js'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { redactSecrets } from './redact.js'
const message = (role,text,extra={}) => ({type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}],...extra})
test('fixed literal six-tier oracle, source order and newest human preference',async()=>{
 const raw=await readFile(new URL('./fixtures/task1-rollout.json',import.meta.url))
 const fixture=JSON.parse(raw),manifest=JSON.parse(await readFile(new URL('./fixtures/task1-native.sources.json',import.meta.url)))
 assert.equal(createHash('sha256').update(raw).digest('hex'),manifest.fixture.sha256)
 assert.equal(serializeTieredInput(fixture.items,3000),fixture.expectedRows.join(''))
 assert.equal(serializeTieredInput(fixture.items,100),fixture.expectedRows[0]+'[... response items omitted ...]\n'+fixture.expectedRows[6])
 assert.equal(serializeTieredInput(fixture.items,60),'[... response items omitted ...]\n'+fixture.expectedRows[6])
})
test('native literal rows, all missing-phase assistants remain Final',()=>{
 const events=[{type:'user/message',seq:0,data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'question'}]}},{type:'assistant/message',seq:1,data:{message:{id:'a',content:[{type:'text',text:'first'}]}}},{type:'assistant/message',seq:2,data:{message:{id:'b',content:[{type:'text',text:'second'}]}}}]
 const rows=normalizeSessionEvents(events).items
 assert.equal(rows.length,3)
 assert.equal(serializeTieredInput([message('user','hello')],1000),'[human user]\n{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}\n')
 assert.equal((serializeTieredInput(rows,2000).match(/assistant final/g)||[]).length,2)
})
test('admitted only and fragment sanitizer',()=>{
 const events=[{type:'agent/inbox/spliced',data:{inserted:[{source:{kind:'user'},content:[{type:'text',text:'pending'}]}]}}]
 assert.deepEqual(normalizeSessionEvents(events).items,[])
 assert.equal(sanitizeResponseItem(message('developer','secret')),null)
 assert.equal(sanitizeResponseItem(message('user',' <SKILL>hidden</SKILL> ')),null)
 const item=sanitizeResponseItem(message('user','ok',{status:'done',encrypted_content:'opaque'}))
 assert.equal('status' in item,false);assert.equal('encrypted_content' in item,false)
})
test('native scalar truncation and unicode chunk preservation',()=>{
 assert.equal(truncateMiddle('ab🐈中文cd',6),'ab…3 chars truncated…cd')
 assert.equal(truncateMiddle('abcdef',0),'…6 chars truncated…')
 const text='User correction: 🐈\n'.repeat(2000), chunks=extractionChunks(text)
 assert.equal(chunks.join(''),text);assert.ok(chunks.every(x=>Buffer.byteLength(x)<=8900))
 assert.equal(stage1TokenBudget({contextWindow:100000}),70000)
 assert.equal(stage1TokenBudget({}),150000)
 assert.equal(stage1TokenBudget({contextWindow:1}),1)
})
test('question answer association and default namespace only',()=>{
 const call={type:'function_call',name:'request_user_input',arguments:'{"questions":[{"id":"q","question":"Pick?"}]}',call_id:'c'}
 const result={type:'function_call_output',call_id:'c',output:'{"answers":{"q":{"answers":["yes"]}}}'}
 assert.match(serializeTieredInput([call,result],2000),/\[human user\]\nAssistant question: /)
 assert.doesNotMatch(serializeTieredInput([{...call,namespace:'external'},result],2000),/human user/)
})
test('canonical serde order, plain tool payloads and phase fidelity',()=>{
 const events=[{type:'assistant/message',seq:1,data:{turn:1,step:2,interrupted:true,message:{id:'a',content:[{type:'text',text:'partial'},{type:'tool-call',id:'c',name:'run',arguments:{'2':'two','10':'ten',z:1,a:2}}]}}},{type:'tool/call',data:{turn:1,step:2,callId:'c',name:'run',arguments:'{"10":"ten","2":"two","a":2,"z":1}'}},{type:'tool/result',data:{message:{id:'r',toolCallId:'c',source:{kind:'tool',callId:'c'},content:[{type:'text',text:'failed body'}],isError:true},error:{message:'failed body'}}}]
 const result=normalizeSessionEvents(events)
 assert.equal(result.items.length,3)
 assert.equal(result.items[1].arguments,'{"10":"ten","2":"two","a":2,"z":1}')
 assert.equal(result.items[2].output,'failed body')
 assert.match(serializeTieredInput(result.items,3000),/assistant final/)
 assert.throws(()=>normalizeSessionEvents([...events,{type:'tool/call',data:{turn:1,step:2,callId:'c',name:'run',arguments:'DIFFERENT'}}]),e=>e.code==='conflict')
})
test('late and PTC ask replies need admitted evidence and retain original questions',()=>{
 const question={questions:[{id:'q',question:'Pick?',options:[{label:'yes'}]}]}
 const ptc={type:'tool/ptc-dispatch',data:{name:'ask_user_question',subCallId:'sub',arguments:question,content:[{type:'text',text:'{"pending":true}'}]}}
 const reply={type:'user/message',seq:8,data:{id:'reply',source:{kind:'user-question-reply',callId:'sub'},content:[{type:'text',text:'{"answers":[{"id":"q","selected":["yes"]}]}'}]}}
 const items=normalizeSessionEvents([ptc,reply]).items
 assert.equal(items.length,3)
 assert.match(serializeTieredInput(items,4000),/Assistant question:.*Pick\?/)
 assert.doesNotMatch(serializeTieredInput(normalizeSessionEvents([ptc]).items,4000),/human user/)
 assert.doesNotMatch(serializeTieredInput([items.at(-1)],4000),/human user/)
})
test('native secret boundaries and scalar assignment lengths',()=>{
 assert.equal(redactSecrets('汉Bearer abcdefghijklmnop'),'汉Bearer abcdefghijklmnop')
 assert.equal(redactSecrets('汉password=abcdefgh'),'汉password=abcdefgh')
 assert.equal(redactSecrets('password=中'.replace('中','中文中文')),'password=中文中文')
 assert.equal(redactSecrets('password=中文中文中文中文'),'password=[REDACTED_SECRET]')
 assert.equal(redactSecrets('authorization: bEaReR\tabcdefghijklmnop'),'authorization: Bearer [REDACTED_SECRET]')
 assert.equal(redactSecrets('Bearer abcdefghijklmnoK'),'Bearer abcdefghijklmnoK')
 assert.equal(redactSecrets('password\u0085=\u0085abcdefgh'),'password\u0085=\u0085[REDACTED_SECRET]')
})
test('file handles retain metadata without reading or inventing paths',()=>{
 const ref={attachmentId:'sha256:'+'a'.repeat(64),name:'report.xlsx',bytes:42}
 const events=[{type:'user/message',seq:1,data:{id:'file-user',source:{kind:'user'},content:[{type:'file',attachment:ref}]}}]
 assert.throws(()=>normalizeSessionEvents(events),e=>e.code==='unsupported')
 let calls=0
 const fileHandleText=(attachment,path)=>{calls++;assert.equal(path,undefined);assert.deepEqual(attachment,ref);return '[report.xlsx, 42 bytes, sha256:aaaaaaaa; no readable path]'}
 const items=normalizeSessionEvents(events,{fileHandleText}).items
 assert.equal(calls,1)
 assert.equal(items[0].content[0].type,'input_text')
 assert.match(serializeTieredInput(items,1000),/report\.xlsx/)
})
test('tool truncation retains tail and row caps',()=>{
 const out=serializeTieredInput([{type:'function_call_output',call_id:'x',output:'A'.repeat(25000)+'TAIL'}],30000)
 assert.match(out,/chars truncated/);assert.match(out,/TAIL/);assert.ok(Buffer.byteLength(out)<8100)
})
