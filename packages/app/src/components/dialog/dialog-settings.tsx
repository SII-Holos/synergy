import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput, type SendShortcut } from "@/context/input"
import { useGlobalSync } from "@/context/global-sync"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { Config, ConfigSetSummary } from "@ericsanchezok/synergy-sdk/client"
import { DialogConfirm } from "./dialog-confirm"
import "./dialog-settings.css"

type ProviderModel = {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
}

type ModelKey =
  | "model"
  | "nano_model"
  | "mini_model"
  | "mid_model"
  | "vision_model"
  | "thinking_model"
  | "long_context_model"
  | "creative_model"
  | "holos_friend_reply_model"

const MODEL_ROLES: Array<{ key: ModelKey; label: string; description: string }> = [
  { key: "model", label: "Default Model", description: "Primary model for conversations and agent tasks" },
  { key: "nano_model", label: "Nano Model", description: "Cheapest model for trivial tasks like title generation" },
  {
    key: "mini_model",
    label: "Mini Model",
    description: "Intent detection, script extraction, reward evaluation, and genesis bootstrapping",
  },
  {
    key: "mid_model",
    label: "Mid Model",
    description: "Explore, scout, and quick-category task routing",
  },
  { key: "vision_model", label: "Vision Model", description: "Image, PDF, and file analysis" },
  {
    key: "holos_friend_reply_model",
    label: "Holos Friend Reply Model",
    description: "Used for Holos automatic friend replies. Falls back to the default model.",
  },
  { key: "thinking_model", label: "Thinking Model", description: "Complex reasoning and architecture decisions" },
  {
    key: "long_context_model",
    label: "Long Context Model",
    description: "Session compaction, long document analysis",
  },
  { key: "creative_model", label: "Creative Model", description: "Writing, design, and artistry" },
]

type PluginEntry = {
  value: string
}

type McpEntry = {
  key: string
  type: "local" | "remote"
  enabled: boolean
  command: string
  url: string
  timeout: string
  environment: string
  headers: string
}

type EmailSettings = {
  enabled: boolean
  fromAddress: string
  fromName: string
  smtpHost: string
  smtpPort: string
  smtpSecure: boolean
  smtpUsername: string
  smtpPassword: string
}

type AccountToggle = {
  key: string
  enabled: boolean
}

type ChannelSettings = {
  feishuAccounts: AccountToggle[]
}

function emptyMcp(): McpEntry {
  return { key: "", type: "local", enabled: true, command: "", url: "", timeout: "", environment: "", headers: "" }
}

type RawValidationState = {
  valid: boolean
  errors: string[]
  warnings: string[]
}

type SettingsEditMode = "form" | "raw"

type DialogSettingsProps = {
  initialTab?: string
}

export function DialogSettings(props: DialogSettingsProps) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const input = useInput()

  const [activeTab, setActiveTab] = createSignal(props.initialTab ?? "general")
  const [selectedSetName, setSelectedSetName] = createSignal<string>()
  const [initialized, setInitialized] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [creatingSet, setCreatingSet] = createSignal(false)
  const [createSetName, setCreateSetName] = createSignal("")
  const [editMode, setEditMode] = createSignal<SettingsEditMode>("form")
  const [rawText, setRawText] = createSignal("")
  const [rawLoadedForSet, setRawLoadedForSet] = createSignal<string>()
  const [validatingRaw, setValidatingRaw] = createSignal(false)
  const [rawValidation, setRawValidation] = createStore<RawValidationState>({
    valid: true,
    errors: [],
    warnings: [],
  })

  const activeSet = createMemo(() => globalSync.configSets.find((set) => set.active))
  const selectedSet = createMemo<ConfigSetSummary | undefined>(() => {
    const requested = selectedSetName()
    if (requested) return globalSync.configSets.find((set) => set.name === requested)
    return activeSet()
  })
  const selectedSetIsActive = createMemo(() => selectedSet()?.name === activeSet()?.name)

  const [config, { refetch: refetchConfig }] = createResource(
    () => ({ name: selectedSet()?.name, activeName: activeSet()?.name }),
    async (source) => {
      if (!source.name) throw new Error("No Config Set selected")
      if (source.name === source.activeName) {
        const res = await globalSDK.client.config.global()
        return res.data!
      }
      const res = await globalSDK.client.config.set.get({ name: source.name })
      return res.data!.config as Config
    },
  )

  const providerModels = createMemo(() => {
    const data = globalSync.data.provider
    const list: ProviderModel[] = []
    for (const provider of data.all) {
      if (!data.connected.includes(provider.id)) continue
      for (const [modelId, model] of Object.entries(provider.models)) {
        list.push({
          providerId: provider.id,
          providerName: provider.name,
          modelId,
          modelName: model.name,
        })
      }
    }
    return list
  })

  const [rawConfig, { refetch: refetchRawConfig }] = createResource(
    () => selectedSet()?.name,
    async (name) => {
      if (!name) throw new Error("No Config Set selected")
      const response = await fetch(`${globalSDK.url}/config/sets/${encodeURIComponent(name)}/raw`)
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data?.message ?? data?.error ?? `Failed to load raw config for ${name}`)
      }
      return data as {
        name: string
        path: string
        raw: string
        active: boolean
        isDefault: boolean
        config?: Config
      }
    },
  )

  let originalMcps: Record<string, Record<string, unknown>> = {}
  let initializedForSet: string | undefined

  const [general, setGeneral] = createStore({
    snapshot: true,
    autoupdate: "" as string,
    sendShortcut: "enter" as SendShortcut,
  })

  const [models, setModels] = createStore({
    model: "" as string,
    nano_model: "" as string,
    mini_model: "" as string,
    mid_model: "" as string,
    vision_model: "" as string,
    holos_friend_reply_model: "" as string,
    thinking_model: "" as string,
    long_context_model: "" as string,
    creative_model: "" as string,
  })

  const [plugins, setPlugins] = createStore({
    entries: [] as PluginEntry[],
  })

  const [mcps, setMcps] = createStore({
    entries: [] as McpEntry[],
  })

  const [identity, setIdentity] = createStore({
    evolution: "" as string,
    autonomy: "" as string,
  })

  const [advanced, setAdvanced] = createStore({
    compaction_auto: "" as string,
    compaction_overflow_threshold: "" as string,
    permission: "" as string,
    question_timeout: "" as string,
  })

  const [email, setEmail] = createStore<EmailSettings>({
    enabled: true,
    fromAddress: "",
    fromName: "",
    smtpHost: "",
    smtpPort: "",
    smtpSecure: true,
    smtpUsername: "",
    smtpPassword: "",
  })

  const [channels, setChannels] = createStore<ChannelSettings>({
    feishuAccounts: [],
  })

  const ensureInit = () => {
    const cfg = config()
    const setName = selectedSet()?.name
    if (!cfg || !setName) return
    if (initialized() && initializedForSet === setName) return

    setGeneral({
      snapshot: cfg.snapshot ?? true,
      autoupdate: cfg.autoupdate === undefined ? "" : String(cfg.autoupdate),
      sendShortcut: input.sendShortcut(),
    })

    setModels({
      model: cfg.model ?? "",
      nano_model: cfg.nano_model ?? "",
      mini_model: cfg.mini_model ?? "",
      mid_model: cfg.mid_model ?? "",
      vision_model: cfg.vision_model ?? "",
      holos_friend_reply_model: cfg.holos_friend_reply_model ?? "",
      thinking_model: cfg.thinking_model ?? "",
      long_context_model: cfg.long_context_model ?? "",
      creative_model: cfg.creative_model ?? "",
    })

    setPlugins({
      entries: (cfg.plugin ?? []).map((v) => ({ value: v })),
    })

    originalMcps = {}
    if (cfg.mcp) {
      for (const [key, m] of Object.entries(cfg.mcp)) {
        originalMcps[key] = { ...(m as Record<string, unknown>) }
      }
    }
    setMcps({
      entries: cfg.mcp
        ? Object.entries(cfg.mcp).map(([key, m]) => {
            const mcp = m as Record<string, unknown>
            const isLocal = mcp.type === "local"
            const env = mcp.environment as Record<string, string> | undefined
            const hdrs = mcp.headers as Record<string, string> | undefined
            return {
              key,
              type: (isLocal ? "local" : "remote") as "local" | "remote",
              enabled: mcp.enabled !== false,
              command: isLocal && Array.isArray(mcp.command) ? (mcp.command as string[]).join(" ") : "",
              url: !isLocal && typeof mcp.url === "string" ? mcp.url : "",
              timeout: mcp.timeout !== undefined ? String(mcp.timeout) : "",
              environment: env
                ? Object.entries(env)
                    .map(([k, v]) => `${k}=${v}`)
                    .join("\n")
                : "",
              headers: hdrs
                ? Object.entries(hdrs)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")
                : "",
            }
          })
        : [],
    })

    setAdvanced({
      compaction_auto: cfg.compaction?.auto === undefined ? "" : cfg.compaction.auto ? "true" : "false",
      compaction_overflow_threshold:
        cfg.compaction?.overflowThreshold === undefined ? "" : String(cfg.compaction.overflowThreshold),
      permission: (() => {
        const permission = cfg.permission
        if (!permission) return ""
        if (typeof permission === "string") return permission
        return ""
      })(),
      question_timeout: cfg.question?.timeout === undefined ? "" : String(cfg.question.timeout),
    })

    setEmail({
      enabled: cfg.email?.enabled ?? true,
      fromAddress: cfg.email?.from?.address ?? "",
      fromName: cfg.email?.from?.name ?? "",
      smtpHost: cfg.email?.smtp?.host ?? "",
      smtpPort: cfg.email?.smtp?.port === undefined ? "" : String(cfg.email.smtp.port),
      smtpSecure: cfg.email?.smtp?.secure ?? true,
      smtpUsername: cfg.email?.smtp?.username ?? "",
      smtpPassword: cfg.email?.smtp?.password ?? "",
    })

    const feishuAccounts = cfg.channel?.feishu?.accounts
    setChannels({
      feishuAccounts: feishuAccounts
        ? Object.entries(feishuAccounts).map(([key, account]) => ({
            key,
            enabled: account.enabled !== false,
          }))
        : [],
    })

    const ident = cfg.identity
    setIdentity({
      evolution: (() => {
        const evolution = ident?.evolution
        if (evolution === undefined) return ""
        if (typeof evolution === "boolean") return evolution ? "true" : "false"
        const passive = evolution.passive
        const active = evolution.active
        if (passive === false && active === false) return "false"
        return "true"
      })(),
      autonomy: ident?.autonomy === undefined ? "" : ident.autonomy ? "true" : "false",
    })

    initializedForSet = setName
    setInitialized(true)
  }

  const ready = () => initialized()

  createEffect(() => {
    config()
    selectedSet()?.name
    ensureInit()
  })

  createEffect(() => {
    const active = activeSet()?.name
    const selected = selectedSet()?.name
    if (!active || !selected) return
    if (selected === active && initializedForSet !== active) {
      resetEditor()
    }
  })

  function resetEditor() {
    setInitialized(false)
    initializedForSet = undefined
    setRawLoadedForSet(undefined)
    setRawValidation({ valid: true, errors: [], warnings: [] })
  }

  async function refreshAfterConfigChange() {
    resetEditor()
    await globalSync.refreshAllConfigs()
    await Promise.all([refetchConfig(), refetchRawConfig()])
    ensureInit()
  }

  function buildPatch() {
    const cfg = config()!
    const patch: Record<string, unknown> = {}

    if (general.snapshot !== (cfg.snapshot ?? true)) patch.snapshot = general.snapshot

    const autoupdateOrig = cfg.autoupdate === undefined ? "" : String(cfg.autoupdate)
    if (general.autoupdate !== autoupdateOrig) {
      if (general.autoupdate === "") patch.autoupdate = undefined
      else if (general.autoupdate === "true") patch.autoupdate = true
      else if (general.autoupdate === "false") patch.autoupdate = false
      else if (general.autoupdate === "notify") patch.autoupdate = "notify"
    }

    for (const role of MODEL_ROLES) {
      const origVal = (cfg[role.key as keyof typeof cfg] as string | undefined) ?? ""
      const newVal = models[role.key]
      if (newVal !== origVal) {
        patch[role.key] = newVal || undefined
      }
    }

    const origPlugin = JSON.stringify(cfg.plugin ?? [])
    const newPlugin = plugins.entries.map((entry) => entry.value).filter((value) => value.trim())
    if (JSON.stringify(newPlugin) !== origPlugin) {
      patch.plugin = newPlugin
    }

    const origMcp = JSON.stringify(cfg.mcp ?? {})
    const newMcpObj: Record<string, Record<string, unknown>> = {}
    for (const entry of mcps.entries) {
      if (!entry.key.trim()) continue
      const key = entry.key.trim()
      const base = { ...(originalMcps[key] ?? {}) }

      base.type = entry.type
      base.enabled = entry.enabled

      if (entry.type === "local") {
        const parts = entry.command.trim().split(/\s+/)
        if (parts.length > 0 && parts[0]) base.command = parts
        else delete base.command
        delete base.url
      } else {
        if (entry.url.trim()) base.url = entry.url.trim()
        else delete base.url
        delete base.command
      }

      if (entry.timeout) {
        const timeout = Number(entry.timeout)
        if (!isNaN(timeout) && timeout > 0) base.timeout = timeout
      } else {
        delete base.timeout
      }

      if (entry.type === "local" && entry.environment.trim()) {
        const env: Record<string, string> = {}
        for (const line of entry.environment.split("\n")) {
          const eq = line.indexOf("=")
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
        if (Object.keys(env).length) base.environment = env
        else delete base.environment
      } else if (entry.type === "local") {
        delete base.environment
      }

      if (entry.type === "remote" && entry.headers.trim()) {
        const hdrs: Record<string, string> = {}
        for (const line of entry.headers.split("\n")) {
          const colon = line.indexOf(":")
          if (colon > 0) hdrs[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
        }
        if (Object.keys(hdrs).length) base.headers = hdrs
        else delete base.headers
      } else if (entry.type === "remote") {
        delete base.headers
      }

      newMcpObj[key] = base
    }
    if (JSON.stringify(newMcpObj) !== origMcp) {
      patch.mcp = newMcpObj
    }

    const origCompaction = cfg.compaction
    const origAutoStr = origCompaction?.auto === undefined ? "" : origCompaction.auto ? "true" : "false"
    const origThresholdStr =
      origCompaction?.overflowThreshold === undefined ? "" : String(origCompaction.overflowThreshold)
    const compactionChanged =
      advanced.compaction_auto !== origAutoStr || advanced.compaction_overflow_threshold !== origThresholdStr
    if (compactionChanged) {
      const newCompaction: Record<string, unknown> = {}
      if (advanced.compaction_auto === "true") newCompaction.auto = true
      else if (advanced.compaction_auto === "false") newCompaction.auto = false
      if (advanced.compaction_overflow_threshold !== "") {
        const val = Number(advanced.compaction_overflow_threshold)
        if (!isNaN(val) && val >= 0.5 && val <= 1) newCompaction.overflowThreshold = val
      }
      patch.compaction = Object.keys(newCompaction).length > 0 ? newCompaction : undefined
    }

    const origPermission = (() => {
      const permission = cfg.permission
      if (!permission) return ""
      if (typeof permission === "string") return permission
      return ""
    })()
    if (advanced.permission !== origPermission) {
      patch.permission = advanced.permission || undefined
    }

    const origQuestionTimeout = cfg.question?.timeout === undefined ? "" : String(cfg.question.timeout)
    if (advanced.question_timeout !== origQuestionTimeout) {
      if (advanced.question_timeout === "") {
        patch.question = undefined
      } else {
        patch.question = { timeout: Number(advanced.question_timeout) }
      }
    }

    const origEmail = JSON.stringify(cfg.email ?? {})
    const hasEmailFrom = email.fromAddress.trim() || email.fromName.trim()
    const hasEmailSmtp =
      email.smtpHost.trim() ||
      email.smtpPort.trim() ||
      email.smtpUsername.trim() ||
      email.smtpPassword.trim() ||
      email.smtpSecure !== true
    const shouldMaterializeEmail = hasEmailFrom || hasEmailSmtp || email.enabled !== true || cfg.email !== undefined
    const newEmail: Record<string, unknown> = {}
    if (shouldMaterializeEmail) {
      if (email.enabled !== true || cfg.email?.enabled !== undefined) {
        newEmail.enabled = email.enabled
      }
      if (hasEmailFrom) {
        newEmail.from = {
          ...(email.fromAddress.trim() ? { address: email.fromAddress.trim() } : {}),
          ...(email.fromName.trim() ? { name: email.fromName.trim() } : {}),
        }
      }
      if (hasEmailSmtp) {
        newEmail.smtp = {
          ...(email.smtpHost.trim() ? { host: email.smtpHost.trim() } : {}),
          ...(email.smtpPort.trim() ? { port: Number(email.smtpPort) } : {}),
          secure: email.smtpSecure,
          ...(email.smtpUsername.trim() ? { username: email.smtpUsername.trim() } : {}),
          ...(email.smtpPassword.trim() ? { password: email.smtpPassword.trim() } : {}),
        }
      }
    }
    if (JSON.stringify(newEmail) !== origEmail) {
      patch.email = Object.keys(newEmail).length > 0 ? newEmail : undefined
    }

    const origChannel = JSON.stringify(cfg.channel ?? {})
    const newChannel = structuredClone(cfg.channel ?? {}) as NonNullable<Config["channel"]> | {}
    if ("feishu" in newChannel && newChannel.feishu?.accounts) {
      for (const entry of channels.feishuAccounts) {
        const account = newChannel.feishu.accounts[entry.key]
        if (account) account.enabled = entry.enabled
      }
    }
    if (JSON.stringify(newChannel) !== origChannel) {
      patch.channel = newChannel
    }

    const origIdent = cfg.identity
    const origEvoStr = (() => {
      const evolution = origIdent?.evolution
      if (evolution === undefined) return ""
      if (typeof evolution === "boolean") return evolution ? "true" : "false"
      const passive = evolution.passive
      const active = evolution.active
      if (passive === false && active === false) return "false"
      return "true"
    })()
    const origAutonomyStr = origIdent?.autonomy === undefined ? "" : origIdent.autonomy ? "true" : "false"
    if (identity.evolution !== origEvoStr || identity.autonomy !== origAutonomyStr) {
      const newIdent: Record<string, unknown> = {}
      if (origIdent?.embedding) newIdent.embedding = origIdent.embedding
      if (origIdent?.rerank) newIdent.rerank = origIdent.rerank

      const evoVal = identity.evolution !== origEvoStr ? identity.evolution : origEvoStr
      if (evoVal === "true") newIdent.evolution = true
      else if (evoVal === "false") newIdent.evolution = false

      const autoVal = identity.autonomy !== origAutonomyStr ? identity.autonomy : origAutonomyStr
      if (autoVal === "true") newIdent.autonomy = true
      else if (autoVal === "false") newIdent.autonomy = false

      patch.identity = Object.keys(newIdent).length > 0 ? newIdent : undefined
    }

    return patch
  }

  async function saveServerPatch(patch: Record<string, unknown>) {
    const setName = selectedSet()?.name
    if (!setName) return

    if (selectedSetIsActive()) {
      await globalSDK.client.config.update({ config: patch as any })
      return
    }

    await globalSDK.client.config.set.update({ name: setName, config: patch as Config })
  }

  const serverPatch = createMemo<Record<string, unknown>>(() => {
    if (!initialized() || !config() || !selectedSet()?.name) return {}
    return buildPatch()
  })
  const hasServerChanges = createMemo(() => Object.keys(serverPatch()).length > 0)
  const editingLabel = createMemo(() => selectedSet()?.name ?? activeSet()?.name ?? "default")

  const hasRawChanges = createMemo(() => {
    const rc = rawConfig()
    if (!rc) return false
    return rawLoadedForSet() === selectedSet()?.name && rawText() !== rc.raw
  })

  const hasAnyChanges = createMemo(() => {
    if (editMode() === "raw") return hasRawChanges()
    return hasServerChanges()
  })

  createEffect(() => {
    const rc = rawConfig()
    const setName = selectedSet()?.name
    if (!rc || !setName || rawLoadedForSet() === setName) return
    setRawText(rc.raw)
    setRawLoadedForSet(setName)
    setRawValidation({ valid: true, errors: [], warnings: [] })
  })

  async function validateRawConfig() {
    const setName = selectedSet()?.name
    if (!setName) return
    setValidatingRaw(true)
    try {
      const response = await fetch(`${globalSDK.url}/config/sets/${encodeURIComponent(setName)}/raw/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawText() }),
      })
      const data = await response.json()
      setRawValidation({
        valid: data.valid,
        errors: data.errors ?? [],
        warnings: data.warnings ?? [],
      })
      return data.valid as boolean
    } catch (error: any) {
      setRawValidation({ valid: false, errors: [error.message], warnings: [] })
      return false
    } finally {
      setValidatingRaw(false)
    }
  }

  async function saveRawConfig(options?: { activate?: boolean; close?: boolean }) {
    const setName = selectedSet()?.name
    if (!setName) return

    const valid = await validateRawConfig()
    if (!valid) {
      showToast({ title: "Validation failed", description: "Fix the errors before saving." })
      return
    }

    setSaving(true)
    try {
      const shouldActivate = options?.activate === true && !selectedSetIsActive()
      const response = await fetch(`${globalSDK.url}/config/sets/${encodeURIComponent(setName)}/raw`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawText(), reload: true }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data?.message ?? data?.data?.message ?? "Failed to save")
      }

      if (shouldActivate) {
        await globalSDK.client.config.set.activate({ name: setName })
      }

      await refreshAfterConfigChange()
      showToast({
        title: shouldActivate ? `Saved and activated ${setName}` : `Saved ${setName}`,
        description: "Raw config saved and validated.",
      })

      if (options?.close) dialog.close()
    } catch (error: any) {
      showToast({ title: "Failed to save", description: error.message })
    } finally {
      setSaving(false)
    }
  }

  function switchToEditMode(mode: SettingsEditMode) {
    if (mode === editMode()) return
    const guard = mode === "raw" ? hasServerChanges() : hasRawChanges()
    if (guard) {
      const fromLabel = editMode() === "raw" ? "raw editor" : "form"
      const toLabel = mode === "raw" ? "raw editor" : "form"
      dialog.show(() => (
        <DialogConfirm
          title="Discard unsaved changes?"
          description={`Switching from ${fromLabel} to ${toLabel} will discard your unsaved changes.`}
          confirmLabel="Discard"
          cancelLabel="Keep Editing"
          confirmVariant="secondary"
          onConfirm={() => {
            if (mode === "raw") {
              resetEditor()
            }
            setEditMode(mode)
          }}
        />
      ))
      return
    }
    setEditMode(mode)
  }

  function handleLocalSendShortcut(value: SendShortcut) {
    setGeneral("sendShortcut", value)
    if (value !== input.sendShortcut()) {
      input.setSendShortcut(value)
      showToast({ title: "Send shortcut updated", description: "This device preference is saved immediately." })
    }
  }

  async function saveServerChanges(options?: { activate?: boolean; close?: boolean }) {
    const patch = serverPatch()
    const shouldActivate = options?.activate === true && !selectedSetIsActive()

    if (Object.keys(patch).length === 0 && !shouldActivate) {
      if (options?.close) dialog.close()
      return
    }

    setSaving(true)
    try {
      const changed: string[] = []

      if (Object.keys(patch).length > 0) {
        await saveServerPatch(patch)
        changed.push(...Object.keys(patch))
      }

      if (shouldActivate) {
        await globalSDK.client.config.set.activate({ name: editingLabel() })
        changed.push("active config set")
      }

      if (Object.keys(patch).length > 0 || shouldActivate) {
        await refreshAfterConfigChange()
      }

      if (changed.length > 0) {
        showToast({
          title: shouldActivate ? `Saved and activated ${editingLabel()}` : `Saved ${editingLabel()}`,
          description: `Changed: ${changed.join(", ")}`,
        })
      }

      if (options?.close) dialog.close()
    } catch (error: any) {
      showToast({ title: "Failed to save", description: error.message })
    } finally {
      setSaving(false)
    }
  }

  function runDiscardGuard(action: string, onConfirm: () => void | Promise<void>) {
    if (!hasAnyChanges()) {
      void onConfirm()
      return
    }

    dialog.show(() => (
      <DialogConfirm
        title="Discard unsaved changes?"
        description={`You have unsaved changes for ${editingLabel()}. Discard them and ${action}?`}
        confirmLabel="Discard"
        cancelLabel="Keep Editing"
        confirmVariant="secondary"
        onConfirm={onConfirm}
      />
    ))
  }

  function closeWithGuard() {
    runDiscardGuard("close Settings", () => dialog.close())
  }

  async function handleSwitchSet(name: string) {
    if (name === activeSet()?.name) {
      setSelectedSetName(name)
      return
    }

    if (hasAnyChanges()) {
      runDiscardGuard(`activate ${name}`, async () => {
        setSaving(true)
        try {
          setSelectedSetName(name)
          resetEditor()
          await globalSDK.client.config.set.activate({ name })
          await refreshAfterConfigChange()
          showToast({ title: "Config Set activated", description: `Using ${name}` })
        } catch (error: any) {
          showToast({ title: "Failed to switch Config Set", description: error.message })
        } finally {
          setSaving(false)
        }
      })
      return
    }

    setSaving(true)
    try {
      setSelectedSetName(name)
      resetEditor()
      await globalSDK.client.config.set.activate({ name })
      await refreshAfterConfigChange()
      showToast({ title: "Config Set activated", description: `Using ${name}` })
    } catch (error: any) {
      showToast({ title: "Failed to switch Config Set", description: error.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateSet() {
    const name = createSetName().trim()
    if (!name) {
      showToast({ title: "Config Set name required" })
      return
    }

    setCreatingSet(true)
    try {
      await globalSDK.client.config.set.create({ configSetCreateInput: { name } })
      setCreateSetName("")
      await globalSync.loadConfigSets()
      setSelectedSetName(name)
      setActiveTab("general")
      resetEditor()
      showToast({
        title: `Now editing ${name}`,
        description: `${name} starts as a copy of ${activeSet()?.name ?? "the active set"}. Review the tabs and save any changes you want to keep.`,
      })
    } catch (error: any) {
      showToast({ title: "Failed to create Config Set", description: error.message })
    } finally {
      setCreatingSet(false)
    }
  }

  async function handleDeleteSet(name: string) {
    if (name === activeSet()?.name) {
      showToast({ title: "Cannot delete active Config Set" })
      return
    }

    setSaving(true)
    try {
      await globalSDK.client.config.set.delete({ name })
      await globalSync.loadConfigSets()
      if (selectedSet()?.name === name) setSelectedSetName(activeSet()?.name)
      showToast({ title: "Config Set deleted", description: name })
    } catch (error: any) {
      showToast({ title: "Failed to delete Config Set", description: error.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Settings" class="dialog-settings-wide">
      {ready() ? (
        <div class="flex flex-col gap-0 h-full">
          <div class="ds-tabs-bar">
            <Show when={editMode() === "form"}>
              <Tabs value={activeTab()} onChange={setActiveTab} variant="pill" class="ds-tabs-root">
                <Tabs.List>
                  <Tabs.Trigger value="general">General</Tabs.Trigger>
                  <Tabs.Trigger value="models">Models</Tabs.Trigger>
                  <Tabs.Trigger value="mcp">MCP</Tabs.Trigger>
                  <Tabs.Trigger value="plugins">Plugins</Tabs.Trigger>
                  <Tabs.Trigger value="advanced">Advanced</Tabs.Trigger>
                  <Tabs.Trigger value="config-sets">Config Sets</Tabs.Trigger>
                </Tabs.List>
              </Tabs>
            </Show>
            <Show when={editMode() === "raw"}>
              <div class="flex items-center gap-2 px-2 py-1">
                <Icon name="code" size="normal" class="text-text-weak" />
                <span class="text-13-medium text-text-base">Editing raw JSONC</span>
                <Show when={rawConfig()?.path}>
                  <span class="text-12-regular text-text-weaker truncate max-w-[240px]">{rawConfig()!.path}</span>
                </Show>
              </div>
            </Show>
            <div class="ml-auto flex items-center gap-1 pl-3">
              <button
                type="button"
                class="ds-mode-toggle"
                classList={{ "ds-mode-toggle-active": editMode() === "raw" }}
                onClick={() => switchToEditMode(editMode() === "raw" ? "form" : "raw")}
                title={editMode() === "raw" ? "Switch to form editor" : "Edit raw JSON config"}
              >
                <Icon name={editMode() === "raw" ? "settings" : "code"} size="small" />
                <span>{editMode() === "raw" ? "Form" : "JSON"}</span>
              </button>
            </div>
          </div>

          <div class="ds-content">
            <Show when={editMode() === "form"}>
              <div class="ds-context-bar">
                <div class="ds-context-pill">
                  <span class="ds-context-label">Active</span>
                  <span class="ds-context-value">{activeSet()?.name ?? "default"}</span>
                </div>
                <div class="ds-context-pill">
                  <span class="ds-context-label">Editing</span>
                  <span class="ds-context-value">{selectedSet()?.name ?? activeSet()?.name ?? "default"}</span>
                  <Show when={!selectedSetIsActive()}>
                    <span class="ds-inline-badge ds-inline-badge-muted">Inactive</span>
                  </Show>
                  <Show when={hasServerChanges()}>
                    <span class="ds-inline-badge ds-inline-badge-dirty">Unsaved</span>
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={editMode() === "form" && activeTab() === "general"}>
              <div class="ds-section ds-section-enter">
                <div class="ds-panel-card">
                  <div class="ds-panel-card-header">
                    <div>
                      <span class="text-13-medium text-text-base">Server-backed settings</span>
                      <p class="text-12-regular text-text-weak mt-0.5">
                        These settings are saved to the Config Set shown in the Editing context above.
                      </p>
                    </div>
                  </div>
                  <SettingRow
                    title="Snapshot"
                    description="Save file snapshots for undo/redo"
                    trailing={<Switch checked={general.snapshot} onChange={(value) => setGeneral("snapshot", value)} />}
                  />
                  <SettingRow
                    title="Auto Update"
                    description="How updates are handled"
                    trailing={
                      <SegmentPill
                        value={general.autoupdate}
                        options={[
                          { value: "", label: "Default" },
                          { value: "true", label: "On" },
                          { value: "false", label: "Off" },
                          { value: "notify", label: "Notify" },
                        ]}
                        onChange={(value) => setGeneral("autoupdate", value)}
                      />
                    }
                  />
                </div>

                <div class="ds-panel-card">
                  <div class="ds-panel-card-header">
                    <div>
                      <span class="text-13-medium text-text-base">Local preferences</span>
                      <p class="text-12-regular text-text-weak mt-0.5">
                        Stored only in this client and never written to any Config Set
                      </p>
                    </div>
                  </div>
                  <SettingRow
                    title="Send Shortcut"
                    description="Choose whether Enter sends immediately or inserts a newline"
                    trailing={
                      <SegmentPill
                        value={general.sendShortcut}
                        options={[
                          { value: "enter", label: "Enter Sends" },
                          { value: "mod-enter", label: "⌘/Ctrl Sends" },
                        ]}
                        onChange={(value) => handleLocalSendShortcut(value as SendShortcut)}
                      />
                    }
                  />
                </div>
              </div>
            </Show>

            <Show when={editMode() === "form" && activeTab() === "models"}>
              <div class="ds-section ds-section-enter">
                <div class="ds-section-header">
                  <div>
                    <span class="text-13-medium text-text-base">Model Roles</span>
                    <p class="text-12-regular text-text-weak mt-0.5">
                      Assign specific models for different task types. Leave empty to use the default model.
                    </p>
                  </div>
                </div>
                <Show
                  when={providerModels().length > 0}
                  fallback={
                    <div class="ds-empty-state">
                      <span>No connected models found</span>
                    </div>
                  }
                >
                  <For each={MODEL_ROLES}>
                    {(role) => (
                      <ModelRoleRow
                        label={role.label}
                        description={role.description}
                        value={models[role.key]}
                        providers={groupByProvider(providerModels())}
                        onChange={(value: string) => setModels(role.key, value)}
                      />
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            <Show when={editMode() === "form" && activeTab() === "mcp"}>
              <div class="ds-section ds-section-enter">
                <div class="ds-section-header">
                  <div>
                    <span class="text-13-medium text-text-base">MCP Servers</span>
                    <p class="text-12-regular text-text-weak mt-0.5">
                      Configure local (stdio) or remote (HTTP/SSE) servers
                    </p>
                  </div>
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    onClick={() => setMcps("entries", (prev) => [...prev, emptyMcp()])}
                  />
                </div>
                <For each={mcps.entries}>
                  {(entry, index) => (
                    <McpCard
                      entry={entry}
                      onChange={(field, value) => setMcps("entries", index(), field as keyof McpEntry, value as never)}
                      onRemove={() =>
                        setMcps(
                          "entries",
                          produce((draft) => {
                            draft.splice(index(), 1)
                          }),
                        )
                      }
                    />
                  )}
                </For>
                <Show when={mcps.entries.length === 0}>
                  <div class="ds-empty-state">
                    <Icon name="server" size="normal" class="text-text-weaker" />
                    <span>No MCP servers configured</span>
                    <span class="text-text-weaker">Click + to add one</span>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={editMode() === "form" && activeTab() === "plugins"}>
              <div class="ds-section ds-section-enter">
                <div class="ds-section-header">
                  <div>
                    <span class="text-13-medium text-text-base">Plugins</span>
                    <p class="text-12-regular text-text-weak mt-0.5">
                      Extend with custom tools, hooks, and integrations
                    </p>
                  </div>
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    onClick={() => setPlugins("entries", (prev) => [...prev, { value: "" }])}
                  />
                </div>
                <For each={plugins.entries}>
                  {(entry, index) => (
                    <div class="flex items-center gap-2">
                      <div class="flex-1">
                        <TextField
                          type="text"
                          placeholder="e.g. @scope/plugin or file:///path/to/plugin.ts"
                          value={entry.value}
                          onChange={(value) => setPlugins("entries", index(), "value", value)}
                        />
                      </div>
                      <IconButton
                        icon="x"
                        variant="ghost"
                        onClick={() =>
                          setPlugins(
                            "entries",
                            produce((draft) => {
                              draft.splice(index(), 1)
                            }),
                          )
                        }
                      />
                    </div>
                  )}
                </For>
                <Show when={plugins.entries.length === 0}>
                  <div class="ds-empty-state">
                    <Icon name="zap" size="normal" class="text-text-weaker" />
                    <span>No plugins configured</span>
                    <span class="text-text-weaker">Click + to add one</span>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={editMode() === "form" && activeTab() === "advanced"}>
              <div class="ds-section ds-section-enter">
                <SectionLabel title="Permission" />
                <SettingRow
                  title="Default Mode"
                  description="How tool permission requests are handled"
                  trailing={
                    <SegmentPill
                      value={advanced.permission}
                      options={[
                        { value: "", label: "Default" },
                        { value: "allow", label: "Allow" },
                        { value: "ask", label: "Ask" },
                        { value: "deny", label: "Deny" },
                      ]}
                      onChange={(value) => setAdvanced("permission", value)}
                    />
                  }
                />

                <SectionLabel title="Question" />
                <SettingRow
                  title="Response Timeout"
                  description="Auto-expire unanswered questions (0 = no timeout, default 30min)"
                  trailing={
                    <SegmentPill
                      value={advanced.question_timeout}
                      options={[
                        { value: "", label: "Default" },
                        { value: "0", label: "Never" },
                        { value: "300", label: "5min" },
                        { value: "600", label: "10min" },
                        { value: "1800", label: "30min" },
                        { value: "3600", label: "60min" },
                      ]}
                      onChange={(value) => setAdvanced("question_timeout", value)}
                    />
                  }
                />

                <SectionLabel title="Compaction" />
                <SettingRow
                  title="Auto Compact"
                  description="Compact sessions when context is full"
                  trailing={
                    <SegmentPill
                      value={advanced.compaction_auto}
                      options={[
                        { value: "", label: "Default" },
                        { value: "true", label: "On" },
                        { value: "false", label: "Off" },
                      ]}
                      onChange={(value) => setAdvanced("compaction_auto", value)}
                    />
                  }
                />
                <SettingRow
                  title="Overflow Threshold"
                  description="Context usage fraction that triggers auto-compaction (0.5–1.0, default 0.85)"
                  trailing={
                    <SegmentPill
                      value={advanced.compaction_overflow_threshold}
                      options={[
                        { value: "", label: "Default" },
                        { value: "0.70", label: "70%" },
                        { value: "0.80", label: "80%" },
                        { value: "0.85", label: "85%" },
                        { value: "0.90", label: "90%" },
                        { value: "0.95", label: "95%" },
                      ]}
                      onChange={(value) => setAdvanced("compaction_overflow_threshold", value)}
                    />
                  }
                />

                <SectionLabel title="Email" />
                <div class="ds-panel-card">
                  <div class="ds-panel-card-header">
                    <div>
                      <span class="text-13-medium text-text-base">Outgoing email</span>
                      <p class="text-12-regular text-text-weak mt-0.5">
                        Configure SMTP here. If you need advanced or provider-specific fields, switch to the JSON
                        editor.
                      </p>
                    </div>
                  </div>
                  <SettingRow
                    title="Enabled"
                    description="Allow email sending for tools"
                    trailing={<Switch checked={email.enabled} onChange={(value) => setEmail("enabled", value)} />}
                  />
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <TextField
                      label="From Address"
                      type="text"
                      value={email.fromAddress}
                      onChange={(value) => setEmail("fromAddress", value)}
                    />
                    <TextField
                      label="From Name"
                      type="text"
                      value={email.fromName}
                      onChange={(value) => setEmail("fromName", value)}
                    />
                    <TextField
                      label="SMTP Host"
                      type="text"
                      value={email.smtpHost}
                      onChange={(value) => setEmail("smtpHost", value)}
                    />
                    <TextField
                      label="SMTP Port"
                      type="text"
                      value={email.smtpPort}
                      onChange={(value) => setEmail("smtpPort", value)}
                    />
                    <TextField
                      label="SMTP Username"
                      type="text"
                      value={email.smtpUsername}
                      onChange={(value) => setEmail("smtpUsername", value)}
                    />
                    <TextField
                      label="SMTP Password"
                      type="password"
                      value={email.smtpPassword}
                      onChange={(value) => setEmail("smtpPassword", value)}
                    />
                  </div>
                  <SettingRow
                    title="Use TLS/SSL"
                    description="Controls the SMTP secure flag"
                    trailing={<Switch checked={email.smtpSecure} onChange={(value) => setEmail("smtpSecure", value)} />}
                  />
                </div>

                <SectionLabel title="Channels" />
                <AccountToggleCard
                  title="Feishu accounts"
                  description="Enable or disable existing Feishu channel accounts. Add accounts and detailed settings in the JSON editor."
                  accounts={channels.feishuAccounts}
                  emptyLabel="No Feishu accounts configured yet. Add them in JSON first."
                  onToggle={(index, value) => setChannels("feishuAccounts", index, "enabled", value)}
                />

                <SectionLabel title="Identity & Memory" />
                <SettingRow
                  title="Evolution"
                  description="Passive experience learning + active memory curation"
                  trailing={
                    <SegmentPill
                      value={identity.evolution}
                      options={[
                        { value: "", label: "Default" },
                        { value: "true", label: "On" },
                        { value: "false", label: "Off" },
                      ]}
                      onChange={(value) => setIdentity("evolution", value)}
                    />
                  }
                />
                <SettingRow
                  title="Autonomy"
                  description="Autonomous background routines like daily self-reflection and agenda planning"
                  trailing={
                    <SegmentPill
                      value={identity.autonomy}
                      options={[
                        { value: "", label: "Default" },
                        { value: "true", label: "On" },
                        { value: "false", label: "Off" },
                      ]}
                      onChange={(value) => setIdentity("autonomy", value)}
                    />
                  }
                />
              </div>
            </Show>

            <Show when={editMode() === "form" && activeTab() === "config-sets"}>
              <div class="ds-section ds-section-enter">
                <div class="ds-panel-card">
                  <div class="ds-panel-card-header">
                    <div>
                      <span class="text-13-medium text-text-base">Current Set</span>
                      <p class="text-12-regular text-text-weak mt-0.5">
                        Active controls runtime behavior. Edit picks which Config Set the other tabs are currently
                        changing.
                      </p>
                    </div>
                  </div>
                  <For each={globalSync.configSets}>
                    {(set) => (
                      <div class="ds-config-set-row" classList={{ "ds-config-set-row-active": set.active }}>
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="text-13-medium text-text-base truncate">{set.name}</span>
                            <Show when={set.active}>
                              <span class="ds-inline-badge">Active</span>
                            </Show>
                            <Show when={selectedSet()?.name === set.name && !set.active}>
                              <span class="ds-inline-badge ds-inline-badge-muted">Editing</span>
                            </Show>
                          </div>
                        </div>
                        <div class="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="small"
                            onClick={async () => {
                              if (set.name !== selectedSet()?.name && hasAnyChanges()) {
                                runDiscardGuard(`open ${set.name}`, async () => {
                                  setSelectedSetName(set.name)
                                  setActiveTab("general")
                                  resetEditor()
                                  showToast({
                                    title: `Opened ${set.name}`,
                                    description: set.active
                                      ? "You are now editing the active Config Set. Save changes to update runtime config."
                                      : "You are now editing an inactive Config Set. Save changes here, then activate it when ready.",
                                  })
                                })
                                return
                              }
                              setSelectedSetName(set.name)
                              setActiveTab("general")
                              resetEditor()
                              showToast({
                                title: `Opened ${set.name}`,
                                description: set.active
                                  ? "You are now editing the active Config Set. Save changes to update runtime config."
                                  : "You are now editing an inactive Config Set. Save changes here, then activate it when ready.",
                              })
                            }}
                          >
                            Open
                          </Button>
                          <Show when={!set.active}>
                            <Button
                              type="button"
                              variant="secondary"
                              size="small"
                              onClick={() => void handleSwitchSet(set.name)}
                            >
                              Activate
                            </Button>
                          </Show>
                          <Show when={!set.active}>
                            <IconButton icon="trash-2" variant="ghost" onClick={() => void handleDeleteSet(set.name)} />
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>

                <div class="ds-panel-card">
                  <div class="ds-panel-card-header">
                    <div>
                      <span class="text-13-medium text-text-base">Create Set</span>
                      <p class="text-12-regular text-text-weak mt-0.5">
                        Create a new Config Set by copying the current active one, then continue editing it in the
                        existing tabs.
                      </p>
                    </div>
                  </div>
                  <div class="ds-create-row">
                    <div class="flex-1 min-w-0">
                      <TextField
                        type="text"
                        placeholder="e.g. work, writing, eval"
                        value={createSetName()}
                        onChange={setCreateSetName}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="primary"
                      size="small"
                      disabled={creatingSet()}
                      onClick={() => void handleCreateSet()}
                    >
                      {creatingSet() ? "Creating..." : "Create"}
                    </Button>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={editMode() === "raw"}>
              <div class="ds-section ds-section-enter ds-raw-editor-container">
                <div class="ds-context-bar">
                  <div class="ds-context-pill">
                    <span class="ds-context-label">Editing</span>
                    <span class="ds-context-value">{editingLabel()}</span>
                    <Show when={hasRawChanges()}>
                      <span class="ds-inline-badge ds-inline-badge-dirty">Unsaved</span>
                    </Show>
                  </div>
                  <div class="ml-auto flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={validatingRaw() || !hasRawChanges()}
                      onClick={() => void validateRawConfig()}
                    >
                      {validatingRaw() ? "Validating..." : "Validate"}
                    </Button>
                  </div>
                </div>

                <Show when={rawValidation.errors.length > 0}>
                  <div class="ds-raw-validation ds-raw-validation-error">
                    <For each={rawValidation.errors}>{(err) => <div class="ds-raw-validation-item">{err}</div>}</For>
                  </div>
                </Show>
                <Show when={rawValidation.warnings.length > 0}>
                  <div class="ds-raw-validation ds-raw-validation-warning">
                    <For each={rawValidation.warnings}>
                      {(warn) => <div class="ds-raw-validation-item">{warn}</div>}
                    </For>
                  </div>
                </Show>

                <textarea
                  class="ds-raw-textarea"
                  value={rawText()}
                  onInput={(e) => {
                    setRawText(e.currentTarget.value)
                    if (!rawValidation.valid || rawValidation.errors.length > 0) {
                      setRawValidation({ valid: true, errors: [], warnings: [] })
                    }
                  }}
                  spellcheck={false}
                  autocomplete="off"
                  autocapitalize="off"
                  wrap="off"
                />
              </div>
            </Show>
          </div>

          <div class="ds-footer">
            <Button type="button" variant="ghost" size="large" onClick={closeWithGuard}>
              Cancel
            </Button>
            <Show when={editMode() === "raw"}>
              <Show when={!selectedSetIsActive()}>
                <Button
                  type="button"
                  variant="secondary"
                  size="large"
                  disabled={saving() || !hasRawChanges()}
                  onClick={() => void saveRawConfig({ close: true })}
                >
                  {saving() ? "Saving..." : `Save to ${editingLabel()}`}
                </Button>
              </Show>
              <Show when={!selectedSetIsActive()}>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  disabled={saving()}
                  onClick={() => void saveRawConfig({ activate: true, close: true })}
                >
                  {saving() ? "Saving..." : `Save & Activate ${editingLabel()}`}
                </Button>
              </Show>
              <Show when={selectedSetIsActive()}>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  disabled={saving() || !hasRawChanges()}
                  onClick={() => void saveRawConfig({ close: true })}
                >
                  {saving() ? "Saving..." : "Save Changes"}
                </Button>
              </Show>
            </Show>
            <Show when={editMode() === "form"}>
              <Show when={!selectedSetIsActive()}>
                <Button
                  type="button"
                  variant="secondary"
                  size="large"
                  disabled={saving() || !hasServerChanges()}
                  onClick={() => void saveServerChanges({ close: true })}
                >
                  {saving() ? "Saving..." : `Save to ${editingLabel()}`}
                </Button>
              </Show>
              <Show when={!selectedSetIsActive()}>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  disabled={saving()}
                  onClick={() => void saveServerChanges({ activate: true, close: true })}
                >
                  {saving() ? "Saving..." : `Save & Activate ${editingLabel()}`}
                </Button>
              </Show>
              <Show when={selectedSetIsActive()}>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  disabled={saving() || !hasServerChanges()}
                  onClick={() => void saveServerChanges({ close: true })}
                >
                  {saving() ? "Saving..." : "Save Changes"}
                </Button>
              </Show>
            </Show>
          </div>
        </div>
      ) : (
        <div class="flex items-center justify-center py-8 text-13-regular text-text-weak">Loading...</div>
      )}
    </Dialog>
  )
}

function SectionLabel(props: { title: string }) {
  return (
    <div class="ds-section-label">
      <span>{props.title}</span>
    </div>
  )
}

function SettingRow(props: { title: string; description: string; trailing: any }) {
  return (
    <div class="ds-setting-row">
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-13-medium text-text-base">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.trailing}</div>
    </div>
  )
}

function AccountToggleCard(props: {
  title: string
  description: string
  accounts: AccountToggle[]
  emptyLabel: string
  onToggle: (index: number, value: boolean) => void
}) {
  return (
    <div class="ds-panel-card">
      <div class="ds-panel-card-header">
        <div>
          <span class="text-13-medium text-text-base">{props.title}</span>
          <p class="text-12-regular text-text-weak mt-0.5">{props.description}</p>
        </div>
      </div>
      <Show
        when={props.accounts.length > 0}
        fallback={<div class="text-12-regular text-text-weak">{props.emptyLabel}</div>}
      >
        <For each={props.accounts}>
          {(account, index) => (
            <SettingRow
              title={account.key}
              description={`Account ${account.key}`}
              trailing={<Switch checked={account.enabled} onChange={(value) => props.onToggle(index(), value)} />}
            />
          )}
        </For>
      </Show>
    </div>
  )
}

function SegmentPill(props: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div class="ds-segment">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            classList={{
              "ds-segment-item": true,
              "ds-segment-item-active": props.value === option.value,
            }}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}

function McpCard(props: {
  entry: McpEntry
  onChange: (field: string, value: string | boolean) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = createSignal(true)

  return (
    <div class="ds-mcp-card">
      <div class="ds-mcp-card-header" onClick={() => setExpanded((value) => !value)}>
        <div class="flex items-center gap-2 min-w-0">
          <div class="ds-mcp-dot" classList={{ "ds-mcp-dot-active": props.entry.enabled }} />
          <span class="text-13-medium text-text-base truncate">{props.entry.key || "New Server"}</span>
          <span class="ds-mcp-badge">{props.entry.type === "local" ? "stdio" : "http"}</span>
        </div>
        <div class="flex items-center gap-1">
          <div onClick={(event) => event.stopPropagation()}>
            <Switch checked={props.entry.enabled} onChange={(value) => props.onChange("enabled", value)} />
          </div>
          <IconButton
            icon="x"
            variant="ghost"
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              props.onRemove()
            }}
          />
          <Icon
            name="chevron-down"
            size="small"
            class={`text-text-weak transition-transform duration-200 ${expanded() ? "rotate-180" : ""}`}
          />
        </div>
      </div>
      <Show when={expanded()}>
        <div class="ds-mcp-card-body">
          <TextField
            type="text"
            label="Server Name"
            placeholder="e.g. my-mcp-server"
            description="Unique identifier for this MCP server"
            value={props.entry.key}
            onChange={(value) => props.onChange("key", value)}
          />
          <SegmentPill
            value={props.entry.type}
            options={[
              { value: "local", label: "Local (stdio)" },
              { value: "remote", label: "Remote (HTTP)" },
            ]}
            onChange={(value) => props.onChange("type", value)}
          />
          <Show when={props.entry.type === "local"}>
            <TextField
              type="text"
              label="Command"
              placeholder="e.g. npx -y @modelcontextprotocol/server-filesystem /path"
              description="Command and arguments to start the MCP server"
              value={props.entry.command}
              onChange={(value) => props.onChange("command", value)}
            />
            <TextField
              type="text"
              multiline
              label="Environment"
              placeholder={"KEY=value\nANOTHER=value"}
              description="Environment variables (one per line, KEY=value)"
              value={props.entry.environment}
              onChange={(value) => props.onChange("environment", value)}
            />
          </Show>
          <Show when={props.entry.type === "remote"}>
            <TextField
              type="text"
              label="URL"
              placeholder="https://mcp.example.com/sse"
              description="URL of the remote MCP server"
              value={props.entry.url}
              onChange={(value) => props.onChange("url", value)}
            />
            <TextField
              type="text"
              multiline
              label="Headers"
              placeholder={"Authorization: Bearer token\nX-Custom: value"}
              description="HTTP headers (one per line, Key: value)"
              value={props.entry.headers}
              onChange={(value) => props.onChange("headers", value)}
            />
          </Show>
          <TextField
            type="text"
            label="Timeout"
            placeholder="30000 (ms, default)"
            description="Connection timeout in milliseconds"
            value={props.entry.timeout}
            onChange={(value) => props.onChange("timeout", value)}
          />
        </div>
      </Show>
    </div>
  )
}

type ProviderGroup = {
  providerId: string
  providerName: string
  models: Array<{ id: string; name: string }>
}

function groupByProvider(list: ProviderModel[]): ProviderGroup[] {
  const map = new Map<string, ProviderGroup>()
  for (const item of list) {
    let group = map.get(item.providerId)
    if (!group) {
      group = { providerId: item.providerId, providerName: item.providerName, models: [] }
      map.set(item.providerId, group)
    }
    group.models.push({ id: item.modelId, name: item.modelName })
  }
  return Array.from(map.values())
}

function ModelRoleRow(props: {
  label: string
  description: string
  value: string
  providers: ProviderGroup[]
  onChange: (value: string) => void
}) {
  return (
    <div class="ds-setting-row ds-model-role-row">
      <div class="flex flex-col gap-0.5 min-w-0" style={{ flex: "0 0 180px" }}>
        <span class="text-13-medium text-text-base">{props.label}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-1 min-w-0">
        <select
          class="ds-model-select"
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        >
          <option value="">— Default</option>
          <For each={props.providers}>
            {(provider) => (
              <optgroup label={provider.providerName}>
                <For each={provider.models}>
                  {(model) => <option value={`${provider.providerId}/${model.id}`}>{model.name}</option>}
                </For>
              </optgroup>
            )}
          </For>
        </select>
      </div>
    </div>
  )
}
