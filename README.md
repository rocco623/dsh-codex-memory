# dsh-codex-memory

Codex 记忆系统（`codex-rs/memories`）的 **V2 流水线**移植：两阶段、SQLite job 表 + 租约/重试、git baseline diff 门控、读路径 citation 回流。

## 架构对照

| Codex | 这里 | 位置 |
|---|---|---|
| `jobs` / `stage1_outputs` 表（lease、retry、watermark） | 同结构 SQLite（`node:sqlite`） | [db.js](db.js) |
| `start_memories_startup_task`：layout → seed → prune → phase1 → phase2 | 同顺序 | [index.js](index.js) `runStartupPipeline` |
| `phase1::run`：并发 8、每个 rollout 一次抽取 | 同；每个子 agent 用 `setup()` 拿**自己作用域**的写工具 | [index.js](index.js) `runPhase1` |
| `phase1_output::StageOneOutput::parse`：脱敏 + V2 截断 9000 字节 + `raw_memory` 留空 | 同 | [redact.js](redact.js) / [index.js](index.js) |
| `phase2::run`：全局锁 → git baseline → sync → diff → 校验 → agent → commit | 同（无变化且有旧产物时不调模型） | [index.js](index.js) `runPhase2` |
| `storage.rs`：`rollout_summary_file_stem`、文件头字段、rollout 保留 | 逐函数移植 | [storage.js](storage.js) |
| `workspace.rs`：`is_valid_v2_summary`、符号链接清理、产物校验 | 同 | [workspace.js](workspace.js) |
| `extensions/`：seed instructions、14 天资源保留 | 同 | [storage.js](storage.js) |
| `read/src/citations.rs` + `record_stage1_output_usage` | citation 解析 → `usage_count`/`last_usage` | [citations.js](citations.js) |
| V2 的 4 个 prompt + read path | **原文文件随插件分发，逐字节相同** | `templates/` |
| 常量（idle 6h、age 10d、per-startup 2、max_raw 256、max_unused 30d、lease 3600s、retry 3、冷却 6h、心跳 90s） | 同名同值 | [index.js](index.js) `DEFAULTS` |

prompt 不是重写的：`templates/` 下 5 个文件与 Codex 开源仓库 sha256 相同，`prompts.js` 只做 `{{ }}` 替换。

## 与 Codex 仍不同的地方

| 差异 | 原因 |
|---|---|
| **只实现 V2** | Codex 另有 V1 流水线（产出 `MEMORY.md` + `raw_memories.md`，且仍是它当前的配置默认）。这里按需求只保留 V2，因此没有 `version` 开关 |
| 不检查 rate limit | `guard.rs` 调 ChatGPT 后端专属接口，DSH 无等价 API |
| 整合 agent 用 `tools.restrict()` 限权，不是内核沙箱 | Cordis 的 `create()` 没有 sandbox profile 参数；Codex 用 `SandboxPolicy::WorkspaceWrite` |
| stage-1 证据 = 每轮 user 原文 + 该轮最后一条 assistant 回复 | 未移植 `rollout_input.rs` 的分层 + token 预算重放 |
| 抽取用作用域工具收 JSON，不是 `output_schema` 结构化输出 | DSH 没暴露结构化输出原语 |
| 只实现 ad_hoc 一种记忆扩展 | Codex 的扩展机制是插件式的 |
| 无 `threads` 表 / `memory_mode` | DSH 没有线程注册表；改为配置级 `generateMemories` 开关 + 从会话日志探测 web/MCP 外部上下文 |
| 无 `git_branch` 字段 | DSH 会话日志不记录 git 分支（Codex 在值为 `None` 时同样省略该行） |
| 无 `clear_memory_data` / 状态查询接口 | 只做流水线，不做控制面 |

## 文件

```
index.js        启动流水线、两阶段、读路径、citation 回流、用户工具
db.js           SQLite jobs/stage1_outputs（node:sqlite）
storage.js      rollout_summaries/ 与扩展目录的磁盘形态、保留策略
workspace.js    git baseline、diff、产物校验
sessions.js     读 ~/.dsh/sessions，渲染 stage-1 证据
prompts.js      templates/ 的渲染（只做占位符替换）
redact.js       redact_secrets 移植
citations.js    <oai-mem-citation> 解析
templates/      Codex V2 原文 prompt（逐字节相同）
selftest.mjs    端到端：真 SQLite + 真 git + 符合真实契约的 mock ctx
verify-prompts.mjs  prompt 保真校验
check.mjs       只读检查真实会话解析
```

运行期数据：`~/.dsh/memory_state.db`（job/输出表，同 Codex 单一 state DB）、`~/.dsh/memories_v2/`（`MemoryVersion::V2.directory_name()`）。

## 已知运行约束

- **会话日志是多帧 zstd。** DSH 每次追加写都会加一个新的 zstd 帧，而桌面运行时（Node 24.21）的 `zstdDecompress*` **只解第一帧**——一个 122KB 的会话日志只解出 217 字节，只剩 `session` 头一行，导致抽取被判成"无内容"。`zstd.js` 按 RFC 8878 逐帧切分后分别解压，已验证与 Node 24.22 的输出逐字节一致。

- **整合子 agent 不能直接 `write` 记忆目录。** 子 agent 继承父会话的 workspace 沙箱，而 memory root（`~/.dsh/memories_v2`）在 workspace 外，`write` 会被沙箱拒绝并转入升级审批；没人批就一直等到 `agentTimeoutMs`（10 分钟）超时。所以整合 prompt 明确要求调用 `memory_write_summary`，由宿主侧工具写文件，读取和 shell 检查仍然允许。
- **两个子 agent 的结果必须由工具交付。** Codex 用 `output_schema` 收结构化输出，DSH 没有等价原语，这里换成 `memory_stage1_write_output` / `memory_write_summary` 两个工具。模板原文仍写「返回一个 JSON 对象」，模型会照字面把 JSON 打印成文本，插件拿不到——所以两个 prompt 末尾各有一段 `## Output delivery` 明确要求调用工具。`selftest.mjs` 的 mock 一定会调工具，覆盖不到这个失败。
- **流水线在首个活跃轮次边界启动，不是会话创建时。** Codex 有 `start_memories_startup_task`，DSH 没有等价钩子；而 `agent/created` 派发过程中创建的子 agent 拿不到稳定的 turn 上下文，模型请求会失败。所以改为监听 `session/event` 的 `turn/end` 或 `user/message`（每会话每次进程只触发一次）。
- **子 agent 必须按 `dsh-subagent` 的方式创建。** 只传 `provider`/`model` 不够：`create()` 还要求 `meta`（`cwd`、`agentPreset`、`parentSession`、`isSeeded`、`origin`、`delegationDepth`）和完整的 `agentOptions`（含 `maxTokens`、`subagentDepth`）；并且**必须在 `setup` 里调用 `agentPresets.composeFrom(childCtx, parent.ctx)`**——注意：即使 `meta.agentPreset` 已经带了继承来的 preset，也要调（`dsh-subagent` 只在请求显式指定 preset 时才跳过）。漏掉这一步的后果是子 agent 的系统提示词只有正常值的一半、工具集残缺，模型请求照样以 TRANSPORT 失败。缺任何一项，请求头看起来和正常 agent 一模一样，但模型请求会在传输层失败（`DeepSeek Messages transport failed`）。`resolveChildPlan()` 逐字段对照 `dsh-subagent` 的 `resolveChildAgentOptions` / `childSessionMeta` 实现。
- 子 agent 的 `reasoningEffort` 必须显式传：不传时适配器会填自己的默认值，和父会话不一致时同样会请求失败。取自父 agent 的实际请求头（`session.requestHeader().config`），流水线在 `agent/created` 时启动、请求头可能尚未生成，因此最多等 8 秒。
- 子 agent 的工作目录由宿主决定（`create()` 不接受 `cwd`），Codex 则会把它设成 memory root。提示词里全部用绝对路径，所以读产物不依赖 cwd。

## 诊断

`memory_summary.md` 同级会写一个 `diagnostics.log`（JSONL，已 gitignore），记录每次流水线的关键判定和子 agent 失败的**完整 cause 链**。原因：turn 里只保留 `{message, code}`，适配器包在 `LlmError.cause` 里的真实错误（例如 `ENOTFOUND` / `ECONNRESET`）只有从 `agent/request-error` 事件里才拿得到。关掉它设 `diagnostics: false`。

## 安装与配置

```sh
# 从 GitHub
dsh plugin --profile web add github:rocco623/dsh-codex-memory
# 发布到 npm 之后
dsh plugin --profile web add dsh-codex-memory
```

依赖 `node:sqlite`（Node 22.5+ 内置）和系统 `git`。桌面端在 **设置 → 插件** 里装；那个 profile 归应用管，命令行改不了运行中的它。

配置写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-codex-memory
  config:
    generateMemories: true
    useMemories: true
    disableOnExternalContext: true
    maxRolloutsPerStartup: 2
    minRolloutIdleHours: 6
    concurrencyLimit: 8
    diagnostics: true
    model: ''            # 留空 = 继承触发会话的模型
    provider: ''         # 留空 = 继承触发会话的 provider
    stage1ReasoningEffort: ''   # Codex 用 low
    stage2ReasoningEffort: ''   # Codex 用 medium
```

## 验证

```bash
node verify-prompts.mjs   # prompt 逐字节/占位符校验
node check.mjs            # 只读：真实 24 个会话，21 个有对话
node selftest.mjs         # 端到端：抽取 → 并发 → 脱敏 → 整合 → commit → citation → 读路径 → 冷却 → 保留策略
```

`selftest.mjs` 的 mock 遵守真实契约（`create()` 是 async；作用域工具经 `setup` 注册）。**仍未验证**：在真实 DSH 运行时里用真模型跑通一次完整流水线（本会话没有安装/调模型工具），以及多窗口并发开新会话时的 SQLite WAL 行为。
