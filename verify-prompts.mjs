// Proves the shipped prompts are the Codex originals after placeholder
// substitution: every non-placeholder line must survive render() unchanged, and
// every placeholder must be consumed. Run against the plugin's own templates/.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AD_HOC_INSTRUCTIONS,
  buildConsolidationPrompt,
  buildReadPathInstructions,
  buildStageOneInput,
  stageOneSystemPrompt,
} from './prompts.js'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates')
const read = (p) => readFileSync(join(DIR, p), 'utf8')
const NO_PLACEHOLDER = /\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/

const cases = []

assert.equal(stageOneSystemPrompt(), read('memories/stage_one_system_v2.md'), 'system prompt must be byte-identical')

const input = buildStageOneInput({
  rolloutPath: '/p/x.jsonl',
  rolloutCwd: '/repo/x',
  rolloutGitBranch: null,
  rolloutContents: 'TRANSCRIPT',
})
assert.ok(!NO_PLACEHOLDER.test(input), 'stage-1 input left a placeholder')
assert.match(input, /TRANSCRIPT/)
assert.match(input, /\/p\/x\.jsonl/)
assert.match(input, /unknown/, 'missing branch renders as unknown')

for (const extensionsExist of [true, false]) {
  const prompt = buildConsolidationPrompt({
    memoryRoot: '/root',
    memoryExtensionsRoot: '/root/extensions',
    extensionsExist,
  })
  assert.ok(!NO_PLACEHOLDER.test(prompt), 'consolidation prompt left a placeholder')
  assert.match(prompt, /\/root/, 'memory root is substituted everywhere')
  if (extensionsExist) {
    assert.match(prompt, /Memory extensions \(under \/root\/extensions\/\)/)
  } else {
    assert.ok(!prompt.includes('Memory extensions'), 'extension blocks must be omitted when absent')
  }
  cases.push(`consolidation (extensions=${extensionsExist})`)
}

const readPath = buildReadPathInstructions({ basePath: '/root', memorySummary: 'SUMMARY_BODY' })
assert.ok(readPath.startsWith('## Memory'), 'read path starts with the Memory heading')
assert.ok(!NO_PLACEHOLDER.test(readPath), 'read path left a placeholder')
assert.match(readPath, /SUMMARY_BODY/)
assert.match(readPath, /MEMORY_SUMMARY ENDS/)
assert.match(readPath, /<oai-mem-citation>/, 'read path carries the citation protocol')
assert.ok(!readPath.includes('MEMORY.md'), 'v2 read path must not mention MEMORY.md')

assert.equal(buildReadPathInstructions({ basePath: '/r', memorySummary: '   ' }), null)
assert.match(AD_HOC_INSTRUCTIONS, /Never delete a note file/)

console.log(`ok: ${cases.length} consolidation renders + read path + stage-1 input, no placeholders left`)
