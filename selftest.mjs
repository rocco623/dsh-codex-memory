// End-to-end check against a mock Cordis ctx that follows the REAL contracts:
// agents.create() is async and resolves to an AgentHandle, and per-agent
// scoped tools arrive through the `setup(agentCtx, agent)` callback.
// Uses a real temp DSH_HOME, real SQLite, and a real git repo.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const IDLE_MS = 7 * 3_600_000

async function seedSession(home, id, cwd, turns) {
  const dir = join(home, 'sessions', 'proj', `session-${id}`)
  await mkdir(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, id: `session-${id}`, cwd, delegationDepth: 0 })]
  turns.forEach((turn, index) => {
    lines.push(JSON.stringify({ type: 'turn/start', data: { turn: index } }))
    lines.push(
      JSON.stringify({
        type: 'agent/inbox/spliced',
        data: { inserted: [{ content: [{ type: 'text', text: turn.user }], source: { kind: 'user' } }] },
      }),
    )
    if (turn.assistant) {
      lines.push(
        JSON.stringify({
          type: 'assistant/message',
          data: { turn: index, message: { content: [{ type: 'text', text: turn.assistant }] } },
        }),
      )
    }
  })
  const path = join(dir, 'session.v4.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`)
  const old = (Date.now() - IDLE_MS) / 1000
  await utimes(path, old, old)
}

const V2_SUMMARY = [
  'v1',
  '## User Profile',
  'Backend-leaning engineer working across alpha and beta.',
  '## User preferences',
  '- runs tests before committing',
  '## General Tips',
  '- none yet',
  "## What's in Memory",
  '### alpha',
  '#### 2026-10-20',
  '- rollout_summaries/example.md — one-off task; thread_id=session-a',
].join('\n')

/**
 * Mock service. `respond` decides what each child agent does, based on the
 * prompt it receives, and calls the agent's own SCOPED tool.
 */
function makeCtx() {
  const globalTools = new Map()
  const creates = []
  const composed = []
  const injections = []
  const events = new Map()
  let inFlight = 0
  let maxInFlight = 0

  const respond = (sessionId, text, scoped) => {
    const isStage1 = sessionId.startsWith('memory-stage1-')
    const write = scoped.get(isStage1 ? 'memory_stage1_write_output' : 'memory_write_summary')
    assert.ok(write, `agent ${sessionId} has no write tool in its own scope`)
    if (isStage1) {
      const isV1 = text.includes('## Memory Writing Agent: Phase 1 (Single Rollout)')
      // Include a secret so the redaction path is exercised.
      const summary = `Task summary for ${sessionId}. key sk-abcdefghijklmnopqrstuvwxyz012345`
      return write.execute(
        isV1
          ? { raw_memory: summary, rollout_summary: summary, rollout_slug: 'task-slug' }
          : { rollout_summary: summary, rollout_slug: 'task-slug' },
      )
    }
    const isV1 = text.includes('## Memory Writing Agent: Phase 2 (Consolidation)')
    return write.execute(
      isV1
        ? { memory_summary: V2_SUMMARY, memory_md: '# MEMORY\n\n- alpha task\n' }
        : { memory_summary: V2_SUMMARY },
    )
  }

  const ctx = {
    tools: {
      register: (definition) => {
        globalTools.set(definition.name, definition)
        return () => globalTools.delete(definition.name)
      },
    },
    effect: (fn) => fn(),
    agents: {
      list: () => [...createRoots],
      roots: () => [...createRoots],
      create: async (options) => {
        creates.push(options)
        const scoped = new Map()
        const scopedListeners = []
        const restrictions = []
        const inner = { id: options.sessionId, session: { delegationDepth: options.parentAgent ? 1 : 0 } }
        options.setup?.(
          {
            tools: {
              register: (definition) => {
                scoped.set(definition.name, definition)
                return () => scoped.delete(definition.name)
              },
              restrict: (filter) => {
                restrictions.push(filter)
                return () => {}
              },
            },
            get: (n) => (n === 'agentPresets' ? { composeFrom: () => { composed.push(options.sessionId) } } : undefined),
            on: (event, handler) => {
              scopedListeners.push({ event, handler })
              return () => {}
            },
          },
          inner,
        )
        assert.ok(
          options.agentOptions?.provider && options.agentOptions?.model,
          `agent ${options.sessionId} must be created with an explicit provider/model route`,
        )
        assert.equal(
          options.agentOptions?.reasoningEffort,
          'max',
          `agent ${options.sessionId} must inherit the triggering agent's reasoning effort`,
        )
        assert.ok(options.meta, `agent ${options.sessionId} must be created with session meta`)
        assert.ok(
          options.setup !== undefined,
          `agent ${options.sessionId} must receive a setup callback`,
        )
        assert.equal(options.meta.agentPreset, 'standard', 'child must inherit the parent preset')
        assert.equal(options.meta.cwd, '/repo/alpha', 'child must inherit the parent cwd')
        assert.equal(options.meta.origin, 'subagent')
        assert.equal(options.meta.delegationDepth, 1, 'child depth must be parent depth + 1')
        assert.equal(options.agentOptions.subagentDepth, 1)
        assert.equal(options.agentOptions.maxTokens, 256000, 'child must inherit maxTokens')
        let pending = Promise.resolve()
        const handle = {
          agent: {
            followup: (input) => {
              inFlight += 1
              maxInFlight = Math.max(maxInFlight, inFlight)
              pending = Promise.resolve()
                .then(() => {
                  for (const l of scopedListeners) {
                    if (l.event === 'agent/request-error') {
                      void l.handler(
                        { provider: 'deepseek', failure: Object.assign(new Error('boom'), { code: 'TRANSPORT' }) },
                        () => undefined,
                      )
                    }
                  }
                  return respond(options.sessionId, input.content[0].text, scoped)
                })
                .finally(() => {
                  inFlight -= 1
                })
            },
            whenIdle: () => pending,
            inject: (message) => injections.push(message),
          },
          dispose: () => {},
        }
        return handle
      },
    },
    on: (event, handler) => {
      if (!events.has(event)) events.set(event, [])
      events.get(event).push(handler)
    },
  }

  const createRoots = []
  return {
    ctx,
    creates,
    composed,
    injections,
    globalTools,
    get maxInFlight() {
      return maxInFlight
    },
    emitSessionEvent: (session, event) => {
      for (const handler of events.get('session/event') ?? []) handler(session, event)
    },
    rootAgentFor: (id) => createRoots.find((a) => a.id === id),
    async created(agent) {
      createRoots.push(agent)
      for (const handler of events.get('agent/created') ?? []) await handler({ agent })
    },
  }
}

const startSession = async (harness, id) => {
  const agent = makeRootAgent(id)
  await harness.created(agent)
  // Either boundary starts the pipeline once; user/message is the live one.
  harness.emitSessionEvent(agent.session, { type: 'user/message', data: { content: [] } })
  harness.emitSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1 } })
  return agent
}

const makeRootAgent = (id) => ({
  id,
  session: {
    id,
    delegationDepth: 0,
    header: { id, cwd: '/repo/alpha', delegationDepth: 0 },
    requestHeader: () => ({
      config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max', maxTokens: 256000 },
    }),
  },
  options: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 256000 },
  ctx: { get: (name) => (name === 'agentPresets' ? { composedPreset: () => 'standard' } : undefined) },
  inject: () => {},
})

async function scenarioV2() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mem-v2-'))
  process.env.DSH_HOME = home
  await seedSession(home, 'a', '/repo/alpha', [{ user: 'always run tests', assistant: 'noted' }])
  await seedSession(home, 'b', '/repo/beta', [{ user: 'rename getUserName', assistant: 'renamed in 3 files' }])
  await seedSession(home, 'c', '/repo/gamma', [{ user: 'third task', assistant: 'done' }])

  const harness = makeCtx()
  const mod = await import('./index.js')
  mod.apply(harness.ctx, { maxRolloutsPerStartup: 8, minRolloutIdleHours: 6 })

  assert.deepEqual(
    [...harness.globalTools.keys()].sort(),
    ['memory_note', 'memory_search'],
    'only user-facing tools are global; both writers must be agent-scoped',
  )

  await startSession(harness, 'session-root')
  await new Promise((resolve) => setTimeout(resolve, 400))

  const stage1 = harness.creates.filter((c) => c.sessionId.startsWith('memory-stage1-'))
  const phase2 = harness.creates.filter((c) => c.sessionId.startsWith('memory-phase2-'))
  assert.equal(stage1.length, 3, `expected 3 stage-1 agents, got ${stage1.length}`)
  assert.equal(phase2.length, 1, `expected 1 phase-2 agent, got ${phase2.length}`)
  for (const create of harness.creates) {
    assert.ok(create.parentAgent, 'every memory agent must be a child (parentAgent) so it is not a runtime root')
  }
  assert.equal(
    harness.composed.length,
    harness.creates.length,
    'every memory agent must inherit the parent composition via agentPresets.composeFrom',
  )
  assert.ok(harness.maxInFlight > 1, `stage-1 must run concurrently (max in flight ${harness.maxInFlight})`)

  const root = join(home, 'memories_v2')
  const summary = await readFile(join(root, 'memory_summary.md'), 'utf8')
  assert.ok(summary.startsWith('v1\n'), 'summary must start with v1')

  const rolloutFiles = await readdir(join(root, 'rollout_summaries'))
  assert.equal(rolloutFiles.length, 3, 'one rollout summary per selected thread')
  for (const file of rolloutFiles) {
    assert.match(file, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-zA-Z]{4}-task_slug\.md$/, `bad stem ${file}`)
    const body = await readFile(join(root, 'rollout_summaries', file), 'utf8')
    assert.match(body, /^thread_id: /)
    assert.match(body, /\nupdated_at: \d{4}-\d{2}-\d{2}T/)
    assert.match(body, /\nrollout_path: /)
    assert.match(body, /\ncwd: \/repo\//)
    assert.match(body, /\[REDACTED_SECRET\]/, 'stage-1 output must be redacted before storage')
  }

  // V2 writes no raw_memories.md / MEMORY.md, and extensions are seeded.
  await assert.rejects(stat(join(root, 'raw_memories.md')), 'v2 must not write raw_memories.md')
  await assert.rejects(stat(join(root, 'MEMORY.md')), 'v2 must not write MEMORY.md')
  const instructions = await readFile(join(root, 'extensions', 'ad_hoc', 'instructions.md'), 'utf8')
  assert.match(instructions, /Never delete a note file/, 'ad_hoc instructions must be seeded verbatim')

  const diagnostics = await readFile(join(root, 'diagnostics.log'), 'utf8')
  assert.match(diagnostics, /"event":"request-error"/, 'provider failures must be recorded with a cause chain')
  assert.match(diagnostics, /"code":"TRANSPORT"/)

  const { stdout: log } = await run('git', ['log', '--oneline'], { cwd: root })
  assert.match(log, /baseline/)
  assert.match(log, /consolidation/)
  const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: root })
  assert.equal(status.trim(), '', 'memory root must be clean after the consolidation commit')

  // Citation -> usage_count/last_usage.
  const { openMemoryStore } = await import('./db.js')
  const db = openMemoryStore(join(home, 'memory_state.db'))
  const before = db.db.prepare('SELECT usage_count, last_usage FROM stage1_outputs LIMIT 1').get()
  assert.equal(before.usage_count, null, 'usage starts null')
  harness.emitSessionEvent({ id: 'session-root' }, {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          {
            type: 'text',
            text:
              'Answer.\n\n<oai-mem-citation>\n<citation_entries>\nrollout_summaries/x.md:1-2|note=[used]\n</citation_entries>\n<rollout_ids>' +
              db.db.prepare('SELECT thread_id FROM stage1_outputs LIMIT 1').get().thread_id +
              '</rollout_ids>\n</oai-mem-citation>\n',
          },
        ],
      },
    },
  })
  const after = db.db.prepare('SELECT usage_count, last_usage FROM stage1_outputs ORDER BY usage_count DESC LIMIT 1').get()
  assert.equal(after.usage_count, 1, 'citation must bump usage_count')
  assert.ok(after.last_usage > 0, 'citation must set last_usage')
  db.close()

  // Read path: a later root agent gets the verbatim read_path_v2 template.
  const later = await startSession(harness, 'session-later')
  const injected = []
  later.inject = (message) => injected.push(message)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(injected.length >= 1, 'read path must inject on a new root agent')
  assert.match(injected[0].id ?? '', /^[0-9a-f-]{36}$/, 'injected message needs a stable identity')
  assert.equal(injected[0].role, 'user', 'injected message must carry the user role')
  const text = injected[0].content[0].text
  assert.match(text, /^## Memory\n/, 'read path must be the Codex template, not a paraphrase')
  assert.match(text, /MEMORY_SUMMARY BEGINS/)
  assert.match(text, /<oai-mem-citation>/, 'v2 read path carries the citation protocol')
  assert.match(text, new RegExp(`rollout_summaries/`), 'read path points at rollout summaries')

  // Re-extraction: a later update to an already-succeeded session must be
  // re-claimable, while the 6h phase-2 success cooldown suppresses a second
  // consolidation run.
  const stage1Before = harness.creates.filter((c) => c.sessionId.startsWith('memory-stage1-')).length
  const phase2Before = harness.creates.filter((c) => c.sessionId.startsWith('memory-phase2-')).length
  const bumped = join(home, 'sessions', 'proj', 'session-a', 'session.v4.jsonl')
  const bumpedAt = (Date.now() - 6.5 * 3_600_000) / 1000
  await utimes(bumped, bumpedAt, bumpedAt)
  await startSession(harness, 'session-root-2')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const stage1After = harness.creates.filter((c) => c.sessionId.startsWith('memory-stage1-')).length
  const phase2After = harness.creates.filter((c) => c.sessionId.startsWith('memory-phase2-')).length
  assert.equal(stage1After, stage1Before + 1, 'an updated session must be re-extracted')
  assert.equal(phase2After, phase2Before, 'phase 2 must respect the 6h success cooldown')

  await rm(home, { recursive: true, force: true })
}

async function scenarioPruneAndCooldown() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mem-prune-'))
  process.env.DSH_HOME = home
  const root = join(home, 'memories_v2')
  await mkdir(join(root, 'extensions', 'ad_hoc', 'resources'), { recursive: true })
  await writeFile(join(root, 'extensions', 'ad_hoc', 'instructions.md'), 'x')
  const stale = join(root, 'extensions', 'ad_hoc', 'resources', '2020-01-01T00-00-00-old.md')
  const fresh = join(root, 'extensions', 'ad_hoc', 'resources', '2999-01-01T00-00-00-new.md')
  const notMarkdown = join(root, 'extensions', 'ad_hoc', 'resources', '2020-01-01T00-00-00-keep.txt')
  await writeFile(stale, 'old')
  await writeFile(fresh, 'new')
  await writeFile(notMarkdown, 'keep')

  const { pruneOldExtensionResources } = await import('./storage.js')
  await pruneOldExtensionResources(root)
  const left = await readdir(join(root, 'extensions', 'ad_hoc', 'resources'))
  assert.deepEqual(
    [...left].sort(),
    ['2020-01-01T00-00-00-keep.txt', '2999-01-01T00-00-00-new.md'],
    'only stale .md resources are pruned',
  )

  await rm(home, { recursive: true, force: true })
}

async function scenarioZstdFrames() {
  // Session logs append one zstd frame per write. The desktop runtime inflates
  // only the first frame, so decodeZstdFrames must join all of them.
  const { zstdCompressSync } = await import('node:zlib')
  const { decodeZstdFrames } = await import('./zstd.js')
  const parts = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']
  const multi = Buffer.concat(parts.map((part) => zstdCompressSync(Buffer.from(part, 'utf8'))))
  const single = zstdCompressSync(Buffer.from(parts.join(''), 'utf8'))
  assert.equal(
    decodeZstdFrames(multi).toString('utf8'),
    parts.join(''),
    'multi-frame logs must decode completely, not just the first frame',
  )
  assert.equal(decodeZstdFrames(single).toString('utf8'), parts.join(''), 'single frame still works')

  // A real appended session log on this machine, if one exists.
  const { readdir } = await import('node:fs/promises')
  const sessions = join(process.env.HOME, '.dsh', 'sessions')
  const dirs = await readdir(sessions).catch(() => [])
  for (const dir of dirs.slice(0, 3)) {
    const inner = await readdir(join(sessions, dir)).catch(() => [])
    for (const session of inner.slice(0, 2)) {
      const files = await readdir(join(sessions, dir, session)).catch(() => [])
      const log = files.find((f) => f.endsWith('.jsonl.zstd'))
      if (!log) continue
      const raw = await readFile(join(sessions, dir, session, log))
      const decoded = decodeZstdFrames(raw).toString('utf8')
      const lines = decoded.split('\n').filter(Boolean)
      assert.ok(lines.length >= 1, `real log ${log} decoded to nothing`)
      for (const line of lines) JSON.parse(line)
      return
    }
  }
}

await scenarioZstdFrames()
await scenarioV2()
await scenarioPruneAndCooldown()
console.log('ok: multi-frame zstd + v2 pipeline, scoped tools, concurrency, redaction, citations, read path, prune, cooldown')
