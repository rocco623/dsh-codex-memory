// Prompt assembly, ported from codex-rs/memories/write/src/prompts.rs and
// codex-rs/ext/memories/src/prompts.rs. Every template is loaded verbatim from
// templates/ (byte-identical to the open-source Codex originals); this module
// only does placeholder substitution and the conditional blocks Codex builds in
// Rust.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates')

const cache = new Map()
const readTemplate = (relative) => {
  let text = cache.get(relative)
  if (text === undefined) {
    text = readFileSync(join(TEMPLATES, relative), 'utf8')
    cache.set(relative, text)
  }
  return text
}

// codex_utils_template::Template renders `{{ name }}` with surrounding
// whitespace allowed inside the braces.
const render = (template, values) =>
  template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  )

// prompt_blocks::EXTENSIONS_FOLDER_STRUCTURE / EXTENSIONS_PRIMARY_INPUTS, copied
// verbatim from write/src/lib.rs.
const EXTENSIONS_FOLDER_STRUCTURE = `
Memory extensions (under {{ memory_extensions_root }}/):

- <extension_name>/instructions.md
  - Source-specific guidance for interpreting additional memory signals. If an
    extension folder exists, you must read its instructions.md to determine how to use this memory
    source.

If the user has any memory extensions, you MUST read the instructions for each extension to
determine how to use the memory source. If the workspace diff shows deleted extension resource files,
remove stale memories derived only from those resources. If it has no extension folders, continue
with the standard memory inputs only.
`

const EXTENSIONS_PRIMARY_INPUTS = `
Optional source-specific inputs:
Under \`{{ memory_extensions_root }}/\`:

- \`<extension_name>/instructions.md\`
  - If extension folders exist, read each instructions.md first and follow it when interpreting
    that extension's memory source.

If the workspace diff shows deleted memory extension resources, use that extension-specific deletion
signal to remove stale memories derived only from those resources.
`

export const WORKSPACE_DIFF_FILENAME = 'phase2_workspace_diff.md'

/** Codex: stage_one_system_v2.md. */
export function stageOneSystemPrompt() {
  return readTemplate('memories/stage_one_system_v2.md')
}

/** Codex: build_stage_one_input_v2. */
export function buildStageOneInput({ rolloutPath, rolloutCwd, rolloutGitBranch, rolloutContents }) {
  const template = readTemplate('memories/stage_one_input_v2.md')
  return render(template, {
    rollout_path: rolloutPath,
    rollout_cwd: rolloutCwd,
    rollout_git_branch: rolloutGitBranch ?? 'unknown',
    rollout_contents: rolloutContents,
  })
}

/**
 * Codex: build_consolidation_prompt_for_version (v2). The extension blocks are
 * emitted only when the extensions root directory exists, and each block is
 * rendered with the extensions root path.
 */
export function buildConsolidationPrompt({ memoryRoot, memoryExtensionsRoot, extensionsExist }) {
  const template = readTemplate('memories/consolidation_v2.md')
  const folderStructure = extensionsExist
    ? render(EXTENSIONS_FOLDER_STRUCTURE, { memory_extensions_root: memoryExtensionsRoot })
    : ''
  const primaryInputs = extensionsExist
    ? render(EXTENSIONS_PRIMARY_INPUTS, { memory_extensions_root: memoryExtensionsRoot })
    : ''
  return `${render(template, {
    memory_root: memoryRoot,
    memory_extensions_folder_structure: folderStructure,
    memory_extensions_primary_inputs: primaryInputs,
    phase2_workspace_diff_file: WORKSPACE_DIFF_FILENAME,
  })}

## Tooling

The memory root is outside this session's writable sandbox, so \`write\` and \`edit\` cannot modify \`${memoryRoot}\`. Call \`memory_write_summary\` exactly once with the complete contents of \`memory_summary.md\` instead; the tool writes the file from the host process. Reading files and running shell commands under the memory root is allowed. End this turn with that call: do not spend the turn on analysis alone.
`
}

/**
 * Codex: build_memory_tool_developer_instructions. Returns null when there is
 * no memory summary to inject, matching read_path_v2.md's contract.
 */
export function buildReadPathInstructions({ basePath, memorySummary }) {
  const summary = memorySummary.trim()
  if (!summary) return null
  const template = readTemplate('memories/read_path_v2.md')
  return render(template, { base_path: basePath, memory_summary: summary })
}

/** Codex: extensions/ad_hoc/instructions.md, seeded onto disk at startup. */
export const AD_HOC_INSTRUCTIONS = readTemplate('extensions/ad_hoc/instructions.md')
