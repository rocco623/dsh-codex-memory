// Git-baseline workspace + artifact validation, ported from
// codex-rs/memories/write/src/workspace.rs. The git repo under the memory root
// lets phase 2 skip the consolidation call whenever nothing changed since the
// last commit.
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const WORKSPACE_DIFF_FILENAME = 'phase2_workspace_diff.md'
const MAX_DIFF_BYTES = 4 * 1024 * 1024

const git = (cwd, args) => run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })

export const gitignoreFor = () =>
  `${WORKSPACE_DIFF_FILENAME}\ndiagnostics.log\n*.db\n*.db-wal\n*.db-shm\n`

export async function prepareMemoryWorkspace(root) {
  await mkdir(root, { recursive: true })
  try {
    await run('git', ['rev-parse', '--git-dir'], { cwd: root })
    return
  } catch {
    // Codex re-initializes when the baseline repo is missing or unusable.
  }
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.email', 'dsh-memory@localhost'])
  await git(root, ['config', 'user.name', 'dsh-memory'])
  await writeFile(join(root, '.gitignore'), gitignoreFor())
  await git(root, ['add', '-A'])
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'baseline'])
}

/** Codex: memory_workspace_diff. */
export async function memoryWorkspaceDiff(root) {
  await git(root, ['add', '-A'])
  const { stdout } = await git(root, ['diff', '--cached', '--unified=1', 'HEAD'])
  return { unifiedDiff: stdout, hasChanges: () => stdout.trim().length > 0 }
}

/** Codex: write_workspace_diff — bounded, marked when truncated. */
export async function writeWorkspaceDiff(root, diff) {
  let body = diff.unifiedDiff
  if (Buffer.byteLength(body, 'utf8') > MAX_DIFF_BYTES) {
    body = `${body.slice(0, MAX_DIFF_BYTES)}\n\n[workspace diff truncated at ${MAX_DIFF_BYTES} bytes]\n`
  }
  await writeFile(join(root, WORKSPACE_DIFF_FILENAME), `## Diff\n\n\`\`\`diff\n${body}\`\`\`\n`)
}

/** Codex: reset_memory_workspace_baseline — the consolidation becomes the new baseline. */
export async function resetMemoryWorkspaceBaseline(root) {
  await rm(join(root, WORKSPACE_DIFF_FILENAME), { force: true })
  await git(root, ['add', '-A'])
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'consolidation'])
}

// The v2 summary's first line is literally `v1`: that is the summary FORMAT
// marker Codex validates, independent of which pipeline version wrote it.
const V2_REQUIRED_HEADINGS = [
  '## User Profile',
  '## User preferences',
  '## General Tips',
  "## What's in Memory",
]
const MAX_SUMMARY_BYTES = 10_000

/** Codex: is_valid_v2_summary. */
export function isValidV2Summary(summary) {
  const lines = summary.split('\n')
  return (
    lines[0] === 'v1' &&
    Buffer.byteLength(summary, 'utf8') < MAX_SUMMARY_BYTES &&
    V2_REQUIRED_HEADINGS.every((heading) => lines.some((line) => line.trim() === heading))
  )
}

/** Codex: remove_memory_symlinks — returns how many symlinks were removed. */
export async function removeMemorySymlinks(root) {
  let removed = 0
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        await rm(path, { force: true })
        removed += 1
      } else if (entry.isDirectory()) {
        // Never follow a symlinked directory into the walk.
        pending.push(path)
      }
    }
  }
  return removed
}

/**
 * Codex: validate_consolidation_artifacts_for_version (v2). Fails when the agent
 * introduced symlinks or when the summary does not satisfy the v2 shape.
 */
export async function validateConsolidationArtifacts(root) {
  const removedSymlinks = await removeMemorySymlinks(root)
  if (removedSymlinks !== 0) {
    throw new Error(`removed ${removedSymlinks} symbolic links from consolidated memory workspace`)
  }

  const summaryPath = join(root, 'memory_summary.md')
  let summary
  try {
    summary = await readFile(summaryPath, 'utf8')
  } catch (error) {
    throw new Error(`read memory summary artifact ${summaryPath}: ${error?.message ?? error}`)
  }
  if (summary.split('\n')[0] !== 'v1') {
    throw new Error(`memory summary artifact does not start with v1: ${summaryPath}`)
  }
  if (!isValidV2Summary(summary)) throw new Error('invalid v2 memory summary')
}
