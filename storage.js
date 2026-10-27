// Artifact layer, ported from codex-rs/memories/write/src/storage.rs and
// extensions/{ad_hoc,prune}.rs. Owns the on-disk shape that the consolidation
// prompt points at: rollout_summaries/<stem>.md,
// extensions/ad_hoc/instructions.md, and the 14-day extension resource prune.
import * as fs from 'node:fs'
import { join } from 'node:path'
import { AD_HOC_INSTRUCTIONS } from './prompts.js'
import { assertMemoryRoot, scopedPath, metadata, ownedMutation, createMemoryBackend } from './memory-backend.js'

const warn = (options, event, error) => {
  if (options.warn) options.warn(event, {error})
  else process.emitWarning(new Error(event, {cause:error}))
}
const guarded = (options, fn) => ownedMutation(options,()=>{options.assertOwnership?.();return fn()})

export const EXTENSIONS_SUBDIR = 'extensions'
export const ROLLOUT_SUMMARIES_SUBDIR = 'rollout_summaries'
export const EXTENSION_RESOURCE_RETENTION_DAYS = 14

/** chrono's `to_rfc3339()` for a whole-second UTC instant: `...T..:..:..+00:00`. */
const rfc3339 = (seconds) => {
  const iso = new Date(seconds * 1_000).toISOString()
  return `${iso.slice(0, 19)}+00:00`
}

const FILENAME_TS_FORMAT = (date) => {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}-${iso.slice(14, 16)}-${iso.slice(17, 19)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const parseUuid = (threadId) => {
  const candidate = threadId.startsWith('session-') ? threadId.slice('session-'.length) : threadId
  return UUID_RE.test(candidate) ? candidate.replace(/-/g, '') : null
}

const SHORT_HASH_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SHORT_HASH_SPACE = 14_776_336
const ROLLOUT_SLUG_MAX_LEN = 60

/**
 * Codex: rollout_summary_file_stem_from_parts. `{timestamp}-{4-char hash}` plus a
 * sanitized, length-capped slug. DSH ids are `session-<uuid v4>`; a v4 UUID has
 * no embedded timestamp, so the source timestamp is used exactly as Codex does
 * when `get_timestamp()` is absent.
 */
export function rolloutSummaryFileStem({ threadId, sourceUpdatedAt, rolloutSlug }) {
  const hex = parseUuid(threadId)
  let timestampFragment
  let seed
  if (hex) {
    const version=hex[12]
    let timestamp=sourceUpdatedAt*1_000
    if(version==='7')timestamp=Number(BigInt(`0x${hex.slice(0,12)}`))
    else if(version==='1'||version==='6') {
      const ticks=version==='1'
        ? BigInt(`0x${hex.slice(13,16)}${hex.slice(8,12)}${hex.slice(0,8)}`)
        : BigInt(`0x${hex.slice(0,12)}${hex.slice(13,16)}`)
      timestamp=Number(ticks/10_000n-12_219_292_800_000n)
    }
    timestampFragment = FILENAME_TS_FORMAT(new Date(timestamp))
    seed = Number(BigInt(`0x${hex}`) & 0xffff_ffffn) >>> 0
  } else {
    let hash = 0
    for (const byte of Buffer.from(threadId, 'utf8')) {
      hash = (Math.imul(hash, 31) + byte) >>> 0
    }
    timestampFragment = FILENAME_TS_FORMAT(new Date(sourceUpdatedAt * 1_000))
    seed = hash
  }

  let value = seed % SHORT_HASH_SPACE
  const chars = ['0', '0', '0', '0']
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    chars[index] = SHORT_HASH_ALPHABET[value % SHORT_HASH_ALPHABET.length]
    value = Math.floor(value / SHORT_HASH_ALPHABET.length)
  }
  const filePrefix = `${timestampFragment}-${chars.join('')}`

  if (rolloutSlug == null) return filePrefix

  let slug = ''
  for (const ch of rolloutSlug) {
    if (slug.length >= ROLLOUT_SLUG_MAX_LEN) break
    slug += /[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : '_'
  }
  while (slug.endsWith('_')) slug = slug.slice(0, -1)
  return slug ? `${filePrefix}-${slug}` : filePrefix
}

const retainedMemories = (memories, max) => memories.slice(0, Math.min(memories.length, max))

function pruneRolloutSummaries(root, keep, options) {
  const dirPath = scopedPath(root, ROLLOUT_SUMMARIES_SUBDIR)
  if(!metadata(dirPath))return
  for(const fileName of fs.readdirSync(dirPath)) {
    if(!fileName.endsWith('.md') || keep.has(fileName.slice(0,-3)))continue
    try {fs.unlinkSync(join(dirPath,fileName))} catch(error) {
      if(error.code!=='ENOENT')warn(options,'prune outdated rollout summary failed',error)
    }
  }
}

function writeRolloutSummaryForThread(root, memory) {
  const stem = rolloutSummaryFileStem({
    threadId: memory.thread_id,
    sourceUpdatedAt: memory.source_updated_at,
    rolloutSlug: memory.rollout_slug,
  })
  const lines = [
    `thread_id: ${memory.thread_id}`,
    `updated_at: ${rfc3339(memory.source_updated_at)}`,
    `rollout_path: ${memory.rollout_path ?? ''}`,
    `cwd: ${memory.cwd ?? ''}`,
  ]
  if (memory.git_branch != null) lines.push(`git_branch: ${memory.git_branch}`)
  lines.push('', memory.rollout_summary)
  createMemoryBackend(root).write({path:`${ROLLOUT_SUMMARIES_SUBDIR}/${stem}.md`, content:`${lines.join('\n')}\n`})
}

/** Codex: sync_rollout_summaries_from_memories. */
export async function syncRolloutSummariesFromMemories(root, memories, maxRawMemories, options={}) {
  return guarded(options,()=>{
    root=assertMemoryRoot(root,true)
    const directory=scopedPath(root,ROLLOUT_SUMMARIES_SUBDIR)
    if(!metadata(directory))fs.mkdirSync(directory)
    const retained=retainedMemories(memories,maxRawMemories)
    const keep=new Set(retained.map(memory=>rolloutSummaryFileStem({threadId:memory.thread_id,sourceUpdatedAt:memory.source_updated_at,rolloutSlug:memory.rollout_slug})))
    pruneRolloutSummaries(root,keep,options)
    for(const memory of retained)writeRolloutSummaryForThread(root,memory)
  })
}

/** Codex: extensions/ad_hoc::seed_instructions — create_new, never overwrite. */
export async function seedExtensionInstructions(root, options={}) {
  return guarded(options,()=>{
    root=assertMemoryRoot(root,true)
    const instructionsPath=scopedPath(root,'extensions/ad_hoc/instructions.md',{createParents:true})
    try {fs.writeFileSync(instructionsPath,AD_HOC_INSTRUCTIONS,{flag:'wx'})}
    catch(error) {if(error.code!=='EEXIST')throw error} // Native create_new preserves an existing instruction file.
  })
}

// Codex: resource_timestamp — the first 19 chars parsed as %Y-%m-%dT%H-%M-%S (UTC).
const resourceTimestamp = (fileName) => {
  const head = fileName.slice(0, 19)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(head)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const date=new Date(0)
  date.setUTCFullYear(Number(year),Number(month)-1,Number(day))
  date.setUTCHours(Number(hour),Number(minute),Number(second),0)
  return Number.isFinite(date.getTime()) && FILENAME_TS_FORMAT(date)===head ? date.getTime() : null
}

/** Codex: prune_old_extension_resources — 14-day retention on resources/. */
export async function pruneOldExtensionResources(root, nowMs = Date.now(), options={}) {
  return guarded(options,()=>{
    if(!metadata(root))return
    root=assertMemoryRoot(root)
    const cutoff=nowMs-EXTENSION_RESOURCE_RETENTION_DAYS*86_400_000
    let extensions
    try {extensions=fs.readdirSync(scopedPath(root,'extensions'),{withFileTypes:true})}
    catch(error) {if(error.code!=='ENOENT')warn(options,'read memory extensions failed',error);return}
    for(const extension of extensions) {
      if(!extension.isDirectory())continue
      const extensionRelative=`extensions/${extension.name}`
      let resourcesPath,resources
      try {
        const instruction=scopedPath(root,`${extensionRelative}/instructions.md`,{privatePaths:true})
        if(!metadata(instruction))continue
        resourcesPath=scopedPath(root,`${extensionRelative}/resources`,{privatePaths:true})
        resources=fs.readdirSync(resourcesPath,{withFileTypes:true})
      } catch(error) {if(error.code!=='ENOENT')warn(options,'read extension resources failed',error);continue}
      for(const resource of resources) {
        if(!resource.isFile() || !resource.name.endsWith('.md'))continue
        const stamp=resourceTimestamp(resource.name)
        if(stamp===null||stamp>cutoff)continue
        try {
          const path=scopedPath(root,`${extensionRelative}/resources/${resource.name}`,{privatePaths:true})
          fs.unlinkSync(path)
        } catch(error) {if(error.code!=='ENOENT')warn(options,'prune extension resource failed',error)}
      }
    }
  })
}
