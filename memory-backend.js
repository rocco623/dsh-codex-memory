import * as fs from 'node:fs'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function memoryError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code })
}
const fail = (code, message) => { throw memoryError(code, message) }
export function metadata(path) {
  try { return fs.lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null // A missing entry is an expected probe.
    throw error
  }
}
export function assertMemoryRoot(root, create = false) {
  const absolute = resolve(root)
  let info = metadata(absolute)
  if (!info && create) { fs.mkdirSync(absolute, { recursive: true }); info = metadata(absolute) }
  if (!info) fail('NotFound', 'memory root was not found')
  if (info.isSymbolicLink() || !info.isDirectory()) fail('InvalidPath', 'memory root must be a directory, not a symlink')
  return absolute
}
export function scopedPath(root, path = '', { createParents = false, privatePaths = false } = {}) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\0')) fail('InvalidPath', 'path must stay within memory root')
  const parts = path.split('/').filter(p => p && p !== '.')
  if (parts.some(p => p === '..')) fail('InvalidPath', 'path must stay within memory root')
  if (!privatePaths && parts.some(p => p.startsWith('.'))) fail('NotFound', 'hidden memory path was not found')
  if (parts.some(part=>part.toLowerCase()==='.git')) fail('InvalidPath', 'path must stay outside Git metadata')
  let current = assertMemoryRoot(root)
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    let info = metadata(current)
    if (!info && createParents && i < parts.length - 1) { fs.mkdirSync(current); info = metadata(current) }
    if (info?.isSymbolicLink()) fail('InvalidPath', 'path must not traverse a symlink')
    if (info && i < parts.length - 1 && !info.isDirectory()) fail('InvalidPath', 'path traverses a non-directory')
  }
  return current
}
export function ownedMutation(options, fn) {
  let active=true
  let result
  try {
    result=(options?.ownedMutation ?? (action=>action()))(()=>{
      if(!active)fail('InvalidMutationGuard','mutation callback cannot run after its owner returns')
      return fn()
    })
  } finally {active=false}
  if(result && typeof result.then==='function')fail('InvalidMutationGuard','ownedMutation must complete synchronously')
  return result
}
const integer = (value, fallback, name, min = 0) => {
  const n = value === undefined ? fallback : value
  if (!Number.isSafeInteger(n) || n < min) fail('InvalidArgument', `${name} must be an integer >= ${min}`)
  return n
}
export function strictFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('InvalidArgument', 'unexpected argument fields')
}
function page(entries, request, cap) {
  let start = 0
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string' || !/^\+?\d+$/.test(request.cursor)) fail('InvalidCursor', 'cursor must be a non-negative integer')
    const parsed=BigInt(request.cursor)
    if(parsed>0xffff_ffff_ffff_ffffn)fail('InvalidCursor','cursor must fit usize')
    if(parsed>BigInt(entries.length))fail('InvalidCursor','cursor exceeds result count')
    start = Number(parsed)
  }
  const end = Math.min(entries.length, start + Math.max(1,Math.min(integer(request.max_results, cap, 'max_results'), cap)))
  return { items: entries.slice(start, end), next_cursor: end < entries.length ? String(end) : null, truncated: end < entries.length }
}
const sort = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
function sortedEntries(path) {
  try { return fs.readdirSync(path, { withFileTypes: true }).sort((a,b)=>sort(a.name,b.name)) } catch(error) {
    if (error.code === 'ENOENT') return [] // Entries can disappear during a read-only walk.
    throw error
  }
}
function readText(path) { return new TextDecoder('utf-8', { fatal: true, ignoreBOM:true }).decode(fs.readFileSync(path)) }
const rustTrim = text => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'')
const rustLines = text => (text.match(/[^\n]*\n|[^\n]+$/g)??[]).map(line=>line.endsWith('\r\n')?line.slice(0,-2):line.endsWith('\n')?line.slice(0,-1):line)
// Rust char::to_lowercase is per scalar, unlike JS's contextual final-sigma mapping.
const lower = text => Array.from(text, ch => ch.toLowerCase()).join('')
const prepare = (text, sensitive, normalized) => {
  const value = sensitive ? text : lower(text)
  return normalized ? value.replace(/[^\p{Alphabetic}\p{Number}]/gu, '') : value
}

export function createMemoryBackend(root, options = {}) {
  root = resolve(root)
  const scope = (path, extra) => scopedPath(root, path, { privatePaths: options.privatePaths, ...extra })
  const visible = name => options.privatePaths ? name.toLowerCase() !== '.git' : !name.startsWith('.')
  const file = path => {
    const absolute = scope(path), info = metadata(absolute)
    if (!info) fail('NotFound', 'memory path was not found')
    if (!info.isFile()) fail('NotFile', 'memory path is not a file')
    return absolute
  }
  const mutate = fn => ownedMutation(options, fn)
  function write({ path, content }) {
    if (typeof content !== 'string') fail('InvalidArgument', 'content must be a string')
    return mutate(() => {
      const target = scope(path, { createParents:true })
      if (target === root) fail('InvalidPath', 'cannot write memory root')
      const info=metadata(target)
      const tmp = join(dirname(target), `.memory-${randomUUID()}.tmp`)
      try { fs.writeFileSync(tmp, content, {flag:'wx', mode:info ? info.mode & 0o777 : 0o600}); fs.renameSync(tmp, target) }
      finally { if (metadata(tmp)) fs.unlinkSync(tmp) }
      return {}
    })
  }
  return {
    list(request = {}) {
      strictFields(request, ['path','cursor','max_results'])
      const start = scope(request.path), info = metadata(start)
      if (!info) fail('NotFound', 'memory path was not found')
      const relative = path => path.slice(root.length + 1)
      const entries = info.isFile() ? [{path:relative(start),entry_type:'file'}] : info.isDirectory() ? sortedEntries(start)
        .filter(e => visible(e.name) && !e.isSymbolicLink() && (e.isFile() || e.isDirectory()))
        .map(e=>({path:relative(join(start,e.name)),entry_type:e.isFile()?'file':'directory'})) : []
      const p = page(entries,request,2000)
      return {path:request.path ?? null,entries:p.items,next_cursor:p.next_cursor,truncated:p.truncated}
    },
    read(request) {
      strictFields(request,['path','line_offset','max_lines'])
      if(request.line_offset===0)fail('InvalidLineOffset','line_offset must be a 1-indexed line number')
      if(request.max_lines===0)fail('InvalidMaxLines','max_lines must be a positive integer')
      if(typeof request.path!=='string')fail('InvalidArgument','path must be a string')
      const offset = integer(request.line_offset,1,'line_offset',1)
      const count = request.max_lines === undefined ? undefined : integer(request.max_lines,undefined,'max_lines',1)
      const original = readText(file(request.path)); let start = 0
      for(let line=1;line<offset;line++) {
        const next = original.indexOf('\n',start)
        if(next<0) fail('LineOffsetExceedsFileLength','line_offset exceeds file length')
        start=next+1
      }
      let end=original.length
      if(count!==undefined) { let at=start; for(let i=0;i<count;i++) { const next=original.indexOf('\n',at); if(next<0) break; at=next+1; if(i===count-1) end=at } }
      const selected=original.slice(start,end)
      const content=truncateRead(selected)
      return {path:request.path,start_line_number:offset,content,truncated:end<original.length || selected!==content}
    },
    search(request) {
      if(request && Object.hasOwn(request,'query')) {
        strictFields(request,['query','max_results'])
        if(typeof request.query!=='string')fail('EmptyQuery','query must be a nonempty string')
        const result=createMemoryBackend(root,options).search({queries:[request.query],case_sensitive:false,max_results:request.max_results??40})
        return result.matches.map(match=>`${match.path}:${match.match_line_number}: ${rustTrim(match.content)}`)
      }
      strictFields(request,['queries','match_mode','path','cursor','context_lines','case_sensitive','normalized','max_results'])
      if(!Array.isArray(request.queries) || request.queries.some(q=>typeof q!=='string')) fail('EmptyQuery','queries must contain nonempty strings')
      const queries=request.queries.map(rustTrim)
      const sensitive=request.case_sensitive ?? true, normalized=request.normalized ?? false
      if(typeof sensitive!=='boolean' || typeof normalized!=='boolean') fail('InvalidArgument','comparison flags must be booleans')
      const prepared=queries.map(q=>prepare(q,sensitive,normalized))
      if(!prepared.length || prepared.some(q=>!q)) fail('EmptyQuery','queries must not be empty')
      const mode=request.match_mode ?? {type:'any'}
      strictFields(mode,mode.type==='all_within_lines'?['type','line_count']:['type'])
      if(!['any','all_on_same_line','all_within_lines'].includes(mode.type)) fail('InvalidMatchWindow','unknown match mode')
      if(mode.type==='all_within_lines' && (!Number.isSafeInteger(mode.line_count)||mode.line_count<1)) fail('InvalidMatchWindow','line_count must be positive')
      const context=integer(request.context_lines,0,'context_lines')
      const matches=[]
      const walk = (absolute, path) => {
        const info=metadata(absolute)
        if(!info || info.isSymbolicLink()) return
        if(info.isDirectory()) { for(const e of sortedEntries(absolute)) if(visible(e.name)) walk(join(absolute,e.name),path?`${path}/${e.name}`:e.name); return }
        if(!info.isFile()) return
        let text
        try { text=readText(absolute) } catch(error) {
          if(error.code==='ERR_ENCODING_INVALID_ENCODED_DATA') return // Native search skips non-UTF-8 files.
          throw error
        }
        const lines=rustLines(text), flags=lines.map(line=>{const p=prepare(line,sensitive,normalized);return prepared.map(q=>p.includes(q))})
        let windows=[]
        for(let start=0;start<lines.length;start++) {
          if(mode.type!=='all_within_lines') { if(mode.type==='any'?flags[start].some(Boolean):flags[start].every(Boolean)) windows.push([start,start,flags[start]]); continue }
          if(!flags[start].some(Boolean)) continue
          const found=queries.map(()=>false)
          for(let end=start;end<Math.min(lines.length,start+mode.line_count);end++) { flags[end].forEach((v,i)=>{found[i] ||= v}); if(found.every(Boolean)) {windows.push([start,end,[...found]]);break} }
        }
        if(mode.type==='all_within_lines') windows=windows.filter(([s,e],idx,all)=>!all.some(([s2,e2],j)=>j!==idx&&s<=s2&&e>=e2&&(s!==s2||e!==e2)))
        for(const [s,e,f] of windows) {const begin=Math.max(0,s-context); matches.push({path,match_line_number:s+1,content_start_line_number:begin+1,content:lines.slice(begin,Math.min(lines.length,e+context+1)).join('\n'),matched_queries:queries.filter((_,i)=>f[i])})}
      }
      const start=scope(request.path)
      if(!metadata(start)) fail('NotFound','memory path was not found')
      walk(start,start===root?'':start.slice(root.length+1))
      matches.sort((a,b)=>sort(a.path,b.path)||a.match_line_number-b.match_line_number)
      const p=page(matches,request,200)
      return {queries,match_mode:mode,path:request.path??null,matches:p.items,next_cursor:p.next_cursor,truncated:p.truncated}
    },
    addAdHocNote(request) {
      strictFields(request,['filename','note'])
      const {filename,note}=request
      if(typeof filename!=='string'||Buffer.byteLength(filename)>128||!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9-]{1,80}\.md$/.test(filename)) fail('InvalidFilename','filename must use YYYY-MM-DDTHH-MM-SS-<lowercase-slug>.md')
      if(typeof note!=='string'||!rustTrim(note)) fail('EmptyAdHocNote','ad-hoc note must not be empty')
      return mutate(()=>{
        assertMemoryRoot(root,true)
        const path=scope(`extensions/ad_hoc/notes/${filename}`,{createParents:true})
        try {fs.writeFileSync(path,note,{flag:'wx'})} catch(error) {if(error.code==='EEXIST') throw memoryError('AdHocNoteAlreadyExists','ad-hoc note already exists',error);throw error}
        return {}
      })
    },
    note(request) {
      strictFields(request,['note'])
      const timestamp=new Date().toISOString().slice(0,19).replaceAll(':','-')
      const filename=`${timestamp}-${randomUUID()}.md`
      createMemoryBackend(root,options).addAdHocNote({filename,note:request.note})
      return `noted in extensions/ad_hoc/notes/${filename}; applied at the next consolidation`
    },
    write,
    edit({path,old_string,new_string,replace_all=false}) {
      if(typeof old_string!=='string'||!old_string||typeof new_string!=='string'||typeof replace_all!=='boolean') fail('InvalidArgument','edit requires nonempty old_string and string new_string')
      return mutate(()=>{
        const text=readText(file(path)), parts=text.split(old_string)
        if(parts.length===1||(!replace_all&&parts.length!==2)) fail('EditMatch','old_string must match exactly once unless replace_all')
        // Already inside the guard: do not nest ownership transactions.
        return createMemoryBackend(root,{privatePaths:options.privatePaths}).write({path,content:parts.join(new_string)})
      })
    },
    remove({path}) {return mutate(()=>{const target=scope(path);if(target===root) fail('InvalidPath','cannot remove memory root');const info=metadata(target);if(!info)fail('NotFound','memory path was not found');if(info.isDirectory()) fs.rmdirSync(target);else fs.unlinkSync(target);return {}})},
    move({source,destination}) {return mutate(()=>{const src=scope(source),dest=scope(destination);if(src===root||dest===root)fail('InvalidPath','cannot move memory root');if(!metadata(src))fail('NotFound','source was not found');if(metadata(dest))fail('AlreadyExists','destination already exists');fs.renameSync(src,dest);return {}})},
  }
}

function truncateRead(text) {
  const bytes=Buffer.byteLength(text), budget=80_000
  if(bytes<=budget)return text
  const chars=Array.from(text), half=budget/2
  let start=0, prefix=0, end=chars.length, suffix=0
  while(start<end&&prefix+Buffer.byteLength(chars[start])<=half) prefix+=Buffer.byteLength(chars[start++])
  while(end>start&&suffix+Buffer.byteLength(chars[end-1])<=half) suffix+=Buffer.byteLength(chars[--end])
  const removed=Math.ceil((bytes-budget)/4)
  return chars.slice(0,start).join('')+`…${removed} tokens truncated…`+chars.slice(end).join('')
}
