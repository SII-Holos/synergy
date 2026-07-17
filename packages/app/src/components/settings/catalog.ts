import type { MessageDescriptor } from "@lingui/core"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

const SETTINGS_GROUP_KEYS = ["personal", "core", "library", "integrations", "safety", "runtime", "system"] as const

type SettingsGroupKey = (typeof SETTINGS_GROUP_KEYS)[number]

const SETTINGS_GROUP_COPY = {
  personal: { id: "settings.catalog.group.personal", message: "Personal" },
  core: { id: "settings.catalog.group.core", message: "Core" },
  library: { id: "settings.catalog.group.library", message: "Library" },
  integrations: { id: "settings.catalog.group.integrations", message: "Integrations" },
  safety: { id: "settings.catalog.group.safety", message: "Safety" },
  runtime: { id: "settings.catalog.group.runtime", message: "Runtime" },
  system: { id: "settings.catalog.group.system", message: "System" },
} satisfies Record<SettingsGroupKey, MessageDescriptor>

export const SETTINGS_GROUP_ORDER: readonly SettingsGroupKey[] = SETTINGS_GROUP_KEYS

export type SettingsGroup = string

export const BUILTIN_SETTINGS_IDS = [
  "account",
  "personalize",
  "general",
  "models",
  "providers",
  "usage",
  "github",
  "learning",
  "memory",
  "experience",
  "mcp",
  "channels",
  "email",
  "permissions",
  "sandbox",
  "control-profile",
  "questions",
  "compaction",
  "timeouts",
  "code-checks",
  "formatter",
  "lsp",
  "observability",
  "import",
  "config-files",
  "archived-sessions",
  "worktrees",
] as const

export type BuiltinSettingsId = (typeof BUILTIN_SETTINGS_IDS)[number]
export type SettingsFieldStrategy = "auto" | "background" | "explicit"

export type SettingsCatalogCopy = {
  label: MessageDescriptor
  group: MessageDescriptor
  description: MessageDescriptor
  searchTerms: MessageDescriptor
  rowLabels: MessageDescriptor[]
}

export type SettingsCatalogSection = {
  id: BuiltinSettingsId
  label: string
  group: SettingsGroup
  groupKey: SettingsGroupKey
  order: number
  iconToken: SemanticIconTokenName
  description: string
  keywords: string[]
  domainIds: string[]
  rowLabels: string[]
  visibility?: "standard" | "developer"
  copy: SettingsCatalogCopy
}

type SettingsCopyDefinition = Omit<SettingsCatalogCopy, "group" | "rowLabels"> & {
  rowLabels?: MessageDescriptor[]
}

const SEARCH_TERMS_COMMENT =
  "Settings search aliases. The vertical bars separate aliases; preserve them in translation."

const BUILTIN_SETTINGS_COPY = {
  account: {
    label: { id: "settings.catalog.account.label", message: "Account" },
    description: {
      id: "settings.catalog.account.description",
      message: "Holos agent identities and local account controls.",
    },
    searchTerms: {
      id: "settings.catalog.account.searchTerms",
      message: "user | identity | login | holos | agent",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  personalize: {
    label: { id: "settings.catalog.personalize.label", message: "Personalize" },
    description: {
      id: "settings.catalog.personalize.description",
      message: "Global custom instructions that shape how Synergy works across projects.",
    },
    searchTerms: {
      id: "settings.catalog.personalize.searchTerms",
      message: "personalize | custom instructions | system prompt | AGENTS.md | AGENTS.override.md",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [{ id: "settings.catalog.personalize.row.customInstructions", message: "Custom Instructions" }],
  },
  general: {
    label: { id: "settings.catalog.general.label", message: "General" },
    description: {
      id: "settings.catalog.general.description",
      message: "Appearance, behavior, and notification preferences.",
    },
    searchTerms: {
      id: "settings.catalog.general.searchTerms",
      message: "appearance | color | light | dark | auto | language | snapshot | product update | toast | notification",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.general.row.colorScheme", message: "Color Scheme" },
      { id: "settings.catalog.general.row.interfaceLanguage", message: "Interface Language" },
      { id: "settings.catalog.general.row.snapshot", message: "Snapshot" },
      { id: "settings.catalog.general.row.productUpdates", message: "Product Updates" },
      { id: "settings.catalog.general.row.notifications", message: "Notifications" },
      { id: "settings.catalog.general.row.toastDuration", message: "Toast Duration" },
    ],
  },
  models: {
    label: { id: "settings.catalog.models.label", message: "Models" },
    description: { id: "settings.catalog.models.description", message: "Model roles used by agents and tools." },
    searchTerms: {
      id: "settings.catalog.models.searchTerms",
      message: "model | provider | role",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.models.row.default", message: "Default Model" },
      { id: "settings.catalog.models.row.mini", message: "Mini Model" },
      { id: "settings.catalog.models.row.vision", message: "Vision Model" },
      { id: "settings.catalog.models.row.thinking", message: "Thinking Model" },
    ],
  },
  providers: {
    label: { id: "settings.catalog.providers.label", message: "Providers" },
    description: {
      id: "settings.catalog.providers.description",
      message: "Provider availability and connection status.",
    },
    searchTerms: {
      id: "settings.catalog.providers.searchTerms",
      message: "provider | api | enabled | disabled",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  usage: {
    label: { id: "settings.catalog.usage.label", message: "Usage" },
    description: {
      id: "settings.catalog.usage.description",
      message: "Provider usage, quota windows, credits, and account health.",
    },
    searchTerms: {
      id: "settings.catalog.usage.searchTerms",
      message: "usage | quota | credits | billing | codex | claude",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  github: {
    label: { id: "settings.catalog.github.label", message: "GitHub" },
    description: {
      id: "settings.catalog.github.description",
      message: "GitHub credentials for issues, pull requests, releases, and GitHub CLI actions.",
    },
    searchTerms: {
      id: "settings.catalog.github.searchTerms",
      message: "github | gh | issue | pull request | release | token",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  learning: {
    label: { id: "settings.catalog.learning.label", message: "Learning" },
    description: { id: "settings.catalog.learning.description", message: "Library learning and autonomy controls." },
    searchTerms: {
      id: "settings.catalog.learning.searchTerms",
      message: "library | learning | autonomy",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.learning.row.enableLearning", message: "Enable Learning" },
      { id: "settings.catalog.learning.row.enableAutonomy", message: "Enable Autonomy" },
    ],
  },
  memory: {
    label: { id: "settings.catalog.memory.label", message: "Memory" },
    description: {
      id: "settings.catalog.memory.description",
      message: "Memory retrieval and embedding configuration.",
    },
    searchTerms: {
      id: "settings.catalog.memory.searchTerms",
      message:
        "memory | embedding | recall | download | model | local | remote | huggingface | hf mirror | custom source",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.memory.row.similarity", message: "Memory Similarity" },
      { id: "settings.catalog.memory.row.perCategory", message: "Memory per Category" },
      { id: "settings.catalog.memory.row.currentModel", message: "Current Model" },
      { id: "settings.catalog.memory.row.downloadSource", message: "Download Source" },
      { id: "settings.catalog.memory.row.localModelFiles", message: "Local Model Files" },
    ],
  },
  experience: {
    label: { id: "settings.catalog.experience.label", message: "Experience" },
    description: {
      id: "settings.catalog.experience.description",
      message: "Experience retrieval and exploration controls.",
    },
    searchTerms: {
      id: "settings.catalog.experience.searchTerms",
      message: "experience | retrieval | epsilon",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.experience.row.similarity", message: "Experience Similarity" },
      { id: "settings.catalog.experience.row.count", message: "Experience Count" },
      { id: "settings.catalog.experience.row.explorationRate", message: "Exploration Rate" },
    ],
  },
  mcp: {
    label: { id: "settings.catalog.mcp.label", message: "MCP" },
    description: { id: "settings.catalog.mcp.description", message: "Model Context Protocol servers and defaults." },
    searchTerms: {
      id: "settings.catalog.mcp.searchTerms",
      message: "mcp | server | tool",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  channels: {
    label: { id: "settings.catalog.channels.label", message: "Channels" },
    description: { id: "settings.catalog.channels.description", message: "External messaging channel accounts." },
    searchTerms: {
      id: "settings.catalog.channels.searchTerms",
      message: "channel | feishu | messaging",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  email: {
    label: { id: "settings.catalog.email.label", message: "Email" },
    description: { id: "settings.catalog.email.description", message: "SMTP and IMAP settings for mail tools." },
    searchTerms: {
      id: "settings.catalog.email.searchTerms",
      message: "email | smtp | imap",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  permissions: {
    label: { id: "settings.catalog.permissions.label", message: "Permissions" },
    description: {
      id: "settings.catalog.permissions.description",
      message: "Default permission mode and tool toggles.",
    },
    searchTerms: {
      id: "settings.catalog.permissions.searchTerms",
      message: "permission | tools | allow | deny",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.permissions.row.mode", message: "Permission Mode" },
      { id: "settings.catalog.permissions.row.smartAllow", message: "Smart Allow" },
    ],
  },
  sandbox: {
    label: { id: "settings.catalog.sandbox.label", message: "Sandbox" },
    description: {
      id: "settings.catalog.sandbox.description",
      message: "Sandbox backend status and fallback behavior.",
    },
    searchTerms: {
      id: "settings.catalog.sandbox.searchTerms",
      message: "sandbox | isolation | fallback",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  "control-profile": {
    label: { id: "settings.catalog.controlProfile.label", message: "Control Profile" },
    description: {
      id: "settings.catalog.controlProfile.description",
      message: "Resolved access profile applied to sessions and agents.",
    },
    searchTerms: {
      id: "settings.catalog.controlProfile.searchTerms",
      message: "control profile | guarded | autonomous | full access",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  questions: {
    label: { id: "settings.catalog.questions.label", message: "Questions" },
    description: { id: "settings.catalog.questions.description", message: "Question timeout behavior." },
    searchTerms: {
      id: "settings.catalog.questions.searchTerms",
      message: "question | timeout | prompt",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [{ id: "settings.catalog.questions.row.responseTimeout", message: "Response Timeout" }],
  },
  compaction: {
    label: { id: "settings.catalog.compaction.label", message: "Compaction" },
    description: {
      id: "settings.catalog.compaction.description",
      message: "Session compaction and history limits.",
    },
    searchTerms: {
      id: "settings.catalog.compaction.searchTerms",
      message: "compaction | context | history",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.compaction.row.autoCompact", message: "Auto Compact" },
      { id: "settings.catalog.compaction.row.overflowThreshold", message: "Overflow Threshold" },
      { id: "settings.catalog.compaction.row.maxHistoryImages", message: "Max History Images" },
    ],
  },
  timeouts: {
    label: { id: "settings.catalog.timeouts.label", message: "Agents" },
    description: {
      id: "settings.catalog.timeouts.description",
      message: "Agent prompt behavior, subagent concurrency, provider timeouts, and tool timeout controls.",
    },
    searchTerms: {
      id: "settings.catalog.timeouts.searchTerms",
      message: "agent | subagent | concurrency | timeout | provider | tool | coauthor | commit | git | prompt",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [{ id: "settings.catalog.timeouts.row.maxConcurrentSubagents", message: "Max Concurrent Subagents" }],
  },
  "code-checks": {
    label: { id: "settings.catalog.codeChecks.label", message: "Code Checks" },
    description: {
      id: "settings.catalog.codeChecks.description",
      message: "Diagnostic feedback returned after file-writing tools complete.",
    },
    searchTerms: {
      id: "settings.catalog.codeChecks.searchTerms",
      message: "code | checks | lsp | diagnostics | severity | scope | write | edit",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.catalog.codeChecks.row.includeDiagnostics", message: "Include Diagnostics" },
      { id: "settings.catalog.codeChecks.row.diagnosticSeverity", message: "Diagnostic Severity" },
      { id: "settings.catalog.codeChecks.row.diagnosticScope", message: "Diagnostic Scope" },
    ],
  },
  formatter: {
    label: { id: "settings.catalog.formatter.label", message: "Formatter" },
    description: {
      id: "settings.catalog.formatter.description",
      message: "Formatter configuration file access.",
    },
    searchTerms: {
      id: "settings.catalog.formatter.searchTerms",
      message: "formatter | format",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  lsp: {
    label: { id: "settings.catalog.lsp.label", message: "LSP" },
    description: {
      id: "settings.catalog.lsp.description",
      message: "Language server configuration file access.",
    },
    searchTerms: {
      id: "settings.catalog.lsp.searchTerms",
      message: "lsp | language server",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  observability: {
    label: { id: "settings.catalog.observability.label", message: "Observability" },
    description: {
      id: "settings.catalog.observability.description",
      message: "Raw logs, traces, telemetry collection, and runtime configuration.",
    },
    searchTerms: {
      id: "settings.catalog.observability.searchTerms",
      message: "log | trace | telemetry | collection",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  import: {
    label: { id: "settings.catalog.import.label", message: "Import" },
    description: { id: "settings.catalog.import.description", message: "Import selected config domains." },
    searchTerms: {
      id: "settings.catalog.import.searchTerms",
      message: "import | config",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  "config-files": {
    label: { id: "settings.catalog.configFiles.label", message: "Config Files" },
    description: {
      id: "settings.catalog.configFiles.description",
      message: "Open canonical config domain files.",
    },
    searchTerms: {
      id: "settings.catalog.configFiles.searchTerms",
      message: "config | files | path | jsonc",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  "archived-sessions": {
    label: { id: "settings.catalog.archivedSessions.label", message: "Archived Sessions" },
    description: {
      id: "settings.catalog.archivedSessions.description",
      message: "Browse and permanently delete archived sessions.",
    },
    searchTerms: {
      id: "settings.catalog.archivedSessions.searchTerms",
      message: "archive | archived | session | delete | history | project",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  worktrees: {
    label: { id: "settings.catalog.worktrees.label", message: "Worktrees" },
    description: {
      id: "settings.catalog.worktrees.description",
      message: "Browse and remove git worktrees across project scopes.",
    },
    searchTerms: {
      id: "settings.catalog.worktrees.searchTerms",
      message: "worktree | git | checkout | branch | delete | project",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
} satisfies Record<BuiltinSettingsId, SettingsCopyDefinition>

export const BUILTIN_SETTINGS_SECTIONS: SettingsCatalogSection[] = [
  section("account", "personal", 10, "settings.account", ["holos"]),
  section("personalize", "personal", 20, "settings.personalize"),
  section("general", "core", 10, "settings.general", ["general"]),
  section("models", "core", 20, "settings.models", ["models"]),
  section("providers", "core", 50, "providers.main", ["providers"]),
  section("usage", "core", 60, "settings.usage", ["providers"]),
  section("github", "integrations", 5, "github.main", ["providers"]),
  section("learning", "library", 10, "settings.learning", ["library"]),
  section("memory", "library", 20, "memory.main", ["library", "general"]),
  section("experience", "library", 30, "experience.main", ["library"]),
  section("mcp", "integrations", 10, "mcp.main", ["mcp"]),
  section("channels", "integrations", 20, "channels.main", ["channels"]),
  section("email", "integrations", 30, "email.main", ["email"]),
  section("permissions", "safety", 10, "settings.permissions", ["permissions"]),
  section("sandbox", "safety", 20, "settings.sandbox", ["permissions"]),
  section("control-profile", "safety", 30, "settings.controlProfile", ["permissions"]),
  section("questions", "runtime", 10, "settings.questions", ["runtime"]),
  section("compaction", "runtime", 20, "settings.compaction", ["runtime"]),
  section("timeouts", "runtime", 30, "settings.timeouts", ["runtime", "agents"]),
  section("code-checks", "runtime", 40, "settings.diagnostics", ["runtime"]),
  section("formatter", "runtime", 50, "settings.formatter", { visibility: "developer" }),
  section("lsp", "runtime", 60, "lsp.main", { visibility: "developer" }),
  section("observability", "runtime", 70, "settings.observability", {
    domainIds: ["general", "runtime"],
    visibility: "developer",
  }),
  section("import", "system", 10, "settings.import"),
  section("config-files", "system", 20, "settings.configFiles"),
  section("archived-sessions", "system", 30, "session.archive"),
  section("worktrees", "system", 40, "workspace.worktree"),
]

function section(
  id: BuiltinSettingsId,
  groupKey: SettingsGroupKey,
  order: number,
  iconToken: SemanticIconTokenName,
  domainIdsOrOptions: string[] | { domainIds?: string[]; visibility?: "standard" | "developer" } = [],
): SettingsCatalogSection {
  const definition: SettingsCopyDefinition = BUILTIN_SETTINGS_COPY[id]
  const group = SETTINGS_GROUP_COPY[groupKey]
  const domainIds = Array.isArray(domainIdsOrOptions) ? domainIdsOrOptions : (domainIdsOrOptions.domainIds ?? [])
  const visibility = Array.isArray(domainIdsOrOptions) ? undefined : domainIdsOrOptions.visibility
  const rowLabels = definition.rowLabels ?? []
  const copy: SettingsCatalogCopy = { ...definition, group, rowLabels }

  return {
    id,
    label: defaultMessage(copy.label),
    group: defaultMessage(copy.group),
    groupKey,
    order,
    iconToken,
    description: defaultMessage(copy.description),
    keywords: splitSearchTerms(defaultMessage(copy.searchTerms)),
    domainIds,
    rowLabels: rowLabels.map(defaultMessage),
    visibility,
    copy,
  }
}

function defaultMessage(descriptor: MessageDescriptor): string {
  if (!descriptor.message) throw new Error(`Settings message "${descriptor.id}" is missing its English fallback`)
  return descriptor.message
}

function splitSearchTerms(value: string): string[] {
  return value.split("|").map((term) => term.trim())
}

export function getBuiltinSettingsSection(id: string): SettingsCatalogSection | undefined {
  return BUILTIN_SETTINGS_SECTIONS.find((section) => section.id === id)
}

export const FIELD_SAVE_STRATEGY: Record<string, SettingsFieldStrategy> = {
  snapshot: "auto",
  theme: "background",
  locale: "background",
  username: "background",
  toast: "background",
  model: "explicit",
  nano_model: "explicit",
  mini_model: "explicit",
  mid_model: "explicit",
  vision_model: "explicit",
  thinking_model: "explicit",
  long_context_model: "explicit",
  creative_model: "explicit",
  role_variant: "explicit",
  quick_switcher: "background",
  default_agent: "explicit",
  enabled_providers: "background",
  disabled_providers: "background",
  embedding: "explicit",
  rerank: "explicit",
  library: "explicit",
  mcp: "explicit",
  mcpDefaults: "explicit",
  plugin: "explicit",
  pluginApprovalPolicy: "explicit",
  pluginRuntimePolicy: "explicit",
  pluginMarketplace: "explicit",
  channel: "background",
  email: "explicit",
  permission: "background",
  tools: "explicit",
  controlProfile: "explicit",
  sandbox: "background",
  smartAllow: "background",
  question: "background",
  compaction: "auto",
  cortex: "background",
  timeout: "background",
  experimental: "background",
  watcher: "background",
  formatter: "explicit",
  lsp: "explicit",
  lspWriteDiagnostics: "background",
  lspDiagnostics: "background",
  logLevel: "background",
  observability: "background",
}

export function isBuiltinSettingsId(id: string): id is BuiltinSettingsId {
  return (BUILTIN_SETTINGS_IDS as readonly string[]).includes(id)
}

export function settingsGroupOrder(groupKey: string): number {
  const index = SETTINGS_GROUP_ORDER.indexOf(groupKey as SettingsGroupKey)
  return index === -1 ? SETTINGS_GROUP_ORDER.length + 1 : index
}
