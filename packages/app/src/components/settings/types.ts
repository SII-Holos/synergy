import type { Config, ConfigSetSummary } from "@ericsanchezok/synergy-sdk/client"
import type { SendShortcut } from "@/context/input"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"

export type ProviderModel = {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
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

/** Resolved defaults returned by Config.get() (Phase 1 backend). These are the actual active defaults, never undefined. */
export const MODEL_DEFAULTS: Record<ModelKey, string> = {
  model: "synergy",
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
  autoupdate: "true" as string, // backend injects true → UI shows "true" / On
  snapshot: true,
  permission: "ask" as string, // resolved from backend { "*": "ask" } object
  questionTimeout: 1800,
  compactionAuto: "true" as string,
  compactionOverflowThreshold: "0.85" as string,
  identityEvolution: "true" as string,
  identityAutonomy: "true" as string,
  memorySimThreshold: "0.7" as string,
  memoryTopK: "3" as string,
  experienceSimThreshold: "0.7" as string,
  experienceTopK: "8" as string,
  experienceEpsilon: "0.1" as string,
  controlProfile: "guarded" as string,
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
    description: "Intent detection, script extraction, reward evaluation, and genesis bootstrapping",
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
}

export type ChannelSettings = {
  feishuAccounts: AccountToggle[]
}

export function emptyMcp(): McpEntry {
  return { key: "", type: "local", enabled: true, command: "", url: "", timeout: "", environment: "", headers: "" }
}

export type RawValidationState = {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export type SettingsEditMode = "form" | "raw"

export type DialogSettingsProps = {
  initialTab?: string
}

export type NavItem = {
  id: string
  label: string
  icon: IconName
}

export type NavGroup = {
  label: string
  icon: IconName
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Core",
    icon: "settings",
    items: [
      { id: "general", label: "General", icon: "settings" },
      { id: "models", label: "Models", icon: "cpu" },
    ],
  },
  {
    label: "Integrations",
    icon: "cable",
    items: [
      { id: "mcp", label: "MCP", icon: "cable" },
      { id: "plugins", label: "Plugins", icon: "package" },
      { id: "email", label: "Email", icon: "mail" },
      { id: "channels", label: "Channels", icon: "globe" },
    ],
  },
  {
    label: "Identity",
    icon: "fingerprint",
    items: [{ id: "identity", label: "Identity & Memory", icon: "fingerprint" }],
  },
  {
    label: "System",
    icon: "sliders-horizontal",
    items: [
      { id: "advanced", label: "System", icon: "sliders-horizontal" },
      { id: "config-sets", label: "Config Sets", icon: "layers" },
    ],
  },
]

/** Flat list for backward-compatible lookups */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

export type ProviderGroup = {
  providerId: string
  providerName: string
  models: Array<{ id: string; name: string }>
}

export function groupByProvider(list: ProviderModel[]): ProviderGroup[] {
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

export type GeneralStore = {
  snapshot: boolean
  autoupdate: string
  sendShortcut: SendShortcut
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
}

export type PluginsStore = {
  entries: PluginEntry[]
}

export type McpsStore = {
  entries: McpEntry[]
}

export type IdentityStore = {
  evolution: string
  autonomy: string
  memorySimThreshold: string
  memoryTopK: string
  experienceSimThreshold: string
  experienceTopK: string
  experienceEpsilon: string
}

export type AdvancedStore = {
  controlProfile: string
  compaction_auto: string
  compaction_overflow_threshold: string
  permission: string
  question_timeout: string
}
