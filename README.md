# dsh-codex-memory

Codex V2 记忆流水线的 DSH 适配实现，参考版本固定为 [c260087efe8cc6dcc0526e7018ae9e0e3fc134e3](https://github.com/openai/codex/tree/c260087efe8cc6dcc0526e7018ae9e0e3fc134e3)。只实现 V2，不提供 V1 或双写。

要求 **DSH 0.2.1-rc.3、Node 24.21+ 和系统 Git**。当前实现待整体 Code Review；未验证安装后 GUI 或真实模型端到端运行，不承诺所有输入上的逐字节等价。

## 流水线

1. 从宿主逻辑会话目录和持久来源核对身份、格式、版本、模式与归档状态。来源不明确时暂停整合，不推断删除。
2. 按更新时间、空闲时间和持久模式选择来源；排除当前触发会话、归档来源及非交互子代理。普通 fork 独立处理。
3. 将已接纳的用户、全部可见助手消息、工具调用/结果等映射为 canonical 证据；缺失助手 phase 按 Final。过滤、脱敏、分层预算和 UTF-8 截断均在模型请求前执行。附件只使用宿主格式化的元数据，不读取附件内容。
4. 用 SQLite 所有权令牌和来源版本校验，原子发布抽取结果、成功水位和整合作业。空结果删除旧输出；保留成功水位，防止未变化的来源被重复抽取。
5. 全局整合作业同步来源文件、计算 Git diff；无变化且摘要有效时跳过推理。模型只能调用七个根内私有文件工具，无 shell、网络、PTC 或委派。超窗时按固定文本/函数调用压缩流程恢复，不重放已执行写入。
6. 正常结束、产物校验和所有权检查通过后，更新无父提交的 Git baseline，清除历史对象，再提交选择标记与进度。读取时通过 system-prompt section 提供记忆，不向会话追加伪造的用户消息。

主要实现：[入口](./index.js)、[流水线](./pipeline.js)、[来源目录](./sources.js)、[事务](./db.js)、[证据读取](./sessions.js)、[预算](./rollout-input.js)、[模型驱动](./model.js)、[根内后端](./memory-backend.js)、[Git 工作区](./workspace.js)。

## 设置

启用客户端插件后，在 **设置 → 记忆** 配置两个阶段各自的 Provider、模型和思考强度。

- 每阶段 route 的两个字段同时填写或同时留空；留空使用旧共用 route，仍为空时继承触发会话的实际 route。
- `codex`：抽取 Low、整合 Medium。目标模型不支持时阻止该阶段，不映射成其他强度。
- `inherit-parent`：继承触发会话实际强度；`provider-default`：交由宿主使用 provider 默认值。
- 已持久化的 Low 等值保留并标为旧配置；旧空字符串仍表示继承，不重写为 Codex 默认。
- 能力来自宿主元数据，不硬编码 provider 的强度列表。保存显式 route 前检查能力；没有触发 route 的继承配置在运行时解析。配置热更新不替换已开始作业的模型配置。

示例：

```yaml
config:
  generateMemories: true
  useMemories: true
  dedicatedTools: false
  disableOnExternalContext: false
  stage1Provider: ''
  stage1Model: ''
  stage2Provider: ''
  stage2Model: ''
  stage1ReasoningEffort: codex
  stage2ReasoningEffort: provider-default
  agentTimeoutMs: 0
```

`generateMemories` 决定新会话的初始模式，不倒改已有来源。既有来源在设置页启用或停用；归档只影响抽取资格，不自动移除已生成记忆。开启外部上下文策略时，将其固化到新来源，之后观察 Web/MCP 事件并标为 polluted。历史未记录的 opt-out 和外部策略不能恢复；删除状态数据库也会丢失这些来源事实。

`useMemories` 控制摘要读取；普通会话的专用工具还要求 `dedicatedTools: true`。工具包括 `memory_list/read/search/add_ad_hoc_note`，以及兼容 `memory_note` 和 `memory_search({query})`。数值约束由后端验证；公开 schema 使用宿主支持的子集。

默认抽取空闲 6 小时、最大更新时间年龄 10 天、每轮最多领取 2 个来源、并发 8；整合上限 256 个来源，未使用保留 30 天，成功冷却 6 小时。默认无自设模型超时或轮数上限；已有显式超时配置仍生效。

## 存储与控制

数据根为 `DSH_HOME`，未设置时使用用户目录下的 `.dsh`：

```text
memory_state.db                 作业、输出、来源模式、引用防重放元数据
memories_v2/                    摘要、来源摘要、笔记与 Git baseline
memory_diagnostics.log          新诊断，位于记忆根外
memory_diagnostics.legacy-*.log  保留的历史诊断归档
```

首次流水线会把根内普通文件 `diagnostics.log` 原子搬至数据根的唯一归档文件，避免作为记忆输入；不跟随符号链接。新诊断不记录请求正文、模型输出或原始错误消息，只保存事件、定位字段和错误码链。

设置页提供状态、来源模式和清空 V2 操作。清空要求显式确认；存在未过期作业租约时返回 busy，不清数据库或文件。文件清理失败会保留 reset-pending，阻止新作业，供后续重试。成功清空保留原始会话、来源模式及引用防重放事实，不主动重抽历史。已注入现有会话的文本不在清理范围内。

控制端点位于 `/dsh-codex-memory`：`config`、`capabilities`、`status`、`threads`、`thread-mode`、`reset`。修改请求要求 JSON；带 Origin 的请求必须同源。访问控制由宿主 Web Server 承担，错误响应不回传内部错误原文。

## 验证

在源码目录运行：

```sh
npm test
npm run check
npm run verify:prompts
npm pack --dry-run
```

[selftest.mjs](./selftest.mjs) 只发现合成测试，不扫描真实 HOME 或原始会话。macOS 若存在目标桌面程序，会以 `ELECTRON_RUN_AS_NODE=1` 运行其纯 SDK/codec 测试，不启动 GUI；可用 `DSH_TEST_RUNTIME` 指定执行程序。普通 Node 环境缺少桌面模块时，目标宿主测试会明确 skip，不能据此声称宿主适配已验证。

七份模板的固定 SHA-256 已独立核对上游 Git blob；[模板验证器](./verify-prompts.mjs) 不以当前副本作为唯一预期值。测试覆盖真实临时 SQLite、合成 Git 仓库、所有权/重置、证据预算、多帧 zstd、模型流组装、压缩恢复、公开工具和控制端点；不会调用真实模型。

尚未覆盖：安装后的浏览器交互、真实 provider 请求、系统级多进程压力及大型记忆目录性能。本机无 Rust oracle runner；Git CLI Myers 与上游 similar 在全部歧义重复行上的 diff 字节一致性未证明。宿主没有 ChatGPT 专属 rate-limit 接口，不能执行该检查。
