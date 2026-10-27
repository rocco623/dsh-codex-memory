import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {openMemoryStore} from './db.js'
import { createMemoryBackend } from './memory-backend.js'
import { createPrivateWorkspaceTools } from './private-workspace-tools.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { prepareMemoryWorkspace, memoryWorkspaceDiff, resetMemoryWorkspaceBaseline, writeWorkspaceDiff, WORKSPACE_DIFF_FILENAME, removeMemorySymlinks, isValidV2Summary, validateConsolidationArtifacts } from './workspace.js'
import { seedExtensionInstructions, syncRolloutSummariesFromMemories, pruneOldExtensionResources, rolloutSummaryFileStem } from './storage.js'

const git = (root,args) => execFileSync('git',['-c','core.hooksPath=/dev/null',`--git-dir=${join(root,'.git')}`,`--work-tree=${root}`,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})

function temporary(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-memory-task3-'))
  t.after(() => { assert.equal(resolve(root), root); assert.ok(root.startsWith(join(tmpdir(), 'dsh-memory-task3-'))); fs.rmSync(root, {recursive:true, force:true}) })
  return root
}

test('fixed native literal fixture responses',t=>{
 const bytes=fs.readFileSync(new URL('./task3-fixtures.json',import.meta.url))
 const manifest=JSON.parse(fs.readFileSync(new URL('./task3-oracle-hashes.json',import.meta.url),'utf8'))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.local_fixture.sha256)
 const fixtures=JSON.parse(bytes)
 for(const fixture of fixtures.cases) {
  const root=temporary(t)
  for(const [name,text] of Object.entries(fixture.files))fs.writeFileSync(join(root,name),text)
  assert.deepEqual(createMemoryBackend(root)[fixture.method](fixture.request),fixture.expected,fixture.oracle)
 }
})

test('standard caps, exact 20k-token UTF-8 read, legacy branches and strict errors',t=>{
 const root=temporary(t),b=createMemoryBackend(root)
 for(let i=0;i<2005;i++)fs.writeFileSync(join(root,`entry-${String(i).padStart(4,'0')}.any`),'needle\n')
 assert.equal(b.list().entries.length,2000)
 assert.equal(b.list({max_results:5000}).entries.length,2000)
 assert.equal(b.search({queries:['needle']}).matches.length,200)
 assert.equal(b.search({queries:['needle'],max_results:5000}).matches.length,200)
 assert.equal(b.search({query:'NEEDLE'}).length,40)
 assert.throws(()=>b.search({query:'x',queries:['x']}),{code:'InvalidArgument'})
 fs.writeFileSync(join(root,'unicode'),'界'.repeat(26668))
 const r=b.read({path:'unicode'})
 assert.equal(r.content,'界'.repeat(13333)+'…1 tokens truncated…'+'界'.repeat(13333))
 assert.equal(r.truncated,true)
 assert.throws(()=>b.read({path:'unicode',line_offset:0}),{code:'InvalidLineOffset'})
 assert.throws(()=>b.read({path:'unicode',max_lines:0}),{code:'InvalidMaxLines'})
 fs.writeFileSync(join(root,'bom'),'\ufeffA\ntrailing\r')
 assert.equal(b.read({path:'bom'}).content,'\ufeffA\ntrailing\r')
 assert.equal(b.search({path:'bom',queries:['\ufeff']}).matches[0].content,'\ufeffA')
 assert.equal(b.search({path:'bom',queries:['trailing'],context_lines:1}).matches[0].content,'\ufeffA\ntrailing\r')
 fs.writeFileSync(join(root,'invalid'),Buffer.from([0xff,0xfe]))
 assert.deepEqual(b.search({path:'invalid',queries:['x']}).matches,[])
 assert.throws(()=>b.read({path:'invalid'}),{code:'ERR_ENCODING_INVALID_ENCODED_DATA'})
 const message=b.note({note:' explicit\n'})
 assert.ok(message.startsWith('noted in extensions/ad_hoc/notes/'))
 const notes=b.list({path:'extensions/ad_hoc/notes'}).entries
 assert.equal(b.read({path:notes[0].path}).content,' explicit\n')
})

test('native UUID timestamp/hash and slug storage literals',()=>{
 // codex-rs/memories/write/src/storage_tests.rs: FIXED_PREFIX and stem tests.
 const input={threadId:'0194f5a6-89ab-7cde-8123-456789abcdef',sourceUpdatedAt:123}
 assert.equal(rolloutSummaryFileStem(input),'2025-02-11T15-35-19-jqmb')
 assert.equal(rolloutSummaryFileStem({...input,rolloutSlug:''}),'2025-02-11T15-35-19-jqmb')
 assert.equal(rolloutSummaryFileStem({...input,rolloutSlug:'Unsafe Slug/With Spaces & Symbols + EXTRA_LONG_12345_67890_ABCDE_fghij_klmno'}),'2025-02-11T15-35-19-jqmb-unsafe_slug_with_spaces___symbols___extra_long_12345_67890_a')
})

test('seed/sync/prune protect symlinks, strict calendar timestamps and warn/continue',async t=>{
 const root=temporary(t),outside=temporary(t),warnings=[]
 const options={warn:(event,detail)=>warnings.push([event,detail])}
 fs.writeFileSync(join(outside,'instructions.md'),'must remain')
 fs.symlinkSync(outside,join(root,'extensions'))
 await assert.rejects(seedExtensionInstructions(root),{code:'InvalidPath'})
 await pruneOldExtensionResources(root,Date.UTC(2026,9,26),options)
 assert.equal(warnings.length,1)
 assert.equal(fs.readFileSync(join(outside,'instructions.md'),'utf8'),'must remain')
 const link=join(root,'extensions');assert.equal(resolve(link),join(root,'extensions'));fs.unlinkSync(link)
 await seedExtensionInstructions(root)
 fs.writeFileSync(join(root,'extensions/ad_hoc/instructions.md'),'custom')
 await seedExtensionInstructions(root)
 assert.equal(fs.readFileSync(join(root,'extensions/ad_hoc/instructions.md'),'utf8'),'custom')
 const resources=join(root,'extensions/ad_hoc/resources');fs.mkdirSync(resources)
 for(const name of ['2026-10-12T00-00-00-expired.md','2026-10-12T00-00-01-fresh.md','2026-02-30T00-00-00-invalid.md','2026-00-01T00-00-00-invalid.md','2026-10-11T00-00-00-not-markdown.txt'])fs.writeFileSync(join(resources,name),'synthetic')
 await pruneOldExtensionResources(root,Date.UTC(2026,9,26),options)
 assert.equal(fs.existsSync(join(resources,'2026-10-12T00-00-00-expired.md')),false)
 assert.equal(fs.readdirSync(resources).length,4)
 const summaries=join(root,'rollout_summaries');fs.mkdirSync(summaries)
 fs.mkdirSync(join(summaries,'directory.md'))
 fs.writeFileSync(join(summaries,'obsolete.md'),'obsolete')
 await syncRolloutSummariesFromMemories(root,[{thread_id:'session-00000000-0000-4000-8000-000000000001',source_updated_at:0,rollout_summary:'summary',cwd:'/synthetic'}],10,options)
 assert.equal(fs.existsSync(join(summaries,'obsolete.md')),false)
 assert.ok(warnings.some(([event])=>event==='prune outdated rollout summary failed'))
 const summary=fs.readdirSync(summaries).find(name=>name!=='directory.md')
 assert.equal(fs.readFileSync(join(summaries,summary),'utf8'),'thread_id: session-00000000-0000-4000-8000-000000000001\nupdated_at: 1970-01-01T00:00:00+00:00\nrollout_path: \ncwd: /synthetic\n\nsummary\n')
 fs.mkdirSync(join(root,'nested'));fs.symlinkSync(outside,join(root,'nested/link'))
 assert.equal(await removeMemorySymlinks(root),1)
 assert.equal(fs.existsSync(join(outside,'instructions.md')),true)
})

test('artifact validation keeps native CRLF headings and ownership boundaries',async t=>{
 const root=temporary(t)
 const summary="v1\r\n## User Profile\r\n## User preferences\r\n## General Tips\r\n## What's in Memory\r\n"
 assert.equal(isValidV2Summary(summary),true)
 fs.writeFileSync(join(root,'memory_summary.md'),summary)
 let checks=0
 await validateConsolidationArtifacts(root,{ownedMutation:fn=>{checks++;return fn()}})
 assert.equal(checks,2)
 fs.writeFileSync(join(root,'memory_summary.md'),Buffer.concat([Buffer.from(summary),Buffer.from([0xff])]))
 await assert.rejects(validateConsolidationArtifacts(root),error=>error.cause?.code==='ERR_ENCODING_INVALID_ENCODED_DATA')
 await assert.rejects(resetMemoryWorkspaceBaseline(root,{assertOwnership:()=>{throw new Error('lost ownership')}}),/lost ownership/)
 assert.equal(fs.existsSync(join(root,'.git')),false)
})

test('native list/read/search schemas, minimal windows, normalized and decimal cursor', t => {
  const root = temporary(t)
  fs.mkdirSync(join(root, 'notes'))
  fs.writeFileSync(join(root, 'notes/a.txt'), 'Alpha one\nbeta\nAlpha beta\nlast\n')
  fs.writeFileSync(join(root, 'z.any'), 'foo_bar café\r\n')
  fs.writeFileSync(join(root, '.hidden'), 'Alpha')
  const b = createMemoryBackend(root)
  assert.deepEqual(b.list({max_results:1}), {path:null, entries:[{path:'notes',entry_type:'directory'}],next_cursor:'1',truncated:true})
  assert.deepEqual(b.list({cursor:'1'}).entries,[{path:'z.any',entry_type:'file'}])
  assert.deepEqual(b.read({path:'notes/a.txt',line_offset:2,max_lines:1}), {path:'notes/a.txt',start_line_number:2,content:'beta\n',truncated:true})
  assert.equal(b.read({path:'notes/a.txt',line_offset:5}).content,'')
  assert.throws(()=>b.read({path:'notes/a.txt',line_offset:6}),{code:'LineOffsetExceedsFileLength'})
  const result=b.search({queries:['Alpha','beta'],match_mode:{type:'all_within_lines',line_count:2}})
  assert.deepEqual(result.matches.map(m=>[m.match_line_number,m.content,m.matched_queries]), [[1,'Alpha one\nbeta',['Alpha','beta']],[3,'Alpha beta',['Alpha','beta']]])
  assert.deepEqual(b.search({queries:['Alpha','beta'],match_mode:{type:'all_on_same_line'}}).matches.map(m=>m.match_line_number),[3])
  assert.equal(b.search({queries:['foo-bar CAFÉ'],case_sensitive:false,normalized:true}).matches[0].path,'z.any')
  assert.equal(b.search({queries:['alpha']}).matches.length,0)
  assert.throws(()=>b.search({queries:['---'],normalized:true}),{code:'EmptyQuery'})
  assert.throws(()=>b.list({cursor:'no'}),{code:'InvalidCursor'})
  assert.throws(()=>b.list({cursor:'20'}),{code:'InvalidCursor'})
  assert.deepEqual(b.list({cursor:'+0001'}).entries,[{path:'z.any',entry_type:'file'}])
  assert.throws(()=>b.list({cursor:'18446744073709551616'}),{code:'InvalidCursor'})
  assert.throws(()=>b.list({cursor:'9007199254740993'}),/exceeds result count/)
  assert.deepEqual(b.search({path:'notes/a.txt',queries:[' Alpha ']}).queries,['Alpha'])
})

test('native create_new note preserves bytes and timestamp shape (not calendar)', t => {
 const root=temporary(t), b=createMemoryBackend(root)
 const request={filename:'2026-99-99T99-99-99-note.md',note:'  remembered\n\n'}
 assert.deepEqual(b.addAdHocNote(request),{})
 assert.equal(fs.readFileSync(join(root,'extensions/ad_hoc/notes',request.filename),'utf8'),request.note)
 assert.throws(()=>b.addAdHocNote(request),{code:'AdHocNoteAlreadyExists'})
 for(const filename of ['x.md','2026-01-01T01-01-01-UPPER.md','2026-01-01T01-01-01-a_b.md']) assert.throws(()=>b.addAdHocNote({...request,filename}),{code:'InvalidFilename'})
})

test('root/component symlinks rejected, hidden/link traversal excluded', t => {
 const root=temporary(t), outside=temporary(t)
 fs.writeFileSync(join(outside,'secret'),'outside')
 fs.symlinkSync(outside,join(root,'link'))
 const b=createMemoryBackend(root)
 assert.deepEqual(b.list().entries,[])
 for(const path of ['../secret','/secret','link/secret','.git/config','x\u0000']) assert.throws(()=>b.read({path}),e=>['InvalidPath','NotFound'].includes(e.code))
 assert.throws(()=>createMemoryBackend(join(root,'link')).list(),{code:'InvalidPath'})
})

test('native Git baseline readonly diff, ignored files, mode, rename, object erasure', async t => {
 const root=temporary(t)
 fs.writeFileSync(join(root,'MEMORY.md'),'old\n')
 fs.writeFileSync(join(root,'.gitignore'),'*.txt\n')
 fs.writeFileSync(join(root,'ignored.txt'),'evidence\n')
 const outside=temporary(t);fs.writeFileSync(join(outside,'safe'),'external')
 fs.symlinkSync(outside,join(root,'stale-link'))
 await prepareMemoryWorkspace(root)
 assert.equal(fs.existsSync(join(root,'stale-link')),false)
 assert.equal(fs.readFileSync(join(outside,'safe'),'utf8'),'external')
 assert.ok(!git(root,['ls-files']).includes('stale-link'))
 assert.ok(git(root,['ls-files']).includes('ignored.txt'))
 const old=git(root,['rev-parse','HEAD:MEMORY.md']).trim()
 const index=fs.readFileSync(join(root,'.git/index'))
 const objects=git(root,['cat-file','--batch-all-objects','--batch-check=%(objectname)'])
 fs.writeFileSync(join(root,'MEMORY.md'),'new\n')
 fs.renameSync(join(root,'ignored.txt'),join(root,'renamed.txt'))
 fs.chmodSync(join(root,'.gitignore'),0o755)
 fs.writeFileSync(join(root,WORKSPACE_DIFF_FILENAME),'stale')
 const d=await memoryWorkspaceDiff(root)
 assert.deepEqual(d.changes,[{status:'M',path:'.gitignore'},{status:'M',path:'MEMORY.md'},{status:'D',path:'ignored.txt'},{status:'A',path:'renamed.txt'}])
 assert.equal(fs.existsSync(join(root,WORKSPACE_DIFF_FILENAME)),false)
 assert.deepEqual(fs.readFileSync(join(root,'.git/index')),index)
 assert.equal(git(root,['cat-file','--batch-all-objects','--batch-check=%(objectname)']),objects)
 assert.ok(d.unifiedDiff.includes('--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1 +1 @@\n-old\n+new\n'))
 await writeWorkspaceDiff(root,d)
 assert.ok(fs.readFileSync(join(root,WORKSPACE_DIFF_FILENAME),'utf8').startsWith('# Memory Workspace Diff\n\nGenerated by Codex'))
 await resetMemoryWorkspaceBaseline(root)
 assert.equal(git(root,['rev-list','--count','HEAD']).trim(),'1')
 assert.equal(git(root,['rev-list','--parents','HEAD']).trim().split(' ').length,1)
 assert.throws(()=>git(root,['cat-file','-e',old]))
 assert.equal((await memoryWorkspaceDiff(root)).hasChanges(),false)
})

test('native literal three-line hunks, blank/repeated lines and missing final newline',async t=>{
 const root=temporary(t)
 fs.writeFileSync(join(root,'sample'),'repeat\n\nrepeat\nold\nrepeat\n\nrepeat\n')
 await prepareMemoryWorkspace(root)
 fs.writeFileSync(join(root,'sample'),'repeat\n\nrepeat\nnew\nrepeat\n\nrepeat\n')
 fs.writeFileSync(join(root,'new'),'without newline')
 const d=await memoryWorkspaceDiff(root)
 assert.equal(d.unifiedDiff,'diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+without newline\n\\ No newline at end of file\n'+'diff --git a/sample b/sample\n--- a/sample\n+++ b/sample\n@@ -1,7 +1,7 @@\n repeat\n \n repeat\n-old\n+new\n repeat\n \n repeat\n')
 await resetMemoryWorkspaceBaseline(root)
 const empty=await memoryWorkspaceDiff(root)
 await writeWorkspaceDiff(root,empty)
 assert.equal(fs.readFileSync(join(root,WORKSPACE_DIFF_FILENAME),'utf8'),'# Memory Workspace Diff\n\nGenerated by Codex before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n## Status\n- none\n')
})

test('native diff artifact preserves Status and UTF-8 truncation marker', async t => {
 const root=temporary(t)
 const diff={changes:[{status:'M',path:'x'}],unifiedDiff:'界'.repeat(1_398_102),hasChanges:()=>true}
 await writeWorkspaceDiff(root,diff)
 const text=fs.readFileSync(join(root,WORKSPACE_DIFF_FILENAME),'utf8')
 assert.ok(text.includes('## Status\n- M x\n'))
 assert.ok(text.endsWith('\n\n[workspace diff truncated at 4194304 bytes]\n```\n'))
 assert.ok(!text.includes('\ufffd'))
})

test('root-only Git metadata never uses ancestor repository or external gitdir', async t => {
 const parent=temporary(t), root=join(parent,'child');fs.mkdirSync(root)
 await prepareMemoryWorkspace(parent)
 const parentIndex=fs.readFileSync(join(parent,'.git/index'))
 await prepareMemoryWorkspace(root)
 assert.ok(fs.lstatSync(join(root,'.git')).isDirectory())
 assert.deepEqual(fs.readFileSync(join(parent,'.git/index')),parentIndex)
 const external=temporary(t)
 fs.writeFileSync(join(external,'marker'),'external')
 const pointer=join(root,'.git');assert.equal(resolve(pointer),join(root,'.git'));fs.rmSync(pointer,{recursive:true})
 fs.symlinkSync(external,pointer)
 await prepareMemoryWorkspace(root)
 assert.equal(fs.readFileSync(join(external,'marker'),'utf8'),'external')
 assert.ok(!fs.lstatSync(pointer).isSymbolicLink())
})

test('private mutation guard is synchronous and owns final validation/publication', t => {
 const root=temporary(t); let guarded=0, allowed=true
 const tools=createPrivateWorkspaceTools(root,{ownedMutation:fn=>{assert.ok(allowed); guarded++;return fn()}})
 tools.dispatch('memory_workspace_write',{path:'a/b',content:'one'})
 tools.dispatch('memory_workspace_edit',{path:'a/b',old_string:'one',new_string:'two'})
 tools.dispatch('memory_workspace_move',{source:'a/b',destination:'new'})
 assert.equal(fs.readFileSync(join(root,'new'),'utf8'),'two')
 assert.throws(()=>tools.dispatch('memory_workspace_move',{source:'new',destination:'new'}))
 assert.throws(()=>tools.dispatch('memory_workspace_remove',{path:''}),{code:'InvalidPath'})
 assert.throws(()=>tools.dispatch('bash',{}),{code:'UnknownTool'})
 allowed=false
 assert.throws(()=>tools.dispatch('memory_workspace_write',{path:'blocked',content:'x'}))
 assert.equal(fs.existsSync(join(root,'blocked')),false)
 assert.ok(guarded>=3)
 let delayed
 const deferred=createMemoryBackend(root,{ownedMutation:fn=>{delayed=fn}})
 deferred.write({path:'deferred',content:'must not publish'})
 assert.throws(()=>delayed(),{code:'InvalidMutationGuard'})
 assert.equal(fs.existsSync(join(root,'deferred')),false)
 fs.writeFileSync(join(root,'executable'),'one one');fs.chmodSync(join(root,'executable'),0o755)
 const b=createPrivateWorkspaceTools(root)
 assert.throws(()=>b.dispatch('memory_workspace_edit',{path:'executable',old_string:'one',new_string:'two'}),{code:'EditMatch'})
 b.dispatch('memory_workspace_edit',{path:'executable',old_string:'one',new_string:'two',replace_all:true})
 assert.equal(fs.readFileSync(join(root,'executable'),'utf8'),'two two')
 assert.ok(fs.statSync(join(root,'executable')).mode & 0o111)
 fs.writeFileSync(join(root,'a/child'),'keep')
 assert.throws(()=>b.dispatch('memory_workspace_remove',{path:'a'}),e=>e.code==='ENOTEMPTY')
 b.dispatch('memory_workspace_remove',{path:'new'})
 assert.equal(fs.existsSync(join(root,'new')),false)
})

test('stale diff cleanup cannot remove a newer reset generation artifact',async t=>{
 const root=temporary(t),database=join(temporary(t),'state.sqlite');let time=1000
 const a=openMemoryStore(database,{clock:()=>time}),b=openMemoryStore(database,{clock:()=>time})
 try{
  a.publishSources([]);const claim=a.tryClaimGlobalPhase2Job('old-worker',10,0),options={ownedMutation:fn=>a.withOwnedMutation(claim.token,claim.generation,fn)}
  await prepareMemoryWorkspace(root,options);a.assertPhase2Ownership(claim.token,claim.generation)
  time=1011;const generation=b.beginReset();b.finishReset(generation)
  const path=join(root,WORKSPACE_DIFF_FILENAME);fs.writeFileSync(path,'new generation artifact')
  await assert.rejects(memoryWorkspaceDiff(root,options),e=>e.code==='lost_ownership')
  assert.equal(fs.readFileSync(path,'utf8'),'new generation artifact')
 }finally{a.close();b.close()}
})
