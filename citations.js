// Ported from codex-rs/memories/read/src/citations.rs. The model appends one
// <oai-mem-citation> block to a final reply; its <rollout_ids> drive
// stage1_outputs.usage_count / last_usage, which in turn rank phase-2 input.

const extractBlock = (text, open, close) => {
  const openAt = text.indexOf(open)
  if (openAt === -1) return null
  const rest = text.slice(openAt + open.length)
  const closeAt = rest.indexOf(close)
  if (closeAt === -1) return null
  return rest.slice(0, closeAt)
}

const extractIdsBlock = (text) =>
  extractBlock(text, '<rollout_ids>', '</rollout_ids>') ??
  extractBlock(text, '<thread_ids>', '</thread_ids>')

const parseEntry = (line) => {
  const trimmed = line.trim()
  if (!trimmed) return null
  const noteSplit = trimmed.lastIndexOf('|note=[')
  if (noteSplit === -1) return null
  const noteRaw = trimmed.slice(noteSplit + '|note=['.length)
  if (!noteRaw.endsWith(']')) return null
  const note = noteRaw.slice(0, -1).trim()
  const location = trimmed.slice(0, noteSplit)
  const rangeSplit = location.lastIndexOf(':')
  if (rangeSplit === -1) return null
  const path = location.slice(0, rangeSplit).trim()
  const lineRange = location.slice(rangeSplit + 1)
  const dashSplit = lineRange.indexOf('-')
  if (dashSplit === -1) return null
  const lineStart = Number.parseInt(lineRange.slice(0, dashSplit).trim(), 10)
  const lineEnd = Number.parseInt(lineRange.slice(dashSplit + 1).trim(), 10)
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return null
  return { path, lineStart, lineEnd, note }
}

export function parseMemoryCitation(texts) {
  const entries = []
  const rolloutIds = []
  const seen = new Set()
  for (const text of texts) {
    if (typeof text !== 'string') continue
    const entriesBlock = extractBlock(text, '<citation_entries>', '</citation_entries>')
    if (entriesBlock !== null) {
      for (const line of entriesBlock.split('\n')) {
        const entry = parseEntry(line)
        if (entry) entries.push(entry)
      }
    }
    const idsBlock = extractIdsBlock(text)
    if (idsBlock !== null) {
      for (const line of idsBlock.split('\n')) {
        const id = line.trim()
        if (!id) continue
        if (!seen.has(id)) {
          seen.add(id)
          rolloutIds.push(id)
        }
      }
    }
  }
  if (entries.length === 0 && rolloutIds.length === 0) return null
  return { entries, rolloutIds }
}
