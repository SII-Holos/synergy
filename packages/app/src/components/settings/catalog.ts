import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

export const SETTINGS_GROUP_ORDER = [
  "Personal",
  "Core",
  "Library",
  "Integrations",
  "Safety",
  "Runtime",
  "System",
] as const

export type SettingsGroup = (typeof SETTINGS_GROUP_ORDER)[number] | string

export const BUILTIN_SETTINGS_IDS = [
  "account",
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
  "formatter",
  "lsp",
  "observability",
  "import",
  "config-files",
] as const

export type BuiltinSettingsId = (typeof BUILTIN_SETTINGS_IDS)[number]

export type SettingsFieldStrategy = "auto" | "background" | "explicit"

export type SettingsCatalogSection = {
  id: BuiltinSettingsId
  label: string
  group: SettingsGroup
  order: number
  iconToken: SemanticIconTokenName
  description: string
  keywords: string[]
  domainIds: string[]
  rowLabels?: string[]
  visibility?: "standard" | "developer"
}

export const BUILTIN_SETTINGS_SECTIONS: SettingsCatalogSection[] = [
  section(
    "account",
    "Account",
    "Personal",
    10,
    "settings.account",
    "Holos agent identities and local account controls.",
    ["user", "identity", "login", "holos", "agent"],
    ["holos"],
  ),
  section(
    "general",
    "General",
    "Core",
    10,
    "settings.general",
    "Appearance, behavior, and notification preferences.",
    ["appearance", "color", "light", "dark", "auto", "snapshot", "product update", "toast", "notification"],
    ["general"],
    ["Color Scheme", "Snapshot", "Product Updates", "Notifications", "Toast Duration"],
  ),
  section(
    "models",
    "Models",
    "Core",
    30,
    "settings.models",
    "Model roles used by agents and tools.",
    ["model", "provider", "role"],
    ["models"],
    ["Default Model", "Mini Model", "Vision Model", "Thinking Model"],
  ),
  section(
    "providers",
    "Providers",
    "Core",
    40,
    "settings.providers",
    "Provider availability and connection status.",
    ["provider", "api", "enabled", "disabled"],
    ["providers"],
  ),
  section(
    "usage",
    "Usage",
    "Core",
    50,
    "settings.usage",
    "Provider usage, quota windows, credits, and account health.",
    ["usage", "quota", "credits", "billing", "codex", "claude"],
    ["providers"],
  ),
  section(
    "github",
    "GitHub",
    "Integrations",
    5,
    "settings.github",
    "GitHub credentials for issues, pull requests, releases, and GitHub CLI actions.",
    ["github", "gh", "issue", "pull request", "release", "token"],
    ["providers"],
  ),
  section(
    "learning",
    "Learning",
    "Library",
    10,
    "settings.learning",
    "Library learning and autonomy controls.",
    ["library", "learning", "autonomy"],
    ["library"],
    ["Enable Learning", "Enable Autonomy"],
  ),
  section(
    "memory",
    "Memory",
    "Library",
    20,
    "settings.memory",
    "Memory retrieval and embedding configuration.",
    ["memory", "embedding", "recall"],
    ["library", "general"],
    ["Memory Similarity", "Memory per Category"],
  ),
  section(
    "experience",
    "Experience",
    "Library",
    30,
    "settings.experience",
    "Experience retrieval and exploration controls.",
    ["experience", "retrieval", "epsilon"],
    ["library"],
    ["Experience Similarity", "Experience Count", "Exploration Rate"],
  ),
  section(
    "mcp",
    "MCP",
    "Integrations",
    10,
    "settings.mcp",
    "Model Context Protocol servers and defaults.",
    ["mcp", "server", "tool"],
    ["mcp"],
  ),
  section(
    "channels",
    "Channels",
    "Integrations",
    20,
    "settings.channels",
    "External messaging channel accounts.",
    ["channel", "feishu", "messaging"],
    ["channels"],
  ),
  section(
    "email",
    "Email",
    "Integrations",
    30,
    "settings.email",
    "SMTP and IMAP settings for mail tools.",
    ["email", "smtp", "imap"],
    ["email"],
  ),
  section(
    "permissions",
    "Permissions",
    "Safety",
    10,
    "settings.permissions",
    "Default permission mode and tool toggles.",
    ["permission", "tools", "allow", "deny"],
    ["permissions"],
    ["Permission Mode", "Smart Allow"],
  ),
  section(
    "sandbox",
    "Sandbox",
    "Safety",
    20,
    "settings.sandbox",
    "Sandbox backend status and fallback behavior.",
    ["sandbox", "isolation", "fallback"],
    ["permissions"],
  ),
  section(
    "control-profile",
    "Control Profile",
    "Safety",
    30,
    "settings.controlProfile",
    "Resolved access profile applied to sessions and agents.",
    ["control profile", "guarded", "autonomous", "full access"],
    ["permissions"],
  ),
  section(
    "questions",
    "Questions",
    "Runtime",
    10,
    "settings.questions",
    "Question timeout behavior.",
    ["question", "timeout", "prompt"],
    ["runtime"],
    ["Response Timeout"],
  ),
  section(
    "compaction",
    "Compaction",
    "Runtime",
    20,
    "settings.compaction",
    "Session compaction and history limits.",
    ["compaction", "context", "history"],
    ["runtime"],
    ["Auto Compact", "Overflow Threshold", "Max History Images"],
  ),
  section(
    "timeouts",
    "Timeouts",
    "Runtime",
    30,
    "settings.timeouts",
    "Agent, provider, and tool timeout controls.",
    ["timeout", "provider", "tool"],
    ["runtime"],
  ),
  section(
    "formatter",
    "Formatter",
    "Runtime",
    40,
    "settings.formatter",
    "Formatter configuration file access.",
    ["formatter", "format"],
    { visibility: "developer" },
  ),
  section(
    "lsp",
    "LSP",
    "Runtime",
    50,
    "settings.lsp",
    "Language server configuration file access.",
    ["lsp", "language server"],
    { visibility: "developer" },
  ),
  section(
    "observability",
    "Observability",
    "Runtime",
    60,
    "settings.observability",
    "Raw logs, traces, telemetry collection, and runtime configuration.",
    ["log", "trace", "telemetry", "collection"],
    { domainIds: ["general", "runtime"], visibility: "developer" },
  ),
  section("import", "Import", "System", 10, "settings.import", "Import selected config domains.", ["import", "config"]),
  section("config-files", "Config Files", "System", 20, "settings.configFiles", "Open canonical config domain files.", [
    "config",
    "files",
    "path",
    "jsonc",
  ]),
]

function section(
  id: BuiltinSettingsId,
  label: string,
  group: SettingsGroup,
  order: number,
  iconToken: SemanticIconTokenName,
  description: string,
  keywords: string[],
  domainIdsOrOpts?: string[] | { domainIds?: string[]; rowLabels?: string[]; visibility?: "standard" | "developer" },
  rowLabels?: string[],
): SettingsCatalogSection {
  let domainIds: string[] = []
  let visibility: "standard" | "developer" | undefined
  let actualRowLabels: string[] = rowLabels ?? []

  if (Array.isArray(domainIdsOrOpts)) {
    domainIds = domainIdsOrOpts
  } else if (domainIdsOrOpts) {
    domainIds = domainIdsOrOpts.domainIds ?? []
    actualRowLabels = domainIdsOrOpts.rowLabels ?? actualRowLabels
    visibility = domainIdsOrOpts.visibility
  }

  return {
    id,
    label,
    group,
    order,
    iconToken,
    description,
    keywords,
    domainIds,
    rowLabels: actualRowLabels,
    visibility,
  }
}

export const FIELD_SAVE_STRATEGY: Record<string, SettingsFieldStrategy> = {
  snapshot: "auto",
  theme: "background",
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
  timeout: "background",
  watcher: "background",
  formatter: "explicit",
  lsp: "explicit",
  logLevel: "background",
  observability: "background",
}

export function isBuiltinSettingsId(id: string): id is BuiltinSettingsId {
  return (BUILTIN_SETTINGS_IDS as readonly string[]).includes(id)
}

export function settingsGroupOrder(group: string): number {
  const index = SETTINGS_GROUP_ORDER.indexOf(group as never)
  return index === -1 ? SETTINGS_GROUP_ORDER.length + 1 : index
}
