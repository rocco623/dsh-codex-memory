// Fixed Codex git-utils baseline: explicit local metadata, ignore-independent trees.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { assertMemoryRoot, scopedPath, metadata, ownedMutation, createMemoryBackend, memoryError } from './memory-backend.js'

export const WORKSPACE_DIFF_FILENAME = 'phase2_workspace_diff.md'
const MAX_DIFF_BYTES = 4 * 1024 * 1024
const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_SYSTEM:'/dev/null', GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_TERMINAL_PROMPT:'0', GIT_ATTR_NOSYSTEM:'1', GIT_NO_LAZY_FETCH:'1', GIT_NO_REPLACE_OBJECTS:'1',
  GIT_AUTHOR_NAME:'Codex',GIT_AUTHOR_EMAIL:'noreply@openai.com',
  GIT_COMMITTER_NAME:'Codex',GIT_COMMITTER_EMAIL:'noreply@openai.com',
})
function git(root, args, input) {
  return execFileSync('git',[
    '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null',
    '-c','commit.gpgSign=false','-c','core.quotePath=false','-c','diff.suppressBlankEmpty=false',
    `--git-dir=${join(root,'.git')}`,`--work-tree=${root}`,...args,
  ],{cwd:root,env:gitEnvironment(),input,encoding:'utf8',maxBuffer:Infinity,stdio:['pipe','pipe','pipe']})
}
const pathSort = (a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))
const blobId = (bytes,algorithm) => createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
function currentFiles(root) {
  const algorithm=git(root,['rev-parse','--show-object-format']).trim()
  const entries = new Map()
  const walk = (directory,prefix='') => {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if(entry.name==='.git') continue
      const absolute=join(directory,entry.name), path=prefix+entry.name
      if(entry.isDirectory()) walk(absolute,`${path}/`)
      else if(entry.isFile()||entry.isSymbolicLink()) {
        const bytes=entry.isSymbolicLink()?Buffer.from(fs.readlinkSync(absolute)):fs.readFileSync(absolute)
        const mode=entry.isSymbolicLink()?'120000':fs.lstatSync(absolute).mode&0o111?'100755':'100644'
        entries.set(path,{oid:blobId(bytes,algorithm),mode,bytes})
      }
    }
  }
  walk(root)
  return entries
}
function headFiles(root) {
  const gitPath=join(root,'.git'), info=metadata(gitPath)
  if(!info?.isDirectory()||info.isSymbolicLink()||metadata(join(gitPath,'commondir')))throw memoryError('InvalidBaseline','baseline requires root-local Git metadata')
  const entries=new Map()
  for(const line of git(root,['ls-tree','-rz','--full-tree','HEAD']).split('\0')) {
    if(!line) continue
    const tab=line.indexOf('\t'), [mode,,oid]=line.slice(0,tab).split(' ')
    if(!['100644','100755','120000'].includes(mode)) throw memoryError('InvalidBaseline','unsupported baseline tree entry')
    entries.set(line.slice(tab+1),{mode,oid})
  }
  return entries
}
function removeDiff(root) {
  assertMemoryRoot(root)
  const path=join(root,WORKSPACE_DIFF_FILENAME)
  // unlink removes a link itself, never its target; directories are errors.
  try {fs.unlinkSync(path)} catch(error) {if(error.code!=='ENOENT')throw error}
}
function resetBaseline(root) {
  root=assertMemoryRoot(root,true)
  const gitPath=join(root,'.git')
  if(resolve(gitPath)!==`${root}/.git`) throw memoryError('InvalidPath','invalid local Git metadata path')
  const info=metadata(gitPath)
  if(info?.isDirectory()&&!info.isSymbolicLink()) fs.rmSync(gitPath,{recursive:true})
  else if(info) fs.unlinkSync(gitPath)
  git(root,['init','--quiet','--template=/dev/null',root])
  const entries=currentFiles(root)
  // hash-object stdin does not apply user filters or respect ignore files.
  for(const entry of entries.values()) entry.oid=git(root,['hash-object','-w','--stdin'],entry.bytes).trim()
  const indexEntries=Array.from(entries).sort(([a],[b])=>pathSort(a,b)).map(([path,e])=>`${e.mode} ${e.oid}\t${path}\0`).join('')
  git(root,['update-index','-z','--index-info'],indexEntries)
  const tree=git(root,['write-tree']).trim()
  const commit=git(root,['commit-tree',tree], 'Initialize Codex git baseline\n\nCo-authored-by: Codex <noreply@openai.com>\n').trim()
  git(root,['update-ref','HEAD',commit])
  git(root,['read-tree','--reset','HEAD'])
}
// covie-ponytail: synchronous Git blocks the event loop/ownership transaction; use a worker only if workspace size requires it.
function guarded(options, fn) {
  return ownedMutation(options,()=>{options?.assertOwnership?.();return fn()})
}
export async function prepareMemoryWorkspace(root, options={}) {
  return guarded(options,()=>{
    root=assertMemoryRoot(root,true)
    removeSymlinks(root)
    const summaries=scopedPath(root,'rollout_summaries')
    if(!metadata(summaries))fs.mkdirSync(summaries)
    removeDiff(root)
    const info=metadata(join(root,'.git'))
    if(info?.isDirectory()&&!info.isSymbolicLink()) {
      try {headFiles(root);return} catch(error) {
        if(!Number.isInteger(error.status)&&error.code!=='InvalidBaseline') throw error
        // Native ensure replaces a Git repository with unreadable/unborn HEAD.
      }
    }
    resetBaseline(root)
  })
}
function unifiedSection(root,path,oldEntry,newEntry) {
  let section=`diff --git a/${path} b/${path}\n`
  if(!oldEntry) section+=`new file mode ${newEntry.mode}\n`
  else if(!newEntry) section+=`deleted file mode ${oldEntry.mode}\n`
  else if(oldEntry.mode!==newEntry.mode) section+=`old mode ${oldEntry.mode}\nnew mode ${newEntry.mode}\n`
  const oldText=oldEntry?Buffer.from(git(root,['cat-file','blob',oldEntry.oid]),'utf8'):Buffer.alloc(0)
  const newText=newEntry?Buffer.from(newEntry.bytes.toString('utf8')):Buffer.alloc(0)
  if(oldText.equals(newText)) return section
  const temporary=fs.mkdtempSync(join(tmpdir(),'dsh-memory-diff-'))
  try {
    const before=join(temporary,'before'),after=join(temporary,'after')
    fs.writeFileSync(before,oldText);fs.writeFileSync(after,newText)
    let output
    try { output=git(root,['diff','--no-index','--no-ext-diff','--no-textconv','--text','--no-color','--no-renames','--diff-algorithm=myers','--no-indent-heuristic','--unified=3','--inter-hunk-context=0','--word-diff=none','--output-indicator-new=+','--output-indicator-old=-','--output-indicator-context= ','--',before,after]) }
    catch(error) {if(error.status!==1)throw error;output=error.stdout}
    const hunk=output.indexOf('@@ ')
    if(hunk>=0) section+=`--- ${oldEntry?`a/${path}`:'/dev/null'}\n+++ ${newEntry?`b/${path}`:'/dev/null'}\n${output.slice(hunk)}`
    return section.endsWith('\n')?section:section+'\n'
  } finally {
    if(resolve(temporary)!==temporary||!temporary.startsWith(join(tmpdir(),'dsh-memory-diff-')))throw memoryError('InvalidPath','invalid diff cleanup directory')
    fs.rmSync(temporary,{recursive:true,force:true})
  }
}
export async function memoryWorkspaceDiff(root,options={}) {
  return guarded(options,()=>{
    root=assertMemoryRoot(root)
    removeDiff(root)
    const head=headFiles(root), current=currentFiles(root)
    const paths=Array.from(new Set([...head.keys(),...current.keys()])).sort(pathSort)
    const changes=[];let unifiedDiff=''
    for(const path of paths) {
      const old=head.get(path),next=current.get(path)
      if(old&&next&&old.oid===next.oid&&old.mode===next.mode)continue
      changes.push({status:!old?'A':!next?'D':'M',path})
      unifiedDiff+=unifiedSection(root,path,old,next)
    }
    return {changes,unifiedDiff,hasChanges:()=>changes.length>0}
  })
}
export function renderWorkspaceDiff(diff) {
  let rendered='# Memory Workspace Diff\n\nGenerated by Codex before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n## Status\n'
  if(!diff.changes.length)return rendered+'- none\n'
  rendered+=diff.changes.map(c=>`- ${c.status} ${c.path}\n`).join('')+'\n## Diff\n\n```diff\n'
  const bytes=Buffer.from(diff.unifiedDiff)
  let body=diff.unifiedDiff
  if(bytes.length>MAX_DIFF_BYTES) {
    let end=MAX_DIFF_BYTES
    while((bytes[end]&0xc0)===0x80)end--
    body=bytes.subarray(0,end).toString('utf8')
    if(!body.endsWith('\n'))body+='\n'
    body+=`\n[workspace diff truncated at ${MAX_DIFF_BYTES} bytes]\n`
  } else if(!body.endsWith('\n'))body+='\n'
  return rendered+body+'```\n'
}
export async function writeWorkspaceDiff(root,diff,options={}) {
  return createMemoryBackend(root,{...options,ownedMutation:fn=>guarded(options,fn)}).write({path:WORKSPACE_DIFF_FILENAME,content:renderWorkspaceDiff(diff)})
}
export async function resetMemoryWorkspaceBaseline(root,options={}) {
  return guarded(options,()=>{root=assertMemoryRoot(root);removeDiff(root);resetBaseline(root)})
}

// The v2 summary's first line is literally `v1`: that is the summary FORMAT
// marker Codex validates, independent of which pipeline version wrote it.
const V2_REQUIRED_HEADINGS = [
  '## User Profile',
  '## User preferences',
  '## General Tips',
  "## What's in Memory",
]
const MAX_SUMMARY_BYTES = 10_000

/** Codex: is_valid_v2_summary. */
export function isValidV2Summary(summary) {
  const lines = summary.split(/\r?\n/)
  return (
    lines[0] === 'v1' &&
    Buffer.byteLength(summary, 'utf8') < MAX_SUMMARY_BYTES &&
    V2_REQUIRED_HEADINGS.every((heading) => lines.some((line) => line.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'') === heading))
  )
}

function removeSymlinks(root) {
  root=assertMemoryRoot(root)
  let removed=0
  const pending=[root]
  while(pending.length) {
    const directory=pending.pop()
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name)
      if(entry.isSymbolicLink()) {fs.unlinkSync(path);removed++}
      else if(entry.isDirectory()) pending.push(path)
    }
  }
  return removed
}
/** Codex: remove_memory_symlinks — returns how many symlinks were removed. */
export async function removeMemorySymlinks(root, options={}) {
  return guarded(options,()=>removeSymlinks(root))
}

/**
 * Codex: validate_consolidation_artifacts_for_version (v2). Fails when the agent
 * introduced symlinks or when the summary does not satisfy the v2 shape.
 */
export async function validateConsolidationArtifacts(root, options={}) {
  const removedSymlinks = await removeMemorySymlinks(root,options)
  return guarded(options,()=>{
    assertMemoryRoot(root)
    if (removedSymlinks !== 0) {
      throw new Error(`removed ${removedSymlinks} symbolic links from consolidated memory workspace`)
    }
    let summary
    try {summary=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(fs.readFileSync(scopedPath(root,'memory_summary.md')))}
    catch(error) {throw new Error('read memory summary artifact failed',{cause:error})}
    if(summary.split(/\r?\n/)[0]!=='v1')throw new Error('memory summary artifact does not start with v1')
    if(!isValidV2Summary(summary))throw new Error('invalid v2 memory summary')
  })
}
