// Reads DSH's on-disk session logs the way Codex reads rollout .jsonl files:
// one record per root thread plus a rendering of the conversation into
// stage-1 evidence.
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeZstdFrames } from './zstd.js'

export const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

export async function listSessionFiles(sessionsRoot) {
  const out = []
  let projectDirs = []
  try {
    projectDirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsRoot, project.name)
    let sessionDirs = []
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue
      const sessionPath = join(projectPath, session.name)
      let files = []
      try {
        files = await readdir(sessionPath)
      } catch {
        continue
      }
      for (const file of files) {
        if (file.endsWith('.jsonl.zstd') || file.endsWith('.jsonl')) out.push(join(sessionPath, file))
      }
    }
  }
  return out
}

export async function decodeSession(path) {
  const buffer = await readFile(path)
  // Session logs append one zstd frame per write; the desktop runtime inflates
  // only the first frame, so multi-frame decoding is not optional here.
  const text = path.endsWith('.zstd')
    ? decodeZstdFrames(buffer).toString('utf8')
    : buffer.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // a half-written trailing line of a live session
    }
  }
  return events
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()

/**
 * Codex renders the full tiered rollout (human/final/other-agent/tool, byte
 * budgeted). This keeps the subset DSH's log makes cheap to get right: every
 * user turn verbatim plus that turn's final assistant reply.
 */
export function renderSessionTranscript(events, { maxChars = 20_000 } = {}) {
  const turns = new Map()
  let currentTurn = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      currentTurn = Number(event.data?.turn) || 0
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const turn = turns.get(currentTurn) ?? { user: [], assistant: '' }
      for (const inserted of event.data?.inserted ?? []) {
        if (inserted?.source?.kind !== 'user') continue
        const text = textOf(inserted.content)
        if (text) turn.user.push(text)
      }
      turns.set(currentTurn, turn)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (!text) continue
      const key = Number(event.data?.turn) || currentTurn
      const turn = turns.get(key) ?? { user: [], assistant: '' }
      turn.assistant = text
      turns.set(key, turn)
    }
  }
  const parts = []
  for (const [turnNumber, turn] of turns) {
    if (turn.user.length === 0 && !turn.assistant) continue
    const user = turn.user.join('\n').slice(0, 2_000)
    const assistant = turn.assistant.slice(0, 3_000)
    parts.push(`### turn ${turnNumber}\n- user: ${user}${assistant ? `\n- assistant: ${assistant}` : ''}`)
  }
  let text = parts.join('\n\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[...truncated]`
  return text
}

// Codex marks a thread `memory_mode = "polluted"` when external context was
// pulled in (disable_on_external_context). DSH's equivalents are web search and
// MCP tool calls, which appear in the log as tool results.
const EXTERNAL_CONTEXT_TOOL_RE = /^(web_search|web_fetch|mcp[_-]|mcp\.|browser)/i

export const usesExternalContext = (events) =>
  events.some((event) => {
    if (event?.type !== 'tool/result' && event?.type !== 'tool/call') return false
    const name = event.data?.tool ?? event.data?.name ?? event.data?.toolName
    return typeof name === 'string' && EXTERNAL_CONTEXT_TOOL_RE.test(name)
  })

/**
 * One record per root thread. Codex skips non-root agents via
 * `source.is_non_root_agent()`; DSH records `delegationDepth`, so > 0 is the
 * same exclusion. Plugin-owned memory agents are additionally filtered by id.
 */
export async function readThreadCandidates(sessionsRoot) {
  const candidates = []
  for (const path of await listSessionFiles(sessionsRoot)) {
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    let events
    try {
      events = await decodeSession(path)
    } catch {
      continue
    }
    const meta = events.find((event) => event?.type === 'session')
    if (!meta?.id) continue
    if (meta.parentSession) continue
    if ((Number(meta.delegationDepth) || 0) > 0) continue
    if (String(meta.id).startsWith('memory-')) continue
    candidates.push({
      threadId: meta.id,
      path,
      cwd: meta.cwd,
      updatedAtMs: info.mtimeMs,
      events,
      polluted: usesExternalContext(events),
    })
  }
  return candidates
}

/** Codex hydrates cwd/rollout_path/git_branch from the state DB; DSH has no such table. */
export const threadMetaFrom = (candidates) =>
  new Map(candidates.map((c) => [c.threadId, { cwd: c.cwd, rollout_path: c.path }]))
