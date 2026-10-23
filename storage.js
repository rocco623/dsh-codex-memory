// Artifact layer, ported from codex-rs/memories/write/src/storage.rs and
// extensions/{ad_hoc,prune}.rs. Owns the on-disk shape that the consolidation
// prompt points at: rollout_summaries/<stem>.md,
// extensions/ad_hoc/instructions.md, and the 14-day extension resource prune.
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AD_HOC_INSTRUCTIONS } from './prompts.js'

export const EXTENSIONS_SUBDIR = 'extensions'
export const ROLLOUT_SUMMARIES_SUBDIR = 'rollout_summaries'
export const EXTENSION_RESOURCE_RETENTION_DAYS = 14

const rolloutSummariesDir = (root) => join(root, ROLLOUT_SUMMARIES_SUBDIR)
const extensionsRoot = (root) => join(root, EXTENSIONS_SUBDIR)

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
    // Timestamp-less UUID versions fall back to the source timestamp.
    timestampFragment = FILENAME_TS_FORMAT(new Date(sourceUpdatedAt * 1_000))
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

async function pruneRolloutSummaries(root, keep) {
  const dirPath = rolloutSummariesDir(root)
  let entries
  try {
    entries = await readdir(dirPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const fileName of entries) {
    if (!fileName.endsWith('.md')) continue
    const stem = fileName.slice(0, -'.md'.length)
    if (keep.has(stem)) continue
    await rm(join(dirPath, fileName), { force: true })
  }
}

async function writeRolloutSummaryForThread(root, memory) {
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
  await writeFile(join(rolloutSummariesDir(root), `${stem}.md`), `${lines.join('\n')}\n`)
}

/** Codex: sync_rollout_summaries_from_memories. */
export async function syncRolloutSummariesFromMemories(root, memories, maxRawMemories) {
  await mkdir(rolloutSummariesDir(root), { recursive: true })
  const retained = retainedMemories(memories, maxRawMemories)
  const keep = new Set(
    retained.map((memory) =>
      rolloutSummaryFileStem({
        threadId: memory.thread_id,
        sourceUpdatedAt: memory.source_updated_at,
        rolloutSlug: memory.rollout_slug,
      }),
    ),
  )
  await pruneRolloutSummaries(root, keep)
  for (const memory of retained) await writeRolloutSummaryForThread(root, memory)
}

/** Codex: extensions/ad_hoc::seed_instructions — create_new, never overwrite. */
export async function seedExtensionInstructions(root) {
  const extensionRoot = join(extensionsRoot(root), 'ad_hoc')
  await mkdir(extensionRoot, { recursive: true })
  const instructionsPath = join(extensionRoot, 'instructions.md')
  try {
    await writeFile(instructionsPath, AD_HOC_INSTRUCTIONS, { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

// Codex: resource_timestamp — the first 19 chars parsed as %Y-%m-%dT%H-%M-%S (UTC).
const resourceTimestamp = (fileName) => {
  const head = fileName.slice(0, 19)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(head)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return Number.isFinite(ms) ? ms : null
}

/** Codex: prune_old_extension_resources — 14-day retention on resources/. */
export async function pruneOldExtensionResources(root, nowMs = Date.now()) {
  const cutoff = nowMs - EXTENSION_RESOURCE_RETENTION_DAYS * 86_400_000
  let extensions
  try {
    extensions = await readdir(extensionsRoot(root), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const extension of extensions) {
    if (!extension.isDirectory()) continue
    const extensionPath = join(extensionsRoot(root), extension.name)
    // Codex skips extensions that have no instructions.md.
    try {
      await stat(join(extensionPath, 'instructions.md'))
    } catch {
      continue
    }
    const resourcesPath = join(extensionPath, 'resources')
    let resources
    try {
      resources = await readdir(resourcesPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const resource of resources) {
      if (!resource.isFile()) continue
      // Only `.md` resources carry a retention timestamp.
      if (!resource.name.endsWith('.md')) continue
      const stamp = resourceTimestamp(resource.name)
      if (stamp === null || stamp > cutoff) continue
      await rm(join(resourcesPath, resource.name), { force: true })
    }
  }
}
