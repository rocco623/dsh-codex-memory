import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const JOB_KIND_STAGE1='memory_stage1'
export const JOB_KIND_PHASE2='memory_consolidate_global'
export const PHASE2_JOB_KEY='global'
const fail=code=>{throw Object.assign(new Error(`memory state ${code}`),{code})}
const SCHEMA=`
CREATE TABLE IF NOT EXISTS stage1_outputs (
 thread_id TEXT PRIMARY KEY,source_updated_at INTEGER NOT NULL,raw_memory TEXT,rollout_summary TEXT NOT NULL,
 rollout_slug TEXT,generated_at INTEGER NOT NULL,usage_count INTEGER,last_usage INTEGER,
 selected_for_phase2 INTEGER NOT NULL DEFAULT 0,selected_for_phase2_source_updated_at INTEGER);
CREATE TABLE IF NOT EXISTS jobs (
 kind TEXT NOT NULL,job_key TEXT NOT NULL,status TEXT NOT NULL,worker_id TEXT,ownership_token TEXT,
 started_at INTEGER,finished_at INTEGER,lease_until INTEGER,retry_at INTEGER,retry_remaining INTEGER NOT NULL,
 last_error TEXT,input_watermark INTEGER,last_success_watermark INTEGER,PRIMARY KEY(kind,job_key));
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease ON jobs(kind,status,retry_at,lease_until);
CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at ON stage1_outputs(source_updated_at DESC,thread_id DESC);
CREATE TABLE IF NOT EXISTS memory_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL DEFAULT 0,
 reset_pending INTEGER NOT NULL DEFAULT 0,sync_epoch INTEGER NOT NULL DEFAULT 0,catalog_ready INTEGER NOT NULL DEFAULT 0,backend_identity TEXT);
INSERT OR IGNORE INTO memory_control(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS consolidation_progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1),max_thread_count INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO consolidation_progress(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS source_catalog (
 session_id TEXT PRIMARY KEY,created_at_ms INTEGER NOT NULL DEFAULT 0,cwd TEXT,git_branch TEXT,parent_id TEXT,origin TEXT,
 delegation_depth INTEGER NOT NULL DEFAULT 0,live INTEGER NOT NULL DEFAULT 0,persisted INTEGER NOT NULL DEFAULT 0,
 archived INTEGER NOT NULL DEFAULT 0,presence TEXT NOT NULL DEFAULT 'present',read_status TEXT NOT NULL DEFAULT 'pending',
 physical_path TEXT,physical_version INTEGER,fs_identity TEXT,persistence_revision TEXT,live_cursor INTEGER,
 source_updated_at_ms INTEGER NOT NULL DEFAULT 0,source_version TEXT,last_complete_sync_id INTEGER,
 memory_mode TEXT NOT NULL DEFAULT 'enabled',mode_origin TEXT NOT NULL DEFAULT 'legacy_default',mode_version INTEGER NOT NULL DEFAULT 0,
 disable_external INTEGER,mode_event_seq INTEGER NOT NULL DEFAULT -1,last_error TEXT,header_json TEXT,snapshot_json TEXT);
CREATE TABLE IF NOT EXISTS citation_messages(session_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(session_id,message_id));
`
export function openMemoryStore(path,{clock=()=>Math.floor(Date.now()/1000)}={}) {
 mkdirSync(dirname(path),{recursive:true})
 const db=new DatabaseSync(path)
 try {db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');db.exec(SCHEMA);return new MemoryStore(db,clock)}
 catch(error){db.close();throw error}
}
class MemoryStore {
 constructor(db,clock){
  this.db=db;this.clock=clock
  this.atomic(()=>{
   const columns=new Set(this.all('PRAGMA table_info(jobs)').map(x=>x.name))
   if(!columns.has('source_version')&&this.get("SELECT COUNT(*) AS n FROM jobs WHERE status='running' AND lease_until>?",clock()).n)fail('migration_busy')
   if(!this.all('PRAGMA table_info(memory_control)').some(x=>x.name==='backend_identity'))db.exec('ALTER TABLE memory_control ADD COLUMN backend_identity TEXT')
   this.run("INSERT OR IGNORE INTO source_catalog(session_id,presence) SELECT thread_id,'unknown' FROM stage1_outputs")
   if(!columns.has('generation'))db.exec('ALTER TABLE jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
   if(!columns.has('source_version'))db.exec('ALTER TABLE jobs ADD COLUMN source_version TEXT')
   const legacy=this.get("SELECT * FROM jobs WHERE kind='memory_consolidation' AND job_key='global'")
   if(legacy){
    if(legacy.status==='running'&&legacy.lease_until>clock())fail('migration_busy')
    if(this.get('SELECT 1 FROM jobs WHERE kind=? AND job_key=?',JOB_KIND_PHASE2,PHASE2_JOB_KEY))fail('migration_conflict')
    this.run("UPDATE jobs SET kind=? WHERE kind='memory_consolidation' AND job_key='global'",JOB_KIND_PHASE2)
   }
  })
 }
 get(sql,...args){return this.db.prepare(sql).get(...args.map(x=>typeof x==='boolean'?Number(x):x??null))}
 all(sql,...args){return this.db.prepare(sql).all(...args.map(x=>typeof x==='boolean'?Number(x):x??null))}
 run(sql,...args){return this.db.prepare(sql).run(...args.map(x=>typeof x==='boolean'?Number(x):x??null))}
 atomic(fn){
  const nested=this.db.isTransaction
  if(!nested)this.db.exec('BEGIN IMMEDIATE')
  try {const result=fn();if(result&&typeof result.then==='function')fail('async_transaction');if(!nested)this.db.exec('COMMIT');return result}
  catch(error){if(!nested)try{this.db.exec('ROLLBACK')}catch(rollback){throw new AggregateError([error,rollback],'memory transaction rollback failed')}throw error}
 }
 close(){this.db.close()}
 control(){return this.get('SELECT * FROM memory_control WHERE singleton=1')}
 getProgress(){return this.get('SELECT * FROM consolidation_progress WHERE singleton=1')}
 getSource(id){const row=this.get('SELECT * FROM source_catalog WHERE session_id=?',id);return row?{...row,header:JSON.parse(row.header_json||'null'),snapshot:JSON.parse(row.snapshot_json||'null')}:null}
 listSources(){return this.all('SELECT session_id FROM source_catalog ORDER BY session_id').map(x=>this.getSource(x.session_id))}
 initializeSource(header,{fresh=false,generateMemories=true,disableOnExternalContext=false}={}){
  return this.atomic(()=>{
   this.run(`INSERT OR IGNORE INTO source_catalog(session_id,created_at_ms,cwd,parent_id,origin,delegation_depth,memory_mode,mode_origin,disable_external,header_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,header.id,header.createdAt??0,header.cwd,header.parentSession,header.origin,header.delegationDepth??0,
    fresh&&!generateMemories?'disabled':'enabled',fresh?'creation':'legacy_default',fresh?disableOnExternalContext:null,JSON.stringify(header))
   if(fresh)this.run("UPDATE source_catalog SET memory_mode=?,mode_origin='creation',disable_external=? WHERE session_id=? AND mode_origin='legacy_default' AND mode_version=0",generateMemories?'enabled':'disabled',disableOnExternalContext,header.id)
   return this.getSource(header.id)
  })
 }
 publishSources(rows,{complete=true,absenceSafe=true,liveIds=[],backendIdentity}={}){
  return this.atomic(()=>{
   const state=this.control(),epoch=state.sync_epoch+1,seen=new Set(liveIds)
   if(backendIdentity&&state.backend_identity&&state.backend_identity!==backendIdentity){this.run('UPDATE memory_control SET catalog_ready=0 WHERE singleton=1');return {epoch:state.sync_epoch,certain:false,error:'backend_changed'}}
   let certain=complete&&absenceSafe&&(!backendIdentity||!state.backend_identity||state.backend_identity===backendIdentity)
   if(backendIdentity&&!state.backend_identity)this.run('UPDATE memory_control SET backend_identity=? WHERE singleton=1',backendIdentity)
   const keys=['created_at_ms','cwd','git_branch','parent_id','origin','delegation_depth','live','persisted','archived','presence','read_status','physical_path','physical_version','fs_identity','persistence_revision','live_cursor','source_updated_at_ms','source_version','last_error']
   for(const row of rows){
    const id=row.session_id??row.header?.id;if(!id)fail('invalid_source')
    seen.add(id);this.initializeSource(row.header??{id,createdAt:row.created_at_ms??0})
    const old=this.getSource(id),merged={...old,...row,created_at_ms:row.created_at_ms??row.header?.createdAt??old.created_at_ms,last_complete_sync_id:complete?epoch:old.last_complete_sync_id}
    if(row.read_status==='conflict'||row.presence==='unknown')certain=false
    this.run(`UPDATE source_catalog SET ${keys.map(k=>`${k}=?`).join(',')},last_complete_sync_id=?,header_json=?,snapshot_json=? WHERE session_id=?`,
     ...keys.map(k=>merged[k]),merged.last_complete_sync_id,JSON.stringify(row.header??old.header),JSON.stringify(row.snapshot??old.snapshot),id)
   }
   if(certain)for(const old of this.all("SELECT session_id FROM source_catalog WHERE presence!='missing'"))if(!seen.has(old.session_id)){
    this.run("UPDATE source_catalog SET presence='missing',live=0,last_complete_sync_id=? WHERE session_id=?",epoch,old.session_id)
    this.forgetSelected(old.session_id)
   }
   this.run('UPDATE memory_control SET sync_epoch=?,catalog_ready=? WHERE singleton=1',complete?epoch:state.sync_epoch,certain)
   return {epoch,certain}
  })
 }
 setSourceMode(id,mode,{origin='config',eventSeq}={}){
  if(!['enabled','disabled','polluted'].includes(mode))fail('invalid_mode')
  return this.atomic(()=>{
   const row=this.getSource(id);if(!row)return false
   this.run('UPDATE source_catalog SET memory_mode=?,mode_origin=?,mode_version=mode_version+1,mode_event_seq=? WHERE session_id=?',mode,origin,eventSeq??row.mode_event_seq,id)
   if(mode!=='enabled')this.forgetSelected(id)
   return true
  })
 }
 markPolluted(id,eventSeq){
  return this.atomic(()=>{const row=this.getSource(id);if(!row?.disable_external||row.memory_mode!=='enabled'||eventSeq<=row.mode_event_seq)return false;return this.setSourceMode(id,'polluted',{origin:'external_context',eventSeq})})
 }
 forgetSelected(id){if(this.get('SELECT selected_for_phase2 FROM stage1_outputs WHERE thread_id=?',id)?.selected_for_phase2)this.enqueueConsolidation(this.clock())}
 eligibleStage1({currentThreadId,maxAgeDays,minIdleHours,nowMs=this.clock()*1000}){
  return this.all(`SELECT * FROM source_catalog WHERE session_id!=? AND presence='present' AND read_status='ready'
   AND memory_mode='enabled' AND archived=0 AND COALESCE(origin,'') IN ('','cli','web','api','user','interactive','vscode') AND delegation_depth=0
   AND source_updated_at_ms>=? AND source_updated_at_ms<=? ORDER BY source_updated_at_ms DESC,session_id DESC LIMIT 5000`,
   currentThreadId,nowMs-Math.max(0,maxAgeDays)*86400000,nowMs-Math.max(0,minIdleHours)*3600000).map(x=>this.getSource(x.session_id))
 }
 stage1NeedsUpdate(id,watermark){
  const output=this.get('SELECT source_updated_at FROM stage1_outputs WHERE thread_id=?',id)
  const job=this.get('SELECT last_success_watermark FROM jobs WHERE kind=? AND job_key=?',JOB_KIND_STAGE1,id)
  return !(output?.source_updated_at>=watermark||job?.last_success_watermark!=null&&job.last_success_watermark>=watermark)
 }
 claimStage1Job(id,worker,watermark,lease,maxRunning,version){
  return this.atomic(()=>{
   const control=this.control(),t=this.clock(),source=this.getSource(id)
   const skip=reason=>({outcome:`skipped_${reason}`})
   if(control.reset_pending)return skip('reset')
   if(!source||source.presence!=='present'||source.memory_mode!=='enabled'||source.read_status!=='ready')return skip('source')
   if(version!==undefined&&source.source_version!==version)return skip('stale')
   if(!this.stage1NeedsUpdate(id,watermark))return skip('up_to_date')
   const old=this.get('SELECT * FROM jobs WHERE kind=? AND job_key=?',JOB_KIND_STAGE1,id)
   const advanced=watermark>(old?.input_watermark??-1)
   if(old?.status==='running'&&old.lease_until>t)return skip('running')
   if(!advanced&&old?.retry_at>t)return skip('retry_backoff')
   if(!advanced&&old?.retry_remaining<=0)return skip('retry_exhausted')
   if(this.get("SELECT COUNT(*) AS n FROM jobs WHERE kind=? AND status='running' AND lease_until>?",JOB_KIND_STAGE1,t).n>=maxRunning)return skip('capacity')
   const token=randomUUID()
   this.run(`INSERT INTO jobs(kind,job_key,status,worker_id,ownership_token,started_at,lease_until,retry_remaining,input_watermark,generation,source_version)
    VALUES(?,?,'running',?,?,?,?,?,?,?,?) ON CONFLICT(kind,job_key) DO UPDATE SET status='running',worker_id=excluded.worker_id,
    ownership_token=excluded.ownership_token,started_at=excluded.started_at,finished_at=NULL,lease_until=excluded.lease_until,retry_at=NULL,
    retry_remaining=excluded.retry_remaining,last_error=NULL,input_watermark=excluded.input_watermark,generation=excluded.generation,source_version=excluded.source_version`,
    JOB_KIND_STAGE1,id,worker,token,t,t+Math.max(0,lease),advanced?3:old.retry_remaining,watermark,control.generation,version??source.source_version)
   return {outcome:'claimed',token,generation:control.generation,sourceVersion:version??source.source_version,watermark}
  })
 }
 tryClaimStage1Job(...args){return this.claimStage1Job(...args).token??null}
 ownedStage1(id,token,version){
  const row=this.get("SELECT * FROM jobs WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?",JOB_KIND_STAGE1,id,token)
  const control=this.control(),source=this.getSource(id)
  return row&&!control.reset_pending&&row.generation===control.generation&&source?.presence==='present'&&source.memory_mode==='enabled'
   &&(version===undefined||source.source_version===version)&&row.source_version===source.source_version?row:null
 }
 stage1JobSucceeded(id,token,output,version){
  return this.atomic(()=>{
   const row=this.ownedStage1(id,token,version);if(!row)return false
   if(!output||typeof output.rolloutSummary!=='string')fail('invalid_output')
   this.run(`INSERT INTO stage1_outputs(thread_id,source_updated_at,raw_memory,rollout_summary,rollout_slug,generated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,raw_memory=excluded.raw_memory,rollout_summary=excluded.rollout_summary,
    rollout_slug=excluded.rollout_slug,generated_at=excluded.generated_at WHERE excluded.source_updated_at>=stage1_outputs.source_updated_at`,
    id,output.sourceUpdatedAt??row.input_watermark,output.rawMemory??'',output.rolloutSummary,output.rolloutSlug,this.clock())
   this.finishStage1(id,token);this.enqueueConsolidation(output.sourceUpdatedAt??row.input_watermark);return true
  })
 }
 finishStage1(id,token){return this.run("UPDATE jobs SET status='done',finished_at=?,lease_until=NULL,last_error=NULL,last_success_watermark=input_watermark WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?",this.clock(),JOB_KIND_STAGE1,id,token).changes>0}
 stage1JobSucceededNoOutput(id,token,version){return this.atomic(()=>{const row=this.ownedStage1(id,token,version);if(!row)return false;this.finishStage1(id,token);if(this.run('DELETE FROM stage1_outputs WHERE thread_id=?',id).changes)this.enqueueConsolidation(row.input_watermark);return true})}
 stage1JobFailed(id,token,reason,delay){return this.run("UPDATE jobs SET status='error',finished_at=?,lease_until=NULL,retry_at=?,retry_remaining=MAX(retry_remaining-1,0),last_error=? WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?",this.clock(),this.clock()+Math.max(0,delay),reason,JOB_KIND_STAGE1,id,token).changes>0}
 pruneStage1Outputs(days,limit){return this.run(`DELETE FROM stage1_outputs WHERE thread_id IN (SELECT thread_id FROM stage1_outputs WHERE selected_for_phase2=0 AND COALESCE(last_usage,source_updated_at)<? ORDER BY COALESCE(last_usage,source_updated_at),source_updated_at,thread_id LIMIT ?)`,this.clock()-Math.max(0,days)*86400,Math.max(0,limit)).changes}
 enqueueConsolidation(watermark){
  this.run(`INSERT INTO jobs(kind,job_key,status,retry_remaining,input_watermark,last_success_watermark) VALUES(?,?,'pending',3,?,0)
   ON CONFLICT(kind,job_key) DO UPDATE SET status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'pending' END,
   retry_at=CASE WHEN jobs.status='running' THEN jobs.retry_at ELSE NULL END,retry_remaining=MAX(jobs.retry_remaining,3),
   input_watermark=CASE WHEN excluded.input_watermark>COALESCE(jobs.input_watermark,0) THEN excluded.input_watermark ELSE COALESCE(jobs.input_watermark,0)+1 END`,JOB_KIND_PHASE2,PHASE2_JOB_KEY,watermark)
 }
 recordCitationUsage(sessionId,messageId,ids){return this.atomic(()=>{
  if(!this.run('INSERT OR IGNORE INTO citation_messages VALUES(?,?)',sessionId,messageId).changes)return 0
  return this.recordStage1OutputUsage(ids.filter(id=>this.getSource(id)))
 })}
 recordStage1OutputUsage(ids){return this.atomic(()=>{let n=0;for(const id of new Set(ids))n+=this.run('UPDATE stage1_outputs SET usage_count=COALESCE(usage_count,0)+1,last_usage=? WHERE thread_id=?',this.clock(),id).changes;return n})}
 getPhase2InputSelection(limit,days){
  return this.all(`SELECT so.*,s.cwd,s.physical_path AS rollout_path,s.git_branch FROM stage1_outputs so JOIN source_catalog s ON s.session_id=so.thread_id
   WHERE s.presence='present' AND s.memory_mode='enabled' AND (length(trim(so.raw_memory))>0 OR length(trim(so.rollout_summary))>0)
   AND COALESCE(so.last_usage,so.source_updated_at)>=? ORDER BY COALESCE(so.usage_count,0) DESC,COALESCE(so.last_usage,so.source_updated_at) DESC,
   so.source_updated_at DESC,so.thread_id DESC LIMIT ?`,this.clock()-Math.max(0,days)*86400,Math.max(0,limit)).sort((a,b)=>Buffer.compare(Buffer.from(a.thread_id),Buffer.from(b.thread_id)))
 }
 tryClaimGlobalPhase2Job(worker,lease,cooldown){return this.atomic(()=>{
  const control=this.control(),t=this.clock(),skip=reason=>({outcome:`skipped_${reason}`})
  if(control.reset_pending)return skip('reset')
  if(!control.catalog_ready)return skip('catalog_uncertain')
  const old=this.get('SELECT * FROM jobs WHERE kind=? AND job_key=?',JOB_KIND_PHASE2,PHASE2_JOB_KEY)
  if(old?.retry_at>t)return skip('retry_unavailable')
  if(old?.status==='running'&&old.lease_until>t)return skip('running')
  if(old&&old.last_error==null&&old.finished_at!=null&&old.finished_at>t-cooldown)return skip('cooldown')
  const token=randomUUID(),watermark=old?.input_watermark??0
  this.run(`INSERT INTO jobs(kind,job_key,status,worker_id,ownership_token,started_at,lease_until,retry_remaining,input_watermark,last_success_watermark,generation)
   VALUES(?,?,'running',?,?,?,?,3,?,0,?) ON CONFLICT(kind,job_key) DO UPDATE SET status='running',worker_id=excluded.worker_id,
   ownership_token=excluded.ownership_token,started_at=excluded.started_at,finished_at=NULL,lease_until=excluded.lease_until,retry_at=NULL,last_error=NULL,generation=excluded.generation`,
   JOB_KIND_PHASE2,PHASE2_JOB_KEY,worker,token,t,t+Math.max(0,lease),watermark,control.generation)
  return {outcome:'claimed',token,watermark,generation:control.generation}
 })}
 assertPhase2Ownership(token,generation){
  const control=this.control()
  if(control.reset_pending)fail('reset_pending')
  if(!control.catalog_ready)fail('catalog_uncertain')
  const job=this.get("SELECT * FROM jobs WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?",JOB_KIND_PHASE2,PHASE2_JOB_KEY,token)
  if(!job||job.generation!==control.generation||generation!==control.generation||job.lease_until<=this.clock())fail('lost_ownership')
  return job
 }
 withOwnedMutation(token,generation,fn){return this.atomic(()=>{this.assertPhase2Ownership(token,generation);return fn()})}
 withControlMutation(fn){return this.atomic(()=>{if(this.control().reset_pending)fail('reset_pending');return fn()})}
 heartbeatGlobalPhase2Job(token,lease){return this.atomic(()=>{
  const state=this.control();if(state.reset_pending)return false
  return this.run("UPDATE jobs SET lease_until=? WHERE kind=? AND job_key=? AND status='running' AND ownership_token=? AND generation=? AND lease_until>?",this.clock()+Math.max(0,lease),JOB_KIND_PHASE2,PHASE2_JOB_KEY,token,state.generation,this.clock()).changes>0
 })}
 phase2JobSucceeded(token,watermark,selected){return this.atomic(()=>{
  const generation=this.control().generation
  try{this.assertPhase2Ownership(token,generation)}catch(error){if(['lost_ownership','reset_pending'].includes(error.code))return false;throw error}
  if(!this.control().catalog_ready)return false
  this.run("UPDATE jobs SET status='done',finished_at=?,lease_until=NULL,last_error=NULL,last_success_watermark=MAX(COALESCE(last_success_watermark,0),?) WHERE kind=? AND job_key=? AND ownership_token=?",this.clock(),watermark,JOB_KIND_PHASE2,PHASE2_JOB_KEY,token)
  this.run('UPDATE stage1_outputs SET selected_for_phase2=0,selected_for_phase2_source_updated_at=NULL')
  for(const row of selected)this.run('UPDATE stage1_outputs SET selected_for_phase2=1,selected_for_phase2_source_updated_at=? WHERE thread_id=? AND source_updated_at=?',row.source_updated_at,row.thread_id,row.source_updated_at)
  this.run('UPDATE consolidation_progress SET max_thread_count=MAX(max_thread_count,?) WHERE singleton=1',selected.length)
  return true
 })}
 phase2JobFailed(token,reason,delay){return this.run("UPDATE jobs SET status='error',finished_at=?,lease_until=NULL,retry_at=?,retry_remaining=MAX(retry_remaining-1,0),last_error=? WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?",this.clock(),this.clock()+Math.max(0,delay),reason,JOB_KIND_PHASE2,PHASE2_JOB_KEY,token).changes>0}
 beginReset(){return this.atomic(()=>{
  const current=this.control();if(current.reset_pending)return current.generation
  if(this.get("SELECT COUNT(*) AS n FROM jobs WHERE status='running' AND lease_until>?",this.clock()).n)fail('busy')
  this.run('UPDATE memory_control SET generation=generation+1,reset_pending=1 WHERE singleton=1');return this.control().generation
 })}
 resetMutation(generation,fn){return this.atomic(()=>{const state=this.control();if(!state.reset_pending||state.generation!==generation)fail('lost_reset');return fn()})}
 finishReset(generation){return this.resetMutation(generation,()=>{this.run('DELETE FROM stage1_outputs');this.run('DELETE FROM jobs WHERE kind IN (?,?)',JOB_KIND_STAGE1,JOB_KIND_PHASE2);this.run('UPDATE consolidation_progress SET max_thread_count=0');this.run('UPDATE memory_control SET reset_pending=0 WHERE singleton=1')})}
}
