// dsh-codex-memory: Codex's v2 memory pipeline ported onto DSH/Cordis.
//
// Pipeline (codex-rs/memories/write/src/start.rs):
//   ensure_layout -> seed_extension_instructions -> phase1::prune -> phase1::run
//   -> phase2::run. Only the V2 pipeline is implemented; see the deviations note.
//
// Phase 1 extracts one idle root session per job with a child agent and stores
// redacted, truncated stage-1 output. Phase 2 claims one global lock, syncs the
// selected rows into rollout_summaries/, diffs the memory root against its git
// baseline, and only then spawns a consolidation agent.
//
// Deliberate deviations, each isolated to one place:
//   - V2 only. Codex additionally ships a V1 pipeline (MEMORY.md + raw_memories.md)
//     that is still its config default; this plugin implements just V2, so
//     config.memories.version is not a knob here.
//   - No rate-limit gate: Codex's guard.rs calls a ChatGPT-backend-only endpoint.
//   - Consolidation runs in a child agent restricted with tools.restrict() rather
//     than a kernel WorkspaceWrite sandbox, which Cordis does not expose here.
//   - Stage-1 evidence is every user turn plus that turn's final assistant reply,
//     not Codex's full tiered token-budgeted response-item replay.
//   - Only the ad_hoc memory extension is implemented.

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseMemoryCitation } from './citations.js'
import { openMemoryStore } from './db.js'
import { buildConsolidationPrompt, buildReadPathInstructions, buildStageOneInput, stageOneSystemPrompt } from './prompts.js'
import { redactSecrets } from './redact.js'
import { dshHome, readThreadCandidates, renderSessionTranscript } from './sessions.js'
import {
  pruneOldExtensionResources,
  seedExtensionInstructions,
  syncRolloutSummariesFromMemories,
} from './storage.js'
import {
  memoryWorkspaceDiff,
  prepareMemoryWorkspace,
  resetMemoryWorkspaceBaseline,
  validateConsolidationArtifacts,
  writeWorkspaceDiff,
} from './workspace.js'

const SOURCE = 'dsh-codex-memory'
// DSH validates stored user/message events for a non-empty id and the user
// role, so inject/followup must receive a complete UserMessage rather than a
// bare { content, source }: a user message without identity makes the session
// log unreadable the next time history loads.
const userMessage = (text) => ({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: SOURCE },
})
const ROLLOUT_SUMMARY_MAX_BYTES = 9_000
// MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT is 2,500 tokens; the
// read path truncates the injected summary at that budget.
const READ_PATH_SUMMARY_MAX_CHARS = 2_500 * 4

const DEFAULTS = {
  generateMemories: true,
  useMemories: true,
  disableOnExternalContext: true,
  // DEFAULT_MEMORIES_* from codex-rs/config/src/types.rs
  maxRawMemoriesForConsolidation: 256,
  maxUnusedDays: 30,
  maxRolloutAgeDays: 10,
  maxRolloutsPerStartup: 2,
  minRolloutIdleHours: 6,
  // stage_one::CONCURRENCY_LIMIT / JOB_LEASE_SECONDS / JOB_RETRY_DELAY_SECONDS / PRUNE_BATCH_SIZE
  concurrencyLimit: 8,
  stage1LeaseSeconds: 3_600,
  stage1RetryDelaySeconds: 3_600,
  stage1PruneBatch: 200,
  // stage_two::JOB_LEASE_SECONDS / JOB_RETRY_DELAY_SECONDS / JOB_HEARTBEAT_SECONDS
  phase2LeaseSeconds: 3_600,
  phase2RetryDelaySeconds: 3_600,
  phase2HeartbeatSeconds: 90,
  // PHASE2_SUCCESS_COOLDOWN_SECONDS
  phase2SuccessCooldownSeconds: 6 * 60 * 60,
  // Not a Codex constant: bounds one background agent run so a stuck agent
  // cannot hold the phase-2 lock until the lease expires.
  agentTimeoutMs: 10 * 60 * 1_000,
  // Empty means "inherit the creating agent's route"; a value overrides it.
  model: '',
  provider: '',
  // Codex uses ReasoningEffort::Low for stage one and Medium for stage two.
  // Empty means "inherit": the loop rejects an effort the model does not support.
  stage1ReasoningEffort: '',
  stage2ReasoningEffort: '',
  // Writes memories_v2/diagnostics.log with the cause chain of agent failures.
  diagnostics: true,
}

const toUnixSeconds = (ms) => Math.floor(ms / 1_000)

const log = (level, message) => {
  // eslint-disable-next-line no-console
  console[level](`[${SOURCE}] ${message}`)
}

const describeError = (error) => {
  const chain = []
  let current = error
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    chain.push({
      name: current.name ?? typeof current,
      code: current.code,
      message: current.message ?? String(current),
      ...(current.errno === undefined ? {} : { errno: current.errno }),
      ...(current.syscall === undefined ? {} : { syscall: current.syscall }),
      ...(current.cause === undefined ? {} : { hasCause: true }),
    })
    current = current.cause
  }
  return chain
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()

const truncateBytes = (text, maxBytes) => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '')
}

export const name = 'dsh-codex-memory'
export const inject = ['tools', 'agents']

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config }
  const home = dshHome()
  const sessionsRoot = join(home, 'sessions')
  // Codex keeps one state DB in codex_home and shares stage1_outputs across
  // memory versions; this mirrors that with a single file.
  const dbPath = join(home, 'memory_state.db')
  // Codex's V2 memory root (MemoryVersion::V2.directory_name()).
  const memoryRoot = join(home, 'memories_v2')

  const diagnosticsPath = join(memoryRoot, 'diagnostics.log')
  const diag = async (event, detail) => {
    if (!opts.diagnostics) return
    try {
      await mkdir(memoryRoot, { recursive: true })
      await appendFile(
        diagnosticsPath,
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...detail })}\n`,
      )
    } catch {
      // diagnostics must never break the pipeline
    }
  }

  let store = null
  const getStore = () => {
    if (!store) store = openMemoryStore(dbPath)
    return store
  }
  ctx.on('dispose', () => store?.close())

  /**
   * Child agents must be created exactly the way DSH's own subagent backend
   * creates them (dsh-subagent resolveChildAgentOptions / childSessionMeta):
   * the parent's effective route, its preset via `meta`, the parent's cwd and
   * delegation depth. A child built without the preset inherits no composition,
   * and its model requests then fail at the transport layer even though the
   * request route looks identical.
   */
  const readRequestConfig = (agent) => {
    try {
      return agent?.session?.requestHeader?.()?.config
    } catch {
      return undefined
    }
  }

  /** The pipeline fires on creation, before the parent's first request settles. */
  const waitForRequestConfig = async (agent, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    let config = readRequestConfig(agent)
    while (config === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      config = readRequestConfig(agent)
    }
    return config
  }

  const resolveChildPlan = async (parentAgent) => {
    const config = await waitForRequestConfig(parentAgent)
    const created = { ...(parentAgent?.options ?? {}) }
    // The live request settles provider/model/effort; created options may be stale.
    delete created.provider
    delete created.model
    delete created.reasoningEffort
    const agentOptions = config
      ? {
          ...created,
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        }
      : { ...(parentAgent?.options ?? {}) }

    if (opts.provider.trim()) agentOptions.provider = opts.provider.trim()
    if (opts.model.trim()) agentOptions.model = opts.model.trim()

    const header = parentAgent?.session?.header ?? {}
    const depth = Number(header.delegationDepth ?? 0) + 1
    agentOptions.subagentDepth = depth

    let agentPreset
    try {
      agentPreset = parentAgent?.ctx?.get?.('agentPresets')?.composedPreset?.(parentAgent.ctx)
    } catch {
      agentPreset = undefined
    }

    const meta = {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(header.id === undefined ? {} : { parentSession: header.id }),
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: depth,
    }
    return {
      agentOptions,
      meta,
      // dsh-subagent still calls applyChildComposition in setup even when the
      // inherited preset rides along in `meta`; only an explicitly *requested*
      // preset skips it. This plugin never requests one, so always compose.
      composeFromParent: true,
    }
  }

  const planFor = (plan, effortOverride) => ({
    ...plan,
    agentOptions: {
      ...plan.agentOptions,
      ...(effortOverride ? { reasoningEffort: effortOverride } : {}),
    },
  })

  const setupChild = (agentCtx, parentAgent, plan, tool) => {
    agentCtx.tools.register(tool)
    // The turn only surfaces `{message, code}`; the adapter's real cause chain is
    // still attached in memory here, which is the only place to learn it.
    try {
      agentCtx.on('agent/request-error', (payload, next) => {
        void diag('request-error', {
          agent: plan.meta?.parentSession,
          provider: payload?.provider,
          failure: payload?.failure,
          chain: describeError(payload?.failure),
        })
        return next()
      })
    } catch (error) {
      log('warn', `could not attach request diagnostics: ${error?.message ?? error}`)
    }
    if (plan.composeFromParent) {
      try {
        agentCtx.get?.('agentPresets')?.composeFrom?.(agentCtx, parentAgent?.ctx)
      } catch (error) {
        log('warn', `could not inherit the agent preset: ${error?.message ?? error}`)
      }
    }
    // Best effort hygiene; restriction is not correctness.
    try {
      agentCtx.tools.restrict({ deny: ['memory_search', 'memory_note'] })
    } catch (error) {
      log('warn', `could not restrict memory agent tools: ${error?.message ?? error}`)
    }
  }

  const withTimeout = (promise, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })

  // ---- read path (Codex: ext/memories build_memory_tool_developer_instructions)

  const injectMemory = async (agent) => {
    if (!opts.useMemories) return
    const basePath = memoryRoot
    let summary
    try {
      summary = await readFile(join(basePath, 'memory_summary.md'), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const instructions = buildReadPathInstructions({
      basePath,
      memorySummary: truncateBytes(summary, READ_PATH_SUMMARY_MAX_CHARS),
    })
    if (!instructions) return
    // Codex adds this to developer instructions; inject() is the closest
    // model-facing context primitive and lands in the next admitted step.
    agent.inject(userMessage(instructions))
  }

  // ---- phase 1 -------------------------------------------------------------

  const runStage1Agent = async ({ candidate, parentAgent, plan, transcript }) => {
    const slot = { output: null }
    const writeTool = {
      name: 'memory_stage1_write_output',
      description:
        'Record this rollout\'s stage-1 memory output. Call exactly once with the required JSON fields.',
      // Codex: phase1_output::output_schema(MemoryVersion::V2)
      parameters: {
        type: 'object',
        properties: {
          rollout_summary: { type: 'string' },
          rollout_slug: { type: 'string' },
        },
        required: ['rollout_summary', 'rollout_slug'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (text) => text },
      async execute(args) {
        slot.output = args
        return 'recorded'
      },
    }

    const handle = await ctx.agents.create({
      sessionId: `memory-stage1-${randomUUID()}`,
      parentAgent,
      ...(plan.meta === undefined ? {} : { meta: plan.meta }),
      agentOptions: planFor(plan, opts.stage1ReasoningEffort.trim()).agentOptions,
      setup: (agentCtx) => setupChild(agentCtx, parentAgent, plan, writeTool),
    })
    try {
      const input = buildStageOneInput({
        rolloutPath: candidate.path,
        rolloutCwd: candidate.cwd ?? '',
        rolloutGitBranch: null,
        rolloutContents: transcript,
      })
      handle.agent.followup(userMessage(`${stageOneSystemPrompt()}\n\n${input}`))
      await withTimeout(handle.agent.whenIdle(), opts.agentTimeoutMs)
    } finally {
      await handle.dispose?.()
    }
    if (!slot.output) throw new Error('stage-1 agent did not call memory_stage1_write_output')
    return slot.output
  }

  // Codex: phase1_output::StageOneOutput::parse for V2 — v2 never decodes
  // raw_memory (the column stores ''), and the summary is redacted and capped.
  const parseStage1Output = (raw) => ({
    rawMemory: '',
    rolloutSummary: truncateBytes(redactSecrets(String(raw.rollout_summary ?? '')), ROLLOUT_SUMMARY_MAX_BYTES),
    rolloutSlug: raw.rollout_slug == null ? null : redactSecrets(String(raw.rollout_slug)),
  })

  const runStage1Job = async ({ candidate, db, workerId, parentAgent, plan, meta }) => {
    const sourceUpdatedAt = toUnixSeconds(candidate.updatedAtMs)
    const token = db.tryClaimStage1Job(
      candidate.threadId,
      workerId,
      sourceUpdatedAt,
      opts.stage1LeaseSeconds,
      opts.maxRolloutsPerStartup,
    )
    if (!token) return false
    try {
      const transcript = renderSessionTranscript(candidate.events)
      if (!transcript.trim()) {
        // Codex: mark_stage1_job_succeeded_no_output — release the job and drop
        // any row from an earlier extraction that no longer has evidence.
        db.stage1JobSucceededNoOutput(candidate.threadId, token)
        return true
      }
      const output = await runStage1Agent({ candidate, parentAgent, plan, transcript })
      const parsed = parseStage1Output(output)
      db.upsertStage1Output({
        threadId: candidate.threadId,
        sourceUpdatedAt,
        rawMemory: parsed.rawMemory,
        rolloutSummary: parsed.rolloutSummary,
        rolloutSlug: parsed.rolloutSlug,
      })
      db.stage1JobSucceeded(candidate.threadId, token)
      meta.set(candidate.threadId, { cwd: candidate.cwd, rollout_path: candidate.path })
      return true
    } catch (error) {
      db.stage1JobFailed(candidate.threadId, token, String(error?.message ?? error), opts.stage1RetryDelaySeconds)
      void diag('stage1-failed', { thread: candidate.threadId, chain: describeError(error) })
      log('warn', `stage-1 extraction failed for ${candidate.threadId}: ${error?.message ?? error}`)
      return false
    }
  }

  const runPhase1 = async ({ db, workerId, parentAgent, plan, currentThreadId, meta }) => {
    const now = Date.now()
    const idleCutoff = now - opts.minRolloutIdleHours * 3_600_000
    const maxAgeCutoff = now - opts.maxRolloutAgeDays * 86_400_000
    const candidates = await readThreadCandidates(sessionsRoot)
    for (const candidate of candidates) meta.set(candidate.threadId, { cwd: candidate.cwd, rollout_path: candidate.path })

    const eligible = candidates
      .filter((c) => c.threadId !== currentThreadId)
      .filter((c) => c.updatedAtMs <= idleCutoff && c.updatedAtMs >= maxAgeCutoff)
      .filter((c) => !(opts.disableOnExternalContext && c.polluted))
      .filter((c) => db.stage1NeedsUpdate(c.threadId, toUnixSeconds(c.updatedAtMs)))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, opts.maxRolloutsPerStartup)

    let extracted = 0
    for (let i = 0; i < eligible.length; i += opts.concurrencyLimit) {
      const batch = eligible.slice(i, i + opts.concurrencyLimit)
      const results = await Promise.all(
        batch.map((candidate) =>
          runStage1Job({ candidate, db, workerId, parentAgent, plan, meta }),
        ),
      )
      extracted += results.filter(Boolean).length
    }
    if (eligible.length > 0) {
      void diag('phase1', { eligible: eligible.length, extracted, threads: eligible.map((c) => c.threadId) })
      log('info', `phase 1: extracted ${extracted}/${eligible.length} session(s)`)
    }
    return extracted
  }

  // ---- phase 2 -------------------------------------------------------------

  const runConsolidationAgent = async ({ root, memoryRootExists, parentAgent, plan }) => {
    const slot = { summary: null }
    const writeTool = {
      name: 'memory_write_summary',
      description:
        'Write the consolidated memory artifacts. Call exactly once with the complete file contents. Use this instead of the write tool: the memory root is outside the session sandbox.',
      parameters: {
        type: 'object',
        properties: {
          memory_summary: { type: 'string', description: 'Complete contents of memory_summary.md' },
        },
        required: ['memory_summary'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (text) => text },
      async execute(args) {
        if (typeof args.memory_summary !== 'string' || !args.memory_summary.trim()) {
          throw new Error('memory_summary is required')
        }
        await mkdir(root, { recursive: true })
        const tmpSummary = `${join(root, 'memory_summary.md')}.${randomUUID()}.tmp`
        await writeFile(tmpSummary, args.memory_summary.endsWith('\n') ? args.memory_summary : `${args.memory_summary}\n`)
        await rename(tmpSummary, join(root, 'memory_summary.md'))
        slot.summary = args.memory_summary
        return 'recorded'
      },
    }

    const handle = await ctx.agents.create({
      sessionId: `memory-phase2-${randomUUID()}`,
      parentAgent,
      ...(plan.meta === undefined ? {} : { meta: plan.meta }),
      agentOptions: planFor(plan, opts.stage2ReasoningEffort.trim()).agentOptions,
      setup: (agentCtx) => setupChild(agentCtx, parentAgent, plan, writeTool),
    })
    try {
      const prompt = buildConsolidationPrompt({
        memoryRoot: root,
        memoryExtensionsRoot: join(root, 'extensions'),
        extensionsExist: memoryRootExists,
      })
      handle.agent.followup(userMessage(prompt))
      await withTimeout(handle.agent.whenIdle(), opts.agentTimeoutMs)
    } finally {
      await handle.dispose?.()
    }
    if (!slot.summary) throw new Error('consolidation agent did not call memory_write_summary')
  }

  const runPhase2 = async ({ db, workerId, parentAgent, plan, meta }) => {
    const claim = db.tryClaimGlobalPhase2Job(
      workerId,
      opts.phase2LeaseSeconds,
      opts.phase2SuccessCooldownSeconds,
    )
    if (claim.outcome !== 'claimed') return

    const root = memoryRoot
    const heartbeat = setInterval(
      () => db.heartbeatGlobalPhase2Job(claim.token, opts.phase2LeaseSeconds),
      opts.phase2HeartbeatSeconds * 1_000,
    )
    try {
      await prepareMemoryWorkspace(root)
      const extensionsExist = await stat(join(root, 'extensions')).then(
        (info) => info.isDirectory(),
        () => false,
      )

      const rawMemories = db
        .getPhase2InputSelection(opts.maxRawMemoriesForConsolidation, opts.maxUnusedDays)
        .map((row) => ({
          ...row,
          cwd: meta.get(row.thread_id)?.cwd ?? null,
          rollout_path: meta.get(row.thread_id)?.rollout_path ?? null,
          git_branch: null,
        }))

      await syncRolloutSummariesFromMemories(root, rawMemories, opts.maxRawMemoriesForConsolidation)
      await pruneOldExtensionResources(root)

      const diff = await memoryWorkspaceDiff(root)
      const artifactsValid = await validateConsolidationArtifacts(root).then(
        () => true,
        () => false,
      )
      const newWatermark = rawMemories.reduce(
        (acc, row) => Math.max(acc, row.source_updated_at),
        claim.watermark,
      )
      if (!diff.hasChanges() && artifactsValid) {
        db.phase2JobSucceeded(claim.token, newWatermark, rawMemories)
        return
      }

      await writeWorkspaceDiff(root, diff)
      await runConsolidationAgent({ root, memoryRootExists: extensionsExist, parentAgent, plan })
      await validateConsolidationArtifacts(root)
      await resetMemoryWorkspaceBaseline(root)
      db.phase2JobSucceeded(claim.token, newWatermark, rawMemories)
      log('info', `phase 2: consolidated ${rawMemories.length} stage-1 output(s)`)
    } catch (error) {
      db.phase2JobFailed(claim.token, String(error?.message ?? error), opts.phase2RetryDelaySeconds)
      void diag('phase2-failed', { chain: describeError(error) })
      log('warn', `phase 2 failed: ${error?.message ?? error}`)
    } finally {
      clearInterval(heartbeat)
    }
  }


  // ---- startup pipeline (Codex: start_memories_startup_task) -----------------

  const runStartupPipeline = async ({ parentAgent, currentThreadId }) => {
    if (!opts.generateMemories) return
    const db = getStore()
    const workerId = `worker-${process.pid}`
    const meta = new Map()
    try {
      await mkdir(memoryRoot, { recursive: true })
      await seedExtensionInstructions(memoryRoot)
      // Token-free retention cleanup runs before any quota consideration.
      db.pruneStage1Outputs(opts.maxUnusedDays, opts.stage1PruneBatch)
      const plan = await resolveChildPlan(parentAgent)
      await runPhase1({ db, workerId, parentAgent, plan, currentThreadId, meta })
      await runPhase2({ db, workerId, parentAgent, plan, meta })
    } catch (error) {
      log('warn', `memory pipeline failed: ${error?.message ?? error}`)
    }
  }

  // ---- citation -> usage (Codex: read/src/citations.rs + record_stage1_output_usage)

  ctx.on(
    'session/event',
    (_session, event) => {
      if (event?.type !== 'assistant/message') return
      const text = textOf(event.data?.message?.content ?? event.data?.content)
      if (!text.includes('<oai-mem-citation>') && !text.includes('<citation_entries>')) return
      const citation = parseMemoryCitation([text])
      if (!citation || citation.rolloutIds.length === 0) return
      try {
        getStore().recordStage1OutputUsage(citation.rolloutIds)
      } catch (error) {
        log('warn', `failed recording memory usage: ${error?.message ?? error}`)
      }
    },
    { global: true },
  )

  // ---- user-facing memory tools --------------------------------------------

  const noteTool = {
    name: 'memory_note',
    description:
      'Record an explicit user request to remember or forget something as an ad-hoc memory note. ' +
      'Only call this when the user asks; the note is applied by the next consolidation pass.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The exact thing to remember or forget.' } },
      required: ['note'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (t) => t },
    async execute({ note }) {
      if (typeof note !== 'string' || !note.trim()) throw new Error('note is required')
      const notesDir = join(memoryRoot, 'extensions', 'ad_hoc', 'notes')
      await mkdir(notesDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = `${stamp}-${randomUUID().slice(0, 8)}.md`
      await writeFile(join(notesDir, file), `${note.trim()}\n`)
      return `noted in extensions/ad_hoc/notes/${file}; applied at the next consolidation`
    },
  }

  const searchTool = {
    name: 'memory_search',
    description: 'Search memory_summary.md, rollout_summaries/*.md and ad-hoc notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'array', items: { type: 'string' } }, render: (lines) => lines.join('\n') },
    async execute({ query, max_results }) {
      const limit = Math.min(Math.max(Number(max_results) || 40, 1), 200)
      const needle = String(query).toLowerCase()
      const root = memoryRoot
      const results = []
      const scan = async (path, label) => {
        let text
        try {
          text = await readFile(path, 'utf8')
        } catch {
          return
        }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && results.length < limit; i += 1) {
          if (lines[i].toLowerCase().includes(needle)) results.push(`${label}:${i + 1}: ${lines[i].trim()}`)
        }
      }
      await scan(join(root, 'memory_summary.md'), 'memory_summary.md')
      let rolloutFiles = []
      try {
        rolloutFiles = await readdir(join(root, 'rollout_summaries'))
      } catch {
        rolloutFiles = []
      }
      for (const file of rolloutFiles) {
        if (results.length >= limit) break
        await scan(join(root, 'rollout_summaries', file), `rollout_summaries/${file}`)
      }
      return results
    },
  }

  ctx.effect(() => ctx.tools.register(searchTool), 'dsh-codex-memory.search')
  ctx.effect(() => ctx.tools.register(noteTool), 'dsh-codex-memory.note')

  const isRootAgentId = (agent) => {
    if (!agent?.id) return false
    if (String(agent.id).startsWith('memory-')) return false
    try {
      const roots = ctx.agents.roots?.()
      if (Array.isArray(roots) && roots.length > 0) return roots.some((root) => root?.id === agent.id)
    } catch {
      // fall back to the session shape
    }
    return agent?.session?.delegationDepth === undefined || agent?.session?.delegationDepth === 0
  }

  const findAgentForSession = (session) => {
    const id = session?.id
    if (id === undefined) return undefined
    for (const lookup of ['list', 'roots']) {
      try {
        const agents = ctx.agents[lookup]?.()
        if (!Array.isArray(agents)) continue
        const hit = agents.find((agent) => agent?.session?.id === id)
        if (hit) return hit
      } catch {
        // try the next accessor
      }
    }
    return undefined
  }

  ctx.on('agent/created', ({ agent }) => {
    if (!isRootAgentId(agent)) return
    // Read path only. The write pipeline starts after a turn completes: creating
    // a child agent inside the creation dispatch leaves its model request without
    // a settled turn context, and the provider transport rejects it.
    void injectMemory(agent).catch((error) =>
      log('warn', `memory injection failed: ${error?.message ?? error}`),
    )
  })

  // Codex runs this at root-session startup. DSH has no such hook, and creating
  // child agents inside the `agent/created` dispatch leaves their model requests
  // without a settled turn context, so the first live turn boundary starts it:
  // either the previous turn ending or a new user message arriving.
  const START_TRIGGERS = new Set(['turn/end', 'user/message'])
  const startedSessions = new Set()
  const maybeStartPipeline = (session, event) => {
    if (!START_TRIGGERS.has(event?.type)) return
    if (session?.id === undefined || startedSessions.has(session.id)) return
    const agent = findAgentForSession(session)
    if (!agent || !isRootAgentId(agent)) {
      void diag('skip-trigger', { trigger: event.type, session: session.id, found: agent !== undefined })
      return
    }
    startedSessions.add(session.id)
    void diag('trigger', { trigger: event.type, session: session.id, agent: agent.id })
    setTimeout(() => {
      void runStartupPipeline({ parentAgent: agent, currentThreadId: session.id })
    }, 0)
  }
  ctx.on('session/event', (session, event) => maybeStartPipeline(session, event), { global: true })
}
