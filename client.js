// Browser half of dsh-codex-memory: the settings page for this bundle.
//
// The host renders nothing for us: the Plugins page hands `plugins.bundle.config`
// to whichever bundle registered it, and the form is ours to build. The shape
// below copies @deepseek-ai/dsh-client-ui-settings-agent-loop, the shipped page
// that does the same thing over its own settings namespace.
window.__ModuleLoader__.load({
  id: "dsh-codex-memory",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives")

    /** The settings namespace is the loader entry id, which is also the package name. */
    const NS = "dsh-codex-memory"
    /** Dictionary namespace owned by this page. */
    const LOCALE_NS = "dsh-codex-memory.settings"

    const en = {
      summary: "Memory pipeline: extraction, consolidation, and the model both run on.",
      inherit: "Inherit the triggering session",
      model: "Model",
      modelHint: "Model for the child agents. Empty inherits the triggering session.",
      provider: "Provider",
      providerHint: "Provider for the child agents. Empty inherits the triggering session.",
      stage1ReasoningEffort: "Extraction reasoning",
      stage1ReasoningEffortHint: "off / low / high / max. Empty inherits the session; high tends to over-think this task.",
      stage2ReasoningEffort: "Consolidation reasoning",
      stage2ReasoningEffortHint: "off / low / high / max. DeepSeek has no medium; it maps medium to high.",
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
      agentTimeoutMsHint: "Hard limit for one child-agent run; 600000 is ten minutes.",
      overridden: "Overridden",
      reset: "Reset to default",
      invalidNumber: "Enter a number, or leave blank to use the default.",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
    }

    const zh = {
      summary: "记忆流水线：抽取、整合，以及两者使用的模型。",
      inherit: "继承触发会话",
      model: "模型",
      modelHint: "子 agent 使用的模型。留空则继承触发会话。",
      provider: "Provider",
      providerHint: "子 agent 使用的 provider。留空则继承触发会话。",
      stage1ReasoningEffort: "抽取思考强度",
      stage1ReasoningEffortHint: "off / low / high / max。留空继承会话；high 容易在这个任务上想过头。",
      stage2ReasoningEffort: "整合思考强度",
      stage2ReasoningEffortHint: "off / low / high / max。DeepSeek 没有 medium，会映射成 high。",
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
      agentTimeoutMsHint: "单个子 agent 的运行上限，600000 是十分钟。",
      overridden: "已覆盖",
      reset: "恢复默认",
      invalidNumber: "请填数字；留空表示使用默认值。",
      readOnly: "本部署的设置为只读。",
      unavailable: "该插件当前未加载，暂时无法配置。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
    }

    /** Fields the page edits, in display order. */
    const FIELDS = [
      { key: "model" },
      { key: "provider" },
      { key: "stage1ReasoningEffort" },
      { key: "stage2ReasoningEffort" },
      { key: "minRolloutIdleHours", numeric: true },
      { key: "maxRolloutAgeDays", numeric: true },
      { key: "maxRolloutsPerStartup", numeric: true },
      { key: "phase2SuccessCooldownSeconds", numeric: true },
      { key: "maxUnusedDays", numeric: true },
      { key: "concurrencyLimit", numeric: true },
      { key: "agentTimeoutMs", numeric: true },
    ]

    /** Staged form over this plugin's own settings namespace. */
    class CodexMemoryCardController {
      constructor(scope) {
        this.form = new primitives.SettingsFormModel(
          scope,
          FIELDS.map((field) =>
            field.numeric ? primitives.settingsNumberField(field.key) : primitives.settingsTextField(field.key),
          ),
        )
        this.store = this.form.bind(() => {
          const projection = { ...this.form.shell() }
          for (const field of FIELDS) projection[field.key] = this.form.field(field.key)
          return projection
        })
      }

      inject() {
        return { hooks: { codexMemoryCard: this.store }, ...this.form.actions() }
      }

      dispose() {
        this.form.dispose()
      }
    }

    function Card(props) {
      const { t } = props
      const state = props.useCodexMemoryCard((snapshot) => snapshot)
      const [catalog, setCatalog] = react.useState(null)
      react.useEffect(() => {
        let alive = true
        props
          .loadCatalog()
          .then((response) => {
            if (alive && response?.ok) setCatalog(response.value)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      if (props.view === "summary") return t("summary")
      const labels = {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving"),
      }
      const groups = catalog?.groups ?? []
      const providers = groups.map((group) => group.id)
      const models = groups.find((group) => group.id === state.provider?.value)?.models ?? []
      const selectStyle = {
        font: "inherit",
        color: "inherit",
        background: "transparent",
        border: "1px solid currentColor",
        borderRadius: "6px",
        padding: "4px 6px",
        width: "100%",
      }
      const row = (key, label, hint, control) =>
        react.createElement(
          "div",
          { key, style: { display: "flex", flexDirection: "column", gap: "4px", margin: "8px 0" } },
          react.createElement("label", { style: { fontWeight: 600 } }, label),
          control,
          react.createElement("span", { style: { opacity: 0.7, fontSize: "0.85em" } }, hint),
        )
      const children = [
        row(
          "provider",
          t("provider"),
          t("providerHint"),
          react.createElement(
            "select",
            {
              style: selectStyle,
              value: state.provider?.value ?? "",
              disabled: !state.writable,
              onChange: (event) => props.edit("provider", event.target.value),
            },
            [
              react.createElement("option", { key: "", value: "" }, t("inherit")),
              ...providers.map((id) => react.createElement("option", { key: id, value: id }, id)),
            ],
          ),
        ),
        row(
          "model",
          t("model"),
          t("modelHint"),
          react.createElement(
            "select",
            {
              style: selectStyle,
              value: state.model?.value ?? "",
              disabled: !state.writable || models.length === 0,
              onChange: (event) => props.edit("model", event.target.value),
            },
            [
              react.createElement("option", { key: "", value: "" }, t("inherit")),
              ...models.map((model) => react.createElement("option", { key: model.id, value: model.id }, model.id)),
            ],
          ),
        ),
        ...FIELDS.filter((field) => field.key !== "model" && field.key !== "provider").map((field) =>
          react.createElement(primitives.SettingsValueField, {
            key: field.key,
            id: `plugin-config-codex-memory-${field.key}`,
            label: t(field.key),
            hint: t(`${field.key}Hint`),
            overriddenLabel: t("overridden"),
            resetLabel: t("reset"),
            invalidLabel: t("invalidNumber"),
            numeric: field.numeric === true,
            disabled: !state.writable,
            ...state[field.key],
            onEdit: (text) => props.edit(field.key, text),
            onReset: () => props.resetField(field.key),
          }),
        ),
      ]
      return react.createElement(
        primitives.SettingsForm,
        { labels, state, onSave: props.save, onDiscard: props.discard },
        children,
      )
    }

    const inject = ["slots", "locale", "configForms", "remote", "remote.session"]

    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-codex-memory: dictionaries")
      const card = new CodexMemoryCardController(ctx.configForms.get(NS))
      ctx.effect(() => () => card.dispose(), "dsh-codex-memory: form subscription")
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject("plugins.bundle.config", () =>
              ctx.slots.register(
                {
                  name: "plugins.bundle.config",
                  key: NS,
                  locale: LOCALE_NS,
                  inject: () => ({ ...card.inject(), loadCatalog: () => ctx.remote.session.modelCatalog() }),
                },
                Card,
              ),
            ),
          ),
        "dsh-codex-memory: settings page",
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
