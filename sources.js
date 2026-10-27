import {lstat,readdir} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {createHash} from 'node:crypto'

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const accepted=new Set(['user/message','assistant/message','tool/result'])
const compatible=(a,b)=>['id','createdAt','cwd','parentSession','isSeeded','delegationDepth'].every(k=>(a?.[k]??(k==='isSeeded'?false:k==='delegationDepth'?0:null))===(b?.[k]??(k==='isSeeded'?false:k==='delegationDepth'?0:null)))
async function metadata(path){try{return await lstat(path,{bigint:true})}catch(error){if(error.code==='ENOENT')return null;throw error}}
function identity(stat){return stat?`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`:null}
async function selectedFile(expected,parseFilename){
 if(!expected)return null
 let entries
 try{entries=await readdir(dirname(expected),{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return null;throw error}
 const files=[]
 for(const entry of entries){
  const compressed=entry.name.endsWith('.zstd'),version=parseFilename(compressed?entry.name.slice(0,-5):entry.name)
  if(version!==undefined){if(!entry.isFile())throw Object.assign(new Error('session generation is not a regular file'),{code:'source_conflict'});files.push({path:join(dirname(expected),entry.name),version})}
 }
 files.sort((a,b)=>b.version-a.version)
 if(files.length>1&&files[0].version===files[1].version)throw Object.assign(new Error('session compression conflict'),{code:'source_conflict'})
 return files[0]??null
}
async function inventory(root,known){
 const directories=new Map();let complete=true
 if(!root)return {directories,complete:false}
 const rootInfo=await metadata(root)
 if(!rootInfo)return {directories,complete:true}
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())return {directories,complete:false}
 for(const project of await readdir(root,{withFileTypes:true})){
  if(project.isSymbolicLink()){complete=false;continue}
  if(!project.isDirectory())continue
  for(const session of await readdir(join(root,project.name),{withFileTypes:true})){
   if(session.isSymbolicLink()){complete=false;continue}
   if(!session.isDirectory())continue
   const id=known.get(session.name)
   if(!id){complete=false;continue}
   const paths=directories.get(id)??[];paths.push(join(root,project.name,session.name));directories.set(id,paths)
  }
 }
 return {directories,complete}
}
function localLocation(ctx,header){const target=ctx.sessionPersistence?.locate?.(header);return target?.kind==='jsonl'&&typeof target.path==='string'?resolve(target.path):null}
async function inspect(ctx,record,persisted,archived,parseFilename,signal){
 signal?.throwIfAborted()
 const header=record.header,id=header.id,location=localLocation(ctx,header)
 const physical=await selectedFile(location,parseFilename),stat=physical?await metadata(physical.path):null
 if(stat?.isSymbolicLink())throw Object.assign(new Error('session artifact is a symlink'),{code:'source_conflict'})
 if(persisted?.header&&!compatible(header,persisted.header))throw Object.assign(new Error('session headers disagree'),{code:'source_conflict'})
 const live=ctx.sessions?.get(id)
 let events,cursor,revision=record.live?undefined:persisted?.revision
 if(live){events=live.snapshotEvents();cursor=typeof live.seq==='number'?live.seq-1:events.at(-1)?.seq??-1}
 else if(!location&&record.persisted&&record.formatStatus!=='unsupported'){
  const lease=await ctx.sessionQuery.observeSession(id,{projectionMode:'none',signal})
  try {events=lease.events;cursor=lease.cursor;revision=lease.revision;if(!compatible(header,lease.header))throw Object.assign(new Error('observed header changed'),{code:'source_conflict'})}
  finally{lease[Symbol.dispose]()}
 }
 let updated=stat?Number(stat.mtimeNs)/1e6:0
 if(events)for(const event of events)if(accepted.has(event.type)&&Number.isFinite(event.time))updated=Math.max(updated,event.time)
 const state={path:physical?.path??null,identity:identity(stat),revision:persisted?.revision??revision??null,cursor:live?cursor??null:null}
 const sourceVersion=digest([header.id,header.createdAt,header.cwd,state])
 const unsupported=physical?.version>4||record.formatStatus==='unsupported'
 const missing=!live&&record.persisted&&location&&!physical
 const readStatus=unsupported?'unsupported':missing?'unreadable':updated>0?'ready':'pending'
 const snapshot={sessionId:id,header,kind:live||physical?.version!==4?'exact':'v4',path:physical?.path,sourceVersion,revision,cursor,state,location}
 return {session_id:id,header,created_at_ms:header.createdAt,cwd:header.cwd,parent_id:header.parentSession??null,origin:header.origin??null,
  delegation_depth:header.delegationDepth??0,git_branch:header.git?.branch??null,live:!!live,persisted:record.persisted,archived:archived.has(id),
  presence:missing?'unknown':'present',read_status:readStatus,physical_path:physical?.path??null,physical_version:physical?.version??null,
  fs_identity:state.identity,persistence_revision:persisted?.revision??null,live_cursor:cursor??null,source_updated_at_ms:updated,source_version:sourceVersion,snapshot,
  last_error:unsupported?'unsupported_format':missing?'physical_source_missing':null}
}
export async function syncSourceCatalog(ctx,store,{parseFilename,signal,warn}={}){
 try{
  const records=await ctx.sessionQuery.listSessions(signal)
  const persisted=new Map((await ctx.sessionPersistence?.list?.({signal})??[]).map(x=>[x.header.id,x]))
  const archived=new Set(ctx.workspaceRegistry?.archivedSessionIds??[]),known=new Map(),headers=new Map()
  for(const old of store.listSources())headers.set(old.session_id,old.header??{id:old.session_id})
  for(const record of records)headers.set(record.header.id,record.header)
  let root
  for(const [id,header]of headers){const path=localLocation(ctx,header);if(path){known.set(basename(dirname(path)),id);const candidate=dirname(dirname(dirname(path)));if(root&&root!==candidate)throw new Error('session backend roots disagree');root=candidate}}
  if(!root){const path=localLocation(ctx,{id:'_memory_inventory_probe'});if(path)root=dirname(dirname(dirname(path)))}
  const physical=await inventory(root,known),rows=[],seen=new Set()
  for(const record of records){
   signal?.throwIfAborted();const id=record.header.id;seen.add(id)
   if((physical.directories.get(id)?.length??0)>1){rows.push({...store.getSource(id),session_id:id,header:record.header,presence:store.getSource(id)?.presence??'unknown',read_status:'conflict',last_error:'duplicate_source'});continue}
   try{rows.push(await inspect(ctx,record,persisted.get(id),archived,parseFilename,signal))}
   catch(error){signal?.throwIfAborted();rows.push({...store.getSource(id),session_id:id,header:record.header,presence:store.getSource(id)?.presence??'unknown',read_status:error.code==='source_conflict'?'conflict':'unreadable',last_error:error.code??'source_read_failed'});physical.complete=false;warn?.('source inspection failed',{error,sessionId:id})}
  }
  for(const [id]of physical.directories)if(!seen.has(id)){
   const old=store.getSource(id);if(old)rows.push({...old,read_status:'unreadable',last_error:'not_in_logical_corpus'})
   physical.complete=false
  }
  const absent=store.listSources().some(x=>!seen.has(x.session_id)&&x.presence!=='missing')
  // A remote/live-only corpus can prove presence, but not physical absence.
  const absenceSafe=physical.complete||!absent&&rows.every(x=>x.presence==='present'&&x.read_status!=='conflict')
  return store.publishSources(rows,{complete:true,absenceSafe,liveIds:records.filter(x=>x.live).map(x=>x.header.id),backendIdentity:root??'nonlocal'})
 }catch(error){signal?.throwIfAborted();store.publishSources([],{complete:false,absenceSafe:false});warn?.('source catalog sync failed',{error});return {certain:false,error}}
}
export async function validateSourceSnapshot(ctx,snapshot,{parseFilename,signal}={}){
 signal?.throwIfAborted()
 const physical=await selectedFile(snapshot.location,parseFilename),stat=physical?await metadata(physical.path):null
 const live=ctx.sessions?.get(snapshot.sessionId),cursor=live?(typeof live.seq==='number'?live.seq-1:live.snapshotEvents().at(-1)?.seq??-1):null
 const persisted=await ctx.sessionPersistence?.stat?.(snapshot.sessionId,{signal})
 if(persisted?.header&&!compatible(snapshot.header,persisted.header))return false
 const state={path:physical?.path??null,identity:identity(stat),revision:persisted?.revision??null,cursor}
 return digest([snapshot.header.id,snapshot.header.createdAt,snapshot.header.cwd,state])===snapshot.sourceVersion
}
