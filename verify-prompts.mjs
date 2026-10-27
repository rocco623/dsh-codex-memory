// Template hashes are pinned to Codex c260087efe8cc6dcc0526e7018ae9e0e3fc134e3.
// The hashes were independently checked against that revision's Git blob IDs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

const hashes = {
 'memories/stage_one_system_v2.md':'334c0d51a2c63bd317dac074155fb3ecf0a56af8b00657736bab9c74222372b4',
 'memories/stage_one_input_v2.md':'8fd4bb25fe6bd746b2d46ad841ac3a195d220c3da0cb9230615e2347c6ef853e',
 'memories/consolidation_v2.md':'7334fdb4aa5d958bcff54568a375d0b0145c19a611a1a22faa6bf251a46a5f0e',
 'memories/read_path_v2.md':'2f81fa2e89f341a1b7b3cf11ee7b855087c4ab84ddad920980475465ef28ff27',
 'extensions/ad_hoc/instructions.md':'d36a36083d92f9d44efbd95e0e4b6e81d7d149e812f2bca2009b6dd4b8aa93e7',
 'compact/prompt.md':'ab0c334d4faca17e3afbb9b16967c1b2fdcc7242a9a0880af57949fa236d6d07',
 'compact/summary_prefix.md':'e9b088e794a6bb9082ac053fcc760bd818d7e720ee4bcdc72c6e480de7b7cb0e',
}
for(const [file,hash] of Object.entries(hashes))assert.equal(createHash('sha256').update(readFileSync(join(DIR,file))).digest('hex'),hash,`upstream template changed: ${file}`)
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
