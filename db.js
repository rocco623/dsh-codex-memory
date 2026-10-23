// SQLite job/state layer, schema ported from Codex's
// state/memory_migrations/0001_memories.sql (jobs + stage1_outputs tables).
// Uses node:sqlite (built into Node 22.5+/24.x, no dependency).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
    ON stage1_outputs(source_updated_at DESC, thread_id DESC);

CREATE TABLE IF NOT EXISTS jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease
    ON jobs(kind, status, retry_at, lease_until);
`

export const JOB_KIND_STAGE1 = 'memory_stage1'
export const JOB_KIND_PHASE2 = 'memory_consolidation'
export const PHASE2_JOB_KEY = 'global'

export function openMemoryStore(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return new MemoryStore(db)
}

const now = () => Math.floor(Date.now() / 1000)

class MemoryStore {
  constructor(db) {
    this.db = db
  }

  close() {
    this.db.close()
  }

  // ---- stage 1 ----------------------------------------------------------

  // Codex: stage1_source_needs_update — a row needs (re)extraction when it is
  // missing or its stored source_updated_at is older than the live session.
  stage1NeedsUpdate(threadId, sourceUpdatedAt) {
    const row = this.db
      .prepare('SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?')
      .get(threadId)
    return !row || row.source_updated_at < sourceUpdatedAt
  }

  /**
   * Codex: try_claim_stage1_job. A row is claimable when no live lease is held,
   * the retry window has elapsed (or the source advanced), and a retry budget
   * remains (or the source advanced). `maxRunningJobs` mirrors the SQL-level cap
   * Codex enforces across processes; it is max_rollouts_per_startup there too.
   */
  tryClaimStage1Job(threadId, workerId, sourceUpdatedAt, leaseSeconds, maxRunningJobs) {
    const t = now()
    const running = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND status = 'running' AND lease_until IS NOT NULL AND lease_until > ?",
      )
      .get(JOB_KIND_STAGE1, t).n
    if (running >= maxRunningJobs) return null

    const existing = this.db
      .prepare(
        'SELECT status, lease_until, retry_at, retry_remaining, input_watermark FROM jobs WHERE kind = ? AND job_key = ?',
      )
      .get(JOB_KIND_STAGE1, threadId)

    const prevWatermark = existing?.input_watermark ?? -1
    const advanced = sourceUpdatedAt > prevWatermark

    if (existing) {
      const leaseFree =
        existing.status !== 'running' || existing.lease_until == null || existing.lease_until <= t
      const retryFree = existing.retry_at == null || existing.retry_at <= t || advanced
      const budgetLeft = (existing.retry_remaining ?? 0) > 0 || advanced
      if (!leaseFree || !retryFree || !budgetLeft) return null
    }

    const token = `${threadId}:${t}:${Math.random().toString(36).slice(2)}`
    const retryRemaining = advanced ? 3 : (existing?.retry_remaining ?? 3)
    this.db
      .prepare(
        `INSERT INTO jobs (kind, job_key, status, worker_id, ownership_token, started_at, finished_at, lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark)
         VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL)
         ON CONFLICT(kind, job_key) DO UPDATE SET
           status='running', worker_id=excluded.worker_id, ownership_token=excluded.ownership_token,
           started_at=excluded.started_at, finished_at=NULL, lease_until=excluded.lease_until,
           retry_at=NULL, retry_remaining=excluded.retry_remaining, last_error=NULL,
           input_watermark=excluded.input_watermark`,
      )
      .run(JOB_KIND_STAGE1, threadId, workerId, token, t, t + leaseSeconds, retryRemaining, sourceUpdatedAt)
    return token
  }

  /** Codex: mark_stage1_job_succeeded — terminal 'done', lease released. */
  stage1JobSucceeded(threadId, token) {
    return this.#finishStage1(threadId, token)
  }

  /**
   * Codex: mark_stage1_job_succeeded_no_output — closes the job and drops any
   * previously stored row, because the latest extraction produced nothing.
   */
  stage1JobSucceededNoOutput(threadId, token) {
    const closed = this.#finishStage1(threadId, token)
    if (closed) this.db.prepare('DELETE FROM stage1_outputs WHERE thread_id = ?').run(threadId)
    return closed
  }

  #finishStage1(threadId, token) {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status='done', finished_at = ?, lease_until = NULL, last_error = NULL,
           last_success_watermark = input_watermark
         WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      )
      .run(now(), JOB_KIND_STAGE1, threadId, token)
    return result.changes > 0
  }

  /** Codex: mark_stage1_job_failed — terminal 'error' with backoff and budget. */
  stage1JobFailed(threadId, token, reason, retryDelaySeconds) {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status='error', finished_at = ?, lease_until = NULL, retry_at = ?,
           retry_remaining = retry_remaining - 1, last_error = ?
         WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      )
      .run(now(), now() + retryDelaySeconds, reason, JOB_KIND_STAGE1, threadId, token)
    return result.changes > 0
  }

  upsertStage1Output({ threadId, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug }) {
    const t = now()
    this.db
      .prepare(
        `INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           source_updated_at=excluded.source_updated_at, raw_memory=excluded.raw_memory,
           rollout_summary=excluded.rollout_summary, rollout_slug=excluded.rollout_slug, generated_at=excluded.generated_at`,
      )
      .run(threadId, sourceUpdatedAt, rawMemory ?? null, rolloutSummary, rolloutSlug ?? null, t)
  }

  // Prune rows unused for max_unused_days, never selected ones excluded (mirrors retention SQL).
  pruneStage1Outputs(maxUnusedDays, limit) {
    const cutoff = now() - maxUnusedDays * 86400
    const result = this.db
      .prepare(
        `DELETE FROM stage1_outputs WHERE thread_id IN (
           SELECT thread_id FROM stage1_outputs
           WHERE selected_for_phase2 = 0 AND COALESCE(last_usage, source_updated_at) < ?
           ORDER BY COALESCE(last_usage, source_updated_at) ASC, source_updated_at ASC, thread_id ASC
           LIMIT ?
         )`,
      )
      .run(cutoff, limit)
    return result.changes
  }

  // ---- phase 2 ------------------------------------------------------------

  /**
   * Codex: record_stage1_output_usage. Each cited thread id increments
   * usage_count and sets last_usage; missing rows are ignored. This is what
   * keeps the "recently useful" ranking in get_phase2_input_selection honest.
   */
  recordStage1OutputUsage(threadIds) {
    if (threadIds.length === 0) return 0
    const t = now()
    const stmt = this.db.prepare(
      'UPDATE stage1_outputs SET usage_count = COALESCE(usage_count, 0) + 1, last_usage = ? WHERE thread_id = ?',
    )
    let updated = 0
    for (const threadId of threadIds) updated += stmt.run(t, threadId).changes
    return updated
  }

  // Codex: get_phase2_input_selection — eligible rows ranked by usage, top N, returned thread_id ASC.
  getPhase2InputSelection(maxRawMemories, maxUnusedDays) {
    const cutoff = now() - maxUnusedDays * 86400
    const rows = this.db
      .prepare(
        `SELECT thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at, usage_count, last_usage
         FROM stage1_outputs
         WHERE (length(trim(coalesce(raw_memory, ''))) > 0 OR length(trim(rollout_summary)) > 0)
           AND COALESCE(last_usage, source_updated_at) >= ?
         ORDER BY COALESCE(usage_count, 0) DESC, COALESCE(last_usage, source_updated_at) DESC, source_updated_at DESC, thread_id DESC
         LIMIT ?`,
      )
      .all(cutoff, maxRawMemories)
    rows.sort((a, b) => (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0))
    return rows
  }

  /**
   * Codex: mark_global_phase2_job_succeeded — clear every selection flag, then
   * pin the flags on exactly the rows that were consolidated (matching on
   * thread_id AND source_updated_at so a newer row is not falsely pinned).
   */
  markSelectedForPhase2(selectedOutputs) {
    this.db
      .prepare(
        'UPDATE stage1_outputs SET selected_for_phase2 = 0, selected_for_phase2_source_updated_at = NULL WHERE selected_for_phase2 != 0 OR selected_for_phase2_source_updated_at IS NOT NULL',
      )
      .run()
    const stmt = this.db.prepare(
      'UPDATE stage1_outputs SET selected_for_phase2 = 1, selected_for_phase2_source_updated_at = ? WHERE thread_id = ? AND source_updated_at = ?',
    )
    for (const output of selectedOutputs) {
      stmt.run(output.source_updated_at, output.thread_id, output.source_updated_at)
    }
  }

  /**
   * Codex: try_claim_global_phase2_job. Skip order matches upstream: retry
   * window, then a live lease, then the success cooldown — the cooldown applies
   * only when the previous run left no error.
   */
  tryClaimGlobalPhase2Job(workerId, leaseSeconds, cooldownSeconds) {
    const t = now()
    const existing = this.db
      .prepare(
        'SELECT status, lease_until, retry_at, finished_at, last_error, input_watermark FROM jobs WHERE kind = ? AND job_key = ?',
      )
      .get(JOB_KIND_PHASE2, PHASE2_JOB_KEY)

    if (existing) {
      if (existing.retry_at != null && existing.retry_at > t) return { outcome: 'skipped_retry_unavailable' }
      if (existing.status === 'running' && existing.lease_until != null && existing.lease_until > t) {
        return { outcome: 'skipped_running' }
      }
      const cooldownCutoff = t - cooldownSeconds
      if (existing.last_error == null && existing.finished_at != null && existing.finished_at > cooldownCutoff) {
        return { outcome: 'skipped_cooldown' }
      }
    }

    const token = `${PHASE2_JOB_KEY}:${t}:${Math.random().toString(36).slice(2)}`
    const watermark = existing?.input_watermark ?? 0
    this.db
      .prepare(
        `INSERT INTO jobs (kind, job_key, status, worker_id, ownership_token, started_at, finished_at, lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark)
         VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, 3, NULL, ?, 0)
         ON CONFLICT(kind, job_key) DO UPDATE SET
           status='running', worker_id=excluded.worker_id, ownership_token=excluded.ownership_token,
           started_at=excluded.started_at, finished_at=NULL, lease_until=excluded.lease_until,
           retry_at=NULL, last_error=NULL`,
      )
      .run(JOB_KIND_PHASE2, PHASE2_JOB_KEY, workerId, token, t, t + leaseSeconds, watermark)
    return { outcome: 'claimed', token, watermark }
  }

  heartbeatGlobalPhase2Job(token, leaseSeconds) {
    const t = now()
    const result = this.db
      .prepare(
        "UPDATE jobs SET lease_until = ? WHERE kind = ? AND job_key = ? AND ownership_token = ? AND status = 'running'",
      )
      .run(t + leaseSeconds, JOB_KIND_PHASE2, PHASE2_JOB_KEY, token)
    return result.changes > 0
  }

  /** Codex: mark_global_phase2_job_succeeded — terminal 'done', error cleared. */
  phase2JobSucceeded(token, newWatermark, selectedOutputs) {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status='done', finished_at = ?, lease_until = NULL, last_error = NULL,
           last_success_watermark = MAX(COALESCE(last_success_watermark, 0), ?)
         WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      )
      .run(now(), newWatermark, JOB_KIND_PHASE2, PHASE2_JOB_KEY, token)
    if (result.changes === 0) return false
    this.markSelectedForPhase2(selectedOutputs)
    return true
  }

  /** Codex: mark_global_phase2_job_failed — terminal 'error' with backoff. */
  phase2JobFailed(token, reason, retryDelaySeconds) {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status='error', finished_at = ?, lease_until = NULL, retry_at = ?,
           retry_remaining = retry_remaining - 1, last_error = ?
         WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?`,
      )
      .run(now(), now() + retryDelaySeconds, reason, JOB_KIND_PHASE2, PHASE2_JOB_KEY, token)
    return result.changes > 0
  }
}
