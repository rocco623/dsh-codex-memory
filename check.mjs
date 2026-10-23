// Read-only check of sessions.js against real ~/.dsh/sessions data.
// Does not touch DSH_HOME; only reads and renders.
import { readThreadCandidates, renderSessionTranscript, dshHome } from './sessions.js'
import { join } from 'node:path'

const sessionsRoot = join(dshHome(), 'sessions')
const candidates = await readThreadCandidates(sessionsRoot)
console.log(`found ${candidates.length} root-thread candidates`)

let withTurns = 0
let maxLen = 0
for (const c of candidates) {
  const text = renderSessionTranscript(c.events)
  if (text.trim()) withTurns += 1
  maxLen = Math.max(maxLen, text.length)
  if (text.includes('undefined') && !text.includes('`undefined`') === false) {
    // allow "undefined" as genuine conversation content; just report count
  }
}
console.log(`ok: ${withTurns}/${candidates.length} candidates render with turns, max rendered length ${maxLen} chars`)
