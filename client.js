// Browser half of dsh-codex-memory: the settings section under Settings.
//
// Nothing here goes through the host's form primitives: the Plugins page owns no
// form renderer, and its `SettingsFormModel` is not a public API. This page talks
// to /dsh-codex-memory/config, which the Host half serves, and renders its own
// fields.
window.__ModuleLoader__.load({
  id: "dsh-codex-memory",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const h = react.createElement

    /** Dictionary namespace owned by this page. */
    const NS = "dsh-codex-memory.settings"
    /** Where the Host half answers reads and writes for this plugin's config. */
    const ROUTE = "/dsh-codex-memory/config"

    const en = {
      nav: "Memory",
      title: "Memory",
      description: "How the memory pipeline extracts, consolidates, and which model it uses.",
      model: "Model",
      modelHint: "Model for the background agents. Empty inherits the triggering session.",
      provider: "Provider",
      providerHint: "Provider for the background agents. Empty inherits the triggering session.",
      stage1ReasoningEffort: "Extraction reasoning",
      stage1ReasoningEffortHint: "high tends to over-think this task.",
      stage2ReasoningEffort: "Consolidation reasoning",
      stage2ReasoningEffortHint: "DeepSeek maps medium to high, so only low and high differ.",
      inherit: "Inherit the session",
      minRolloutIdleHours: "Idle hours before extraction",
      minRolloutIdleHoursHint: "A session must be quiet this long before it is summarized.",
      maxRolloutAgeDays: "Maximum rollout age (days)",
      maxRolloutAgeDaysHint: "Sessions older than this are never summarized.",
      maxRolloutsPerStartup: "Sessions per run",
      maxRolloutsPerStartupHint: "Upper bound on sessions extracted in one triggered run.",
      phase2SuccessCooldownSeconds: "Consolidation cooldown (seconds)",
      phase2SuccessCooldownSecondsHint: "Minimum gap between two successful consolidations.",
      maxUnusedDays: "Unused memory expiry (days)",
      maxUnusedDaysHint: "Memory entries unreferenced this long are pruned.",
      concurrencyLimit: "Extraction concurrency",
      concurrencyLimitHint: "How many sessions are extracted in parallel.",
      agentTimeoutMs: "Agent timeout (ms)",
      agentTimeoutMsHint: "Hard limit for one background run; 600000 is ten minutes.",
      generateMemories: "Write memories",
      generateMemoriesHint: "Off stops extraction entirely.",
      useMemories: "Inject memories",
      useMemoriesHint: "Off stops injecting the summary into new sessions.",
      disableOnExternalContext: "Skip sessions that used web or MCP",
      disableOnExternalContextHint: "Keeps fetched external text out of memory.",
      diagnostics: "Write diagnostics.log",
      diagnosticsHint: "Records each run's decisions and failure chains.",
      save: "Save",
      saving: "Saving…",
      saved: "Saved.",
      failed: "Not saved: ",
      loading: "Loading…",
    }

    const zh = {
      nav: "记忆",
      title: "记忆",
      description: "记忆流水线如何抽取、整合，以及使用哪个模型。",
      model: "模型",
      modelHint: "后台 agent 使用的模型。留空则继承触发会话。",
      provider: "Provider",
      providerHint: "后台 agent 使用的 provider。留空则继承触发会话。",
      stage1ReasoningEffort: "抽取思考强度",
      stage1ReasoningEffortHint: "high 容易在这个任务上想过头。",
      stage2ReasoningEffort: "整合思考强度",
      stage2ReasoningEffortHint: "DeepSeek 把 medium 映射成 high，所以只有 low 和 high 有区别。",
      inherit: "继承触发会话",
      minRolloutIdleHours: "抽取前空闲小时数",
      minRolloutIdleHoursHint: "会话安静这么久之后才会被总结。",
      maxRolloutAgeDays: "会话最长保留天数",
      maxRolloutAgeDaysHint: "超过这个天数的会话不再总结。",
      maxRolloutsPerStartup: "每次抽取的会话数",
      maxRolloutsPerStartupHint: "一次触发最多抽取几个会话。",
      phase2SuccessCooldownSeconds: "整合冷却（秒）",
      phase2SuccessCooldownSecondsHint: "两次成功整合之间的最小间隔。",
      maxUnusedDays: "未引用记忆过期天数",
      maxUnusedDaysHint: "记忆条目这么久没被引用就会被淘汰。",
      concurrencyLimit: "抽取并发数",
      concurrencyLimitHint: "同时抽取几个会话。",
      agentTimeoutMs: "子 agent 超时（毫秒）",
      agentTimeoutMsHint: "单次后台运行的上限，600000 是十分钟。",
      generateMemories: "写入记忆",
      generateMemoriesHint: "关闭后完全停止抽取。",
      useMemories: "注入记忆",
      useMemoriesHint: "关闭后不再把摘要注入新会话。",
      disableOnExternalContext: "跳过用过 web 或 MCP 的会话",
      disableOnExternalContextHint: "避免把抓来的外部文本写进记忆。",
      diagnostics: "写 diagnostics.log",
      diagnosticsHint: "记录每次运行的判定和失败原因链。",
      save: "保存",
      saving: "保存中…",
      saved: "已保存。",
      failed: "未保存：",
      loading: "加载中…",
    }

    const EFFORTS = ["", "off", "low", "high", "max"]

    const FIELDS = [
      { key: "provider", select: "providers" },
      { key: "model", select: "models" },
      { key: "stage1ReasoningEffort", options: EFFORTS },
      { key: "stage2ReasoningEffort", options: EFFORTS },
      { key: "minRolloutIdleHours", numeric: true },
      { key: "maxRolloutAgeDays", numeric: true },
      { key: "maxRolloutsPerStartup", numeric: true },
      { key: "phase2SuccessCooldownSeconds", numeric: true },
      { key: "maxUnusedDays", numeric: true },
      { key: "concurrencyLimit", numeric: true },
      { key: "agentTimeoutMs", numeric: true },
      { key: "generateMemories", boolean: true },
      { key: "useMemories", boolean: true },
      { key: "disableOnExternalContext", boolean: true },
      { key: "diagnostics", boolean: true },
    ]

    const inputStyle = {
      font: "inherit",
      color: "inherit",
      background: "transparent",
      border: "1px solid currentColor",
      borderRadius: "8px",
      padding: "6px 8px",
      minWidth: "240px",
    }

    function Field(props) {
      const { field, value, options, disabled, onChange, t } = props
      let control
      if (field.boolean) {
        control = h('input', {
          type: 'checkbox',
          checked: value === true,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        })
      } else if (field.select || field.options) {
        const list = field.options ?? options ?? []
        control = h(
          'select',
          { style: inputStyle, value: value ?? '', disabled, onChange: (event) => onChange(event.target.value) },
          [
            ...(field.options ? [] : [h('option', { key: '__inherit', value: '' }, t('inherit'))]),
            ...list.map((option) => {
              const value = option.value ?? option
              const label = option.label ?? (value === '' ? t('inherit') : value)
              return h('option', { key: value, value }, label)
            }),
          ],
        )
      } else {
        control = h('input', {
          type: field.numeric ? 'number' : 'text',
          style: inputStyle,
          value: value ?? '',
          disabled,
          onChange: (event) => onChange(event.target.value),
        })
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 0' } },
        h('label', { style: { fontWeight: 600 } }, t(field.key)),
        control,
        h('span', { style: { opacity: 0.65, fontSize: '0.85em' } }, t(`${field.key}Hint`)),
      )
    }

    function Section(props) {
      const { t } = props
      const [status, setStatus] = react.useState('loading')
      const [values, setValues] = react.useState({})
      const [catalog, setCatalog] = react.useState(null)
      const [message, setMessage] = react.useState(null)

      react.useEffect(() => {
        let alive = true
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((body) => {
            if (!alive || !body?.ok) return
            setValues(body.values ?? {})
            setStatus('ready')
          })
          .catch((error) => alive && setMessage(`${t('failed')}${error.message}`))
        props
          .loadCatalog()
          .then((response) => alive && response?.ok && setCatalog(response.value))
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      const set = (key, value) => {
        setValues((previous) => ({ ...previous, [key]: value }))
        setMessage(null)
      }

      const groups = catalog?.groups ?? []
      const providerOptions = groups.map((group) => ({ value: group.id, label: group.id }))
      const modelOptions =
        groups
          .find((group) => group.id === values.provider)
          ?.models.map((model) => ({ value: model.id, label: model.id })) ?? []

      const save = async () => {
        setStatus('saving')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values }),
          })
          const body = await response.json()
          if (!body?.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setValues(body.values ?? values)
          setMessage(t('saved'))
        } catch (error) {
          setMessage(`${t('failed')}${error.message}`)
        } finally {
          setStatus('ready')
        }
      }

      if (status === 'loading') return h('p', null, t('loading'))

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '560px' } },
        h('h3', { style: { margin: '0 0 4px' } }, t('title')),
        h('p', { style: { margin: '0 0 12px', opacity: 0.7 } }, t('description')),
        ...FIELDS.map((field) =>
          h(Field, {
            key: field.key,
            field,
            value: values[field.key],
            options: field.select === 'providers' ? providerOptions : field.select === 'models' ? modelOptions : undefined,
            disabled: status === 'saving',
            onChange: (value) => set(field.key, value),
            t,
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '12px' } },
          h(
            'button',
            {
              type: 'button',
              disabled: status === 'saving',
              style: { font: 'inherit', padding: '6px 16px', borderRadius: '8px', cursor: 'pointer' },
              onClick: save,
            },
            status === 'saving' ? t('saving') : t('save'),
          ),
          message === null ? null : h('span', { style: { opacity: 0.75 } }, message),
        ),
      )
    }

    const inject = ["slots", "locale", "remote", "remote.session"]

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-codex-memory: dictionaries")
      ctx.slots.inject("settings.section", function* () {
        yield ctx.slots.register(
          {
            name: "settings.section",
            id: "codex-memory",
            order: 35,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ t, loadCatalog: () => ctx.remote.session.modelCatalog() }),
          },
          Section,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
