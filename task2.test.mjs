import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join,resolve,dirname,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {openMemoryStore} from './db.js'
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'dsh-memory-task2-'));let time=1000
 const path=join(root,'synthetic.sqlite'),a=openMemoryStore(path,{clock:()=>time}),b=openMemoryStore(path,{clock:()=>time})
 t.after(()=>{a.close();b.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('dsh-memory-task2-'));rmSync(resolve(root),{recursive:true})})
 const source=(id,extra={})=>({session_id:id,header:{id,version:4,createdAt:0,cwd:'/synthetic'},presence:'present',read_status:'ready',source_updated_at_ms:100000,source_version:'v1',...extra})
 return {a,b,source,tick:n=>{time=n}}
}
test('atomic ownership completion and successful no-output watermark',t=>{
 const {a,b,source,tick}=fixture(t);a.publishSources([source('a'),source('empty')])
 const first=a.claimStage1Job('a','one',100,10,2,'v1');assert.equal(first.outcome,'claimed')
 assert.equal(b.claimStage1Job('a','two',100,10,2,'v1').outcome,'skipped_running')
 tick(1011);const next=b.claimStage1Job('a','two',100,10,2,'v1');assert.equal(next.outcome,'claimed')
 const output={sourceUpdatedAt:100,rolloutSummary:'new',rawMemory:'',rolloutSlug:null}
 assert.equal(b.stage1JobSucceeded('a',next.token,output,'v1'),true)
 assert.equal(a.stage1JobSucceeded('a',first.token,{...output,rolloutSummary:'stale'},'v1'),false)
 assert.equal(a.db.prepare('SELECT rollout_summary FROM stage1_outputs').get().rollout_summary,'new')
 const empty=a.claimStage1Job('empty','one',100,10,2,'v1');assert.equal(a.stage1JobSucceededNoOutput('empty',empty.token,'v1'),true)
 assert.equal(a.stage1NeedsUpdate('empty',100),false)
 assert.equal(a.claimStage1Job('empty','one',100,10,2,'v1').outcome,'skipped_up_to_date')
})
test('cross-connection capacity, version CAS and preserved retries',t=>{
 const {a,b,source}=fixture(t);a.publishSources([source('a'),source('b')])
 const claim=a.claimStage1Job('a','one',100,20,1,'v1')
 assert.equal(b.claimStage1Job('b','two',100,20,1,'v1').outcome,'skipped_capacity')
 a.publishSources([source('a',{source_version:'v2'}),source('b')])
 assert.equal(a.stage1JobSucceeded('a',claim.token,{sourceUpdatedAt:100,rolloutSummary:'must not publish'},'v1'),false)
 assert.equal(a.stage1JobFailed('a',claim.token,'stale',30),true)
 assert.equal(a.claimStage1Job('a','one',100,20,1,'v2').outcome,'skipped_retry_backoff')
 const advanced=a.claimStage1Job('a','one',101,20,1,'v2');assert.equal(advanced.outcome,'claimed')
 assert.equal(a.db.prepare("SELECT retry_remaining FROM jobs WHERE job_key='a'").get().retry_remaining,3)
})
test('source absence counterevidence, modes, archived phase2 and exact selection flags',t=>{
 const {a,source}=fixture(t)
 a.initializeSource({id:'disabled',createdAt:0},{fresh:true,generateMemories:false})
 a.publishSources([source('a',{archived:true}),source('disabled')])
 assert.equal(a.getSource('disabled').memory_mode,'disabled')
 a.initializeSource({id:'disabled',createdAt:0},{fresh:false,generateMemories:true})
 assert.equal(a.getSource('disabled').memory_mode,'disabled')
 const c=a.claimStage1Job('a','w',100,20,2,'v1');a.stage1JobSucceeded('a',c.token,{sourceUpdatedAt:100,rolloutSummary:'summary'},'v1')
 assert.deepEqual(a.getPhase2InputSelection(1,30).map(x=>x.thread_id),['a'])
 a.publishSources([],{absenceSafe:false});assert.equal(a.getSource('a').presence,'present')
 assert.equal(a.tryClaimGlobalPhase2Job('w',20,0).outcome,'skipped_catalog_uncertain')
 a.publishSources([source('a',{archived:true})]);const p=a.tryClaimGlobalPhase2Job('w',20,0)
 assert.equal(p.outcome,'claimed');assert.equal(a.phase2JobSucceeded(p.token,100,a.getPhase2InputSelection(1,30),1),true)
 assert.equal(a.getProgress().max_thread_count,1)
 assert.equal(a.db.prepare('SELECT selected_for_phase2 FROM stage1_outputs').get().selected_for_phase2,1)
 a.setSourceMode('a','disabled');assert.deepEqual(a.getPhase2InputSelection(1,30),[])
 a.publishSources([]);assert.equal(a.getSource('a').presence,'missing')
})
test('reset barrier excludes live workers and stale filesystem publishers',t=>{
 const {a,b,source,tick}=fixture(t);a.publishSources([source('a')])
 const claim=a.tryClaimGlobalPhase2Job('worker',10,0)
 assert.throws(()=>b.beginReset(),e=>e.code==='busy')
 tick(1011);const generation=b.beginReset();assert.equal(b.control().reset_pending,1)
 assert.throws(()=>a.withOwnedMutation(claim.token,claim.generation,()=>assert.fail('stale publish')),e=>e.code==='lost_ownership'||e.code==='reset_pending')
 assert.equal(a.claimStage1Job('a','w',100,10,1,'v1').outcome,'skipped_reset')
 b.finishReset(generation);assert.equal(a.control().reset_pending,0)
 assert.equal(a.getSource('a').memory_mode,'enabled')
 assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0)
})
test('no-output removes old output and enqueues forgetting without losing success watermark',t=>{
 const {a,source}=fixture(t);a.publishSources([source('a')])
 const first=a.claimStage1Job('a','worker',100,30,2,'v1');a.stage1JobSucceeded('a',first.token,{sourceUpdatedAt:100,rolloutSummary:'old'},'v1')
 a.publishSources([source('a',{source_updated_at_ms:101000,source_version:'v2'})])
 const next=a.claimStage1Job('a','worker',101,30,2,'v2');assert.equal(a.stage1JobSucceededNoOutput('a',next.token,'v2'),true)
 assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM stage1_outputs').get().n,0)
 assert.equal(a.stage1NeedsUpdate('a',101),false)
 assert.equal(a.db.prepare("SELECT input_watermark FROM jobs WHERE job_key='global'").get().input_watermark,101)
})
test('pollution is persistent and explicit enable ignores previously processed events',t=>{
 const {a,source}=fixture(t)
 a.initializeSource({id:'a',createdAt:0},{fresh:true,disableOnExternalContext:true})
 a.publishSources([source('a')]);assert.equal(a.markPolluted('a',10),true)
 assert.equal(a.getSource('a').memory_mode,'polluted')
 a.initializeSource({id:'a',createdAt:0},{fresh:false,disableOnExternalContext:false})
 assert.equal(a.getSource('a').memory_mode,'polluted')
 a.setSourceMode('a','enabled',{eventSeq:10})
 assert.equal(a.markPolluted('a',10),false);assert.equal(a.markPolluted('a',11),true)
})
test('retention never re-extracts the same successful source and max count is monotonic',t=>{
 const {a,source,tick}=fixture(t);a.publishSources([source('a')])
 const job=a.claimStage1Job('a','w',100,30,2,'v1');a.stage1JobSucceeded('a',job.token,{sourceUpdatedAt:100,rolloutSummary:'summary'},'v1')
 const selected=a.getPhase2InputSelection(256,30)
 tick(60*86400);assert.equal(a.pruneStage1Outputs(30,200),1);assert.equal(a.stage1NeedsUpdate('a',100),false)
 const p=a.tryClaimGlobalPhase2Job('w',30,0);assert.equal(a.phase2JobSucceeded(p.token,p.watermark,selected),true)
 const q=a.tryClaimGlobalPhase2Job('w',30,0);assert.equal(a.phase2JobSucceeded(q.token,q.watermark,[]),true)
 assert.equal(a.getProgress().max_thread_count,1)
})
test('complete catalog is not truncated by the 5000-source claim scan limit',t=>{
 const {a,source}=fixture(t)
 const rows=Array.from({length:5003},(_,i)=>source('session-'+String(i).padStart(5,'0')))
 a.publishSources(rows);assert.equal(a.listSources().length,5003)
 assert.equal(a.eligibleStage1({currentThreadId:'none',maxAgeDays:30,minIdleHours:0}).length,5000)
 const before=a.getSource(rows[0].session_id)
 assert.equal(a.publishSources([],{backendIdentity:'first'}).certain,true)
 assert.equal(a.publishSources(rows,{backendIdentity:'changed'}).certain,false)
 assert.equal(a.getSource(before.session_id).presence,'missing')
})

test('enable compares the observed boundary with external events from another connection',t=>{
 const {a,b}=fixture(t)
 for(const mode of ['disabled','polluted']){
  const id='raced-'+mode;a.initializeSource({id,createdAt:0},{fresh:true,disableOnExternalContext:true});a.setSourceMode(id,mode,{eventSeq:1})
  assert.equal(b.markPolluted(id,2),false);assert.equal(a.getSource(id).memory_mode,mode)
  a.setSourceMode(id,'enabled',{eventSeq:1});assert.equal(b.getSource(id).memory_mode,'polluted');assert.equal(b.getSource(id).mode_event_seq,2)
  a.setSourceMode(id,'enabled',{eventSeq:2});assert.equal(a.getSource(id).memory_mode,'enabled')
  assert.equal(b.markPolluted(id,1),false);assert.equal(a.getSource(id).mode_event_seq,2)
  assert.equal(b.markPolluted(id,3),true);assert.equal(a.getSource(id).memory_mode,'polluted')
 }
})
