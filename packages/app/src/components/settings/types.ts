import type { SendShortcut } from "@/context/input"

export type ProviderModel = {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  variantKeys: string[]
}

export type ModelKey =
  | "model"
  | "nano_model"
  | "mini_model"
  | "mid_model"
  | "vision_model"
  | "thinking_model"
  | "long_context_model"
  | "creative_model"

/** Empty strings mean this role falls back to runtime model resolution. */
export const MODEL_DEFAULTS: Record<ModelKey, string> = {
  model: "",
  nano_model: "",
  mini_model: "",
  mid_model: "",
  vision_model: "",
  thinking_model: "",
  long_context_model: "",
  creative_model: "",
}

/** Defaults used by frontend form fallbacks, kept in sync with backend Config.state() defaults. */
export const UI_DEFAULTS = {
  theme: "" as string,
  username: "" as string,
  snapshot: true,
  permission: "ask" as string, // resolved from backend { "*": "ask" } object
  sandboxEnabled: "true" as string,
  sandboxFallbackPolicy: "warn" as string,
  questionTimeout: 3600,
  compactionAuto: "true" as string,
  compactionPrune: "true" as string,
  compactionOverflowThreshold: "0.85" as string,
  compactionMaxHistoryImages: "8" as string,
  cortexConcurrency: "8" as string,
  libraryLearning: "true" as string,
  libraryAutonomy: "true" as string,
  memorySimThreshold: "0.7" as string,
  memoryTopK: "3" as string,
  embeddingSource: "huggingface" as LocalEmbeddingSource,
  embeddingRemoteHost: "" as string,
  experienceSimThreshold: "0.7" as string,
  experienceTopK: "8" as string,
  experienceEpsilon: "0.1" as string,
  controlProfile: "guarded" as string,
  invokeTimeout: "21600" as string,
  providerTtfbTimeout: "3600" as string,
  providerIdleTimeout: "900" as string,
  providerWallTimeout: "" as string,
  toolDefaultTimeout: "7200" as string,
  toolOverrides: "" as string,
  watcherIgnore: "" as string,
  logLevel: "" as string,
  coauthorReminder: "true" as string,
  lspWriteDiagnostics: "true" as string,
  lspDiagnosticsSeverity: "error" as string,
  lspDiagnosticsScope: "project" as string,
  defaultAgent: "synergy" as string,
} as const

/** Resolve Config.permission (object or string) into a simple UI string. */
export function resolvePermissionForUi(permission: unknown): string {
  if (!permission) return UI_DEFAULTS.permission
  if (typeof permission === "string") return permission
  if (typeof permission === "object" && permission !== null) {
    const obj = permission as Record<string, unknown>
    if (obj["*"] === "ask") return "ask"
    if (obj["*"] === "allow") return "allow"
    if (obj["*"] === "deny") return "deny"
  }
  return UI_DEFAULTS.permission
}
export const MODEL_ROLES: Array<{ key: ModelKey; label: string; description: string }> = [
  { key: "model", label: "Default Model", description: "Primary model for conversations and agent tasks" },
  { key: "nano_model", label: "Nano Model", description: "Cheapest model for trivial tasks like title generation" },
  {
    key: "mini_model",
    label: "Mini Model",
    description: "Intent detection, script extraction, and reward evaluation",
  },
  {
    key: "mid_model",
    label: "Mid Model",
    description: "Explore, scout, and quick-category task routing",
  },
  { key: "vision_model", label: "Vision Model", description: "Image, PDF, and file analysis" },
  { key: "thinking_model", label: "Thinking Model", description: "Complex reasoning and architecture decisions" },
  {
    key: "long_context_model",
    label: "Long Context Model",
    description: "Session compaction, long document analysis",
  },
  { key: "creative_model", label: "Creative Model", description: "Writing, design, and artistry" },
]

export type PluginEntry = {
  value: string
}

export type McpEntry = {
  key: string
  type: "local" | "remote"
  enabled: boolean
  command: string
  url: string
  timeout: string
  environment: string
  headers: string
}

export type EmailSettings = {
  enabled: boolean
  fromAddress: string
  fromName: string
  smtpHost: string
  smtpPort: string
  smtpSecure: boolean
  smtpUsername: string
  smtpPassword: string
  imapHost: string
  imapPort: string
  imapSecure: boolean
  imapUsername: string
  imapPassword: string
}

export type AccountToggle = {
  key: string
  enabled: boolean
  model: string
}

export type ChannelSettings = {
  feishuAccounts: AccountToggle[]
}

export const TOAST_TYPES = ["info", "success", "warning", "error"] as const
export const DEFAULT_TOAST_DURATION_MS = 4000
export const TOAST_DURATION_STOPS = [1000, 2000, DEFAULT_TOAST_DURATION_MS, 8000] as const
export type ToastType = (typeof TOAST_TYPES)[number]
export type ToastDurationOverrides = Record<ToastType, string>

export function emptyToastDurationOverrides(): ToastDurationOverrides {
  return { info: "", success: "", warning: "", error: "" }
}

export function snapToastDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOAST_DURATION_MS

  let best: number = TOAST_DURATION_STOPS[0]
  let bestDistance = Math.abs(best - value)
  for (const stop of TOAST_DURATION_STOPS) {
    const distance = Math.abs(stop - value)
    if (distance < bestDistance || (distance === bestDistance && stop > best)) {
      best = stop
      bestDistance = distance
    }
  }
  return best
}

export function emptyMcp(): McpEntry {
  return { key: "", type: "local", enabled: true, command: "", url: "", timeout: "", environment: "", headers: "" }
}

export type DialogSettingsProps = {
  initialTab?: string
  providerFocusID?: string
}

export type ProviderGroup = {
  providerId: string
  providerName: string
  models: Array<{ id: string; name: string; variantKeys: string[] }>
}

export function groupByProvider(list: ProviderModel[]): ProviderGroup[] {
  const map = new Map<string, ProviderGroup>()
  for (const item of list) {
    let group = map.get(item.providerId)
    if (!group) {
      group = { providerId: item.providerId, providerName: item.providerName, models: [] }
      map.set(item.providerId, group)
    }
    group.models.push({ id: item.modelId, name: item.modelName, variantKeys: item.variantKeys })
  }
  return Array.from(map.values())
}

export type GeneralStore = {
  snapshot: boolean
  username: string
  theme: string
  mutedToasts: string[]
  toastDurations: ToastDurationOverrides
  sendShortcut: SendShortcut
}

export type QuickSwitcherPreference = {
  providerID: string
  modelID: string
  state: "add" | "remove"
}

export type ModelsStore = {
  model: string
  nano_model: string
  mini_model: string
  mid_model: string
  vision_model: string
  thinking_model: string
  long_context_model: string
  creative_model: string
  quick_switcher: QuickSwitcherPreference[]
}

export type AgentsStore = {
  defaultAgent: string
}

export type PluginsStore = {
  entries: PluginEntry[]
}

export type McpsStore = {
  entries: McpEntry[]
}

export type LocalEmbeddingSource = "huggingface" | "hf-mirror" | "custom"

export type LibrarySettingsStore = {
  learning: string
  autonomy: string
  memorySimThreshold: string
  memoryTopK: string
  experienceSimThreshold: string
  experienceTopK: string
  experienceEpsilon: string
  embeddingSource: LocalEmbeddingSource
  embeddingRemoteHost: string
}

export type ProvidersStore = {
  enabledProviders: string
  disabledProviders: string
}

export type SafetyStore = {
  controlProfile: string
  permission: string
  smartAllow: string
  sandboxEnabled: string
  sandboxFallbackPolicy: string
}

export type RuntimeStore = {
  questionTimeout: string
  compactionAuto: string
  compactionPrune: string
  compactionOverflowThreshold: string
  compactionMaxHistoryImages: string
  cortexConcurrency: string
  invokeTimeout: string
  providerTtfbTimeout: string
  providerIdleTimeout: string
  providerWallTimeout: string
  toolDefaultTimeout: string
  toolOverrides: string
  watcherIgnore: string
  logLevel: string
  coauthorReminder: string
  lspWriteDiagnostics: string
  lspDiagnosticsSeverity: string
  lspDiagnosticsScope: string
}

export type SettingsState = {
  general: GeneralStore
  models: ModelsStore
  agents: AgentsStore
  providers: ProvidersStore
  plugins: PluginsStore
  mcps: McpsStore
  library: LibrarySettingsStore
  safety: SafetyStore
  runtime: RuntimeStore
  email: EmailSettings
  channels: ChannelSettings
  roleVariant: Record<string, string>
}

export function defaultSettingsState(sendShortcut: SendShortcut): SettingsState {
  return {
    general: {
      snapshot: UI_DEFAULTS.snapshot,
      username: UI_DEFAULTS.username,
      theme: UI_DEFAULTS.theme,
      mutedToasts: [],
      toastDurations: emptyToastDurationOverrides(),
      sendShortcut,
    },
    models: {
      model: MODEL_DEFAULTS.model,
      nano_model: MODEL_DEFAULTS.nano_model,
      mini_model: MODEL_DEFAULTS.mini_model,
      mid_model: MODEL_DEFAULTS.mid_model,
      vision_model: MODEL_DEFAULTS.vision_model,
      thinking_model: MODEL_DEFAULTS.thinking_model,
      long_context_model: MODEL_DEFAULTS.long_context_model,
      creative_model: MODEL_DEFAULTS.creative_model,
      quick_switcher: [],
    },
    agents: {
      defaultAgent: UI_DEFAULTS.defaultAgent,
    },
    providers: {
      enabledProviders: "",
      disabledProviders: "",
    },
    plugins: {
      entries: [],
    },
    mcps: {
      entries: [],
    },
    library: {
      learning: UI_DEFAULTS.libraryLearning,
      autonomy: UI_DEFAULTS.libraryAutonomy,
      memorySimThreshold: UI_DEFAULTS.memorySimThreshold,
      memoryTopK: UI_DEFAULTS.memoryTopK,
      experienceSimThreshold: UI_DEFAULTS.experienceSimThreshold,
      experienceTopK: UI_DEFAULTS.experienceTopK,
      experienceEpsilon: UI_DEFAULTS.experienceEpsilon,
      embeddingSource: UI_DEFAULTS.embeddingSource,
      embeddingRemoteHost: UI_DEFAULTS.embeddingRemoteHost,
    },
    safety: {
      controlProfile: UI_DEFAULTS.controlProfile,
      permission: UI_DEFAULTS.permission,
      smartAllow: "false",
      sandboxEnabled: UI_DEFAULTS.sandboxEnabled,
      sandboxFallbackPolicy: UI_DEFAULTS.sandboxFallbackPolicy,
    },
    runtime: {
      questionTimeout: String(UI_DEFAULTS.questionTimeout),
      compactionAuto: UI_DEFAULTS.compactionAuto,
      compactionPrune: UI_DEFAULTS.compactionPrune,
      compactionOverflowThreshold: UI_DEFAULTS.compactionOverflowThreshold,
      compactionMaxHistoryImages: UI_DEFAULTS.compactionMaxHistoryImages,
      cortexConcurrency: UI_DEFAULTS.cortexConcurrency,
      invokeTimeout: UI_DEFAULTS.invokeTimeout,
      providerTtfbTimeout: UI_DEFAULTS.providerTtfbTimeout,
      providerIdleTimeout: UI_DEFAULTS.providerIdleTimeout,
      providerWallTimeout: UI_DEFAULTS.providerWallTimeout,
      toolDefaultTimeout: UI_DEFAULTS.toolDefaultTimeout,
      toolOverrides: UI_DEFAULTS.toolOverrides,
      watcherIgnore: UI_DEFAULTS.watcherIgnore,
      logLevel: UI_DEFAULTS.logLevel,
      coauthorReminder: UI_DEFAULTS.coauthorReminder,
      lspWriteDiagnostics: UI_DEFAULTS.lspWriteDiagnostics,
      lspDiagnosticsSeverity: UI_DEFAULTS.lspDiagnosticsSeverity,
      lspDiagnosticsScope: UI_DEFAULTS.lspDiagnosticsScope,
    },
    email: {
      enabled: true,
      fromAddress: "",
      fromName: "",
      smtpHost: "",
      smtpPort: "",
      smtpSecure: true,
      smtpUsername: "",
      smtpPassword: "",
      imapHost: "",
      imapPort: "",
      imapSecure: true,
      imapUsername: "",
      imapPassword: "",
    },
    channels: {
      feishuAccounts: [],
    },
    roleVariant: {},
  }
}
