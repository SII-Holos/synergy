import { settingsFieldCopy } from "./settings-field-copy"
import { MODEL_ROLES } from "./types"
import type { MessageDescriptor } from "@lingui/core"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

const SETTINGS_GROUP_KEYS = ["personal", "core", "library", "integrations", "safety", "runtime", "system"] as const

type SettingsGroupKey = (typeof SETTINGS_GROUP_KEYS)[number]

const SETTINGS_GROUP_COPY = {
  personal: { id: "settings.catalog.group.personal", message: "Personal preferences" },
  core: { id: "settings.catalog.group.core", message: "Models and services" },
  library: { id: "settings.catalog.group.library", message: "Knowledge and skills" },
  integrations: { id: "settings.catalog.group.integrations", message: "Connections and integrations" },
  safety: { id: "settings.catalog.group.safety", message: "Security and permissions" },
  runtime: { id: "settings.catalog.group.runtime", message: "Runtime and automation" },
  system: { id: "settings.catalog.group.system", message: "Data and system" },
} satisfies Record<SettingsGroupKey, MessageDescriptor>

export const SETTINGS_GROUP_ORDER: readonly SettingsGroupKey[] = SETTINGS_GROUP_KEYS

export type SettingsGroup = string

export const BUILTIN_SETTINGS_IDS = [
  "account",
  "personalize",
  "general",
  "models",
  "voice",
  "providers",
  "usage",
  "github",
  "learning",
  "memory",
  "experience",
  "skills",
  "mcp",
  "channels",
  "email",
  "permissions",
  "sandbox",
  "control-profile",
  "secrets",
  "questions",
  "compaction",
  "timeouts",
  "code-checks",
  "formatter",
  "lsp",
  "observability",
  "boss",
  "import",
  "config-files",
  "archived-sessions",
  "worktrees",
  "storage",
] as const

export type BuiltinSettingsId = (typeof BUILTIN_SETTINGS_IDS)[number]

export type SettingsCatalogCopy = {
  label: MessageDescriptor
  group: MessageDescriptor
  description: MessageDescriptor
  searchTerms: MessageDescriptor
  rowLabels: MessageDescriptor[]
  fieldAliases?: { label: MessageDescriptor; aliases: MessageDescriptor }[]
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
  fieldAliases?: Record<string, string[]>
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
    rowLabels: [settingsFieldCopy.customInstructions],
  },
  general: {
    fieldAliases: [
      {
        label: { id: "settings.general.colorScheme.label", message: "Color scheme" },
        aliases: {
          id: "settings.search.alias.color",
          message: "light | dark | automatic appearance | change colors",
          comment: SEARCH_TERMS_COMMENT,
        },
      },
      {
        label: { id: "settings.general.notifications.title", message: "Notifications" },
        aliases: {
          id: "settings.search.alias.notifications",
          message: "notification | toast | popup | mute | duration | toast duration",
          comment: SEARCH_TERMS_COMMENT,
        },
      },
    ],
    label: { id: "settings.catalog.general.label", message: "General" },
    description: {
      id: "settings.catalog.general.description",
      message: "Appearance, behavior, and notification preferences.",
    },
    searchTerms: {
      id: "settings.catalog.general.searchTerms",
      message:
        "appearance | color | light | dark | auto | language | font | monospace | activity | activity display | workspace | worktree | checkout | product update | toast | notification",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.general.colorScheme.label", message: "Color scheme" },
      { id: "settings.general.theme.title", message: "Theme" },
      { id: "app.plugin.shell.preference.title", message: "Workbench" },
      { id: "app.plugin.skin.preference.title", message: "Skin" },
      { id: "settings.general.zoom.title", message: "Interface zoom" },
      { id: "settings.general.font.title", message: "Interface font" },
      { id: "settings.general.monoFont.title", message: "Monospace font" },
      { id: "settings.general.language.title", message: "Interface language" },
      { id: "settings.general.activityDisplay.title", message: "Activity display" },
      { id: "settings.general.workspace.title", message: "New task starting point" },
      { id: "settings.general.welcomeGames.title", message: "New task games" },
      { id: "settings.general.updates.title", message: "Product updates" },
      { id: "settings.general.notifications.title", message: "Notifications" },
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
    rowLabels: MODEL_ROLES.map((role) => role.label),
  },
  voice: {
    fieldAliases: [
      {
        label: { id: "settings.voice.stt.title", message: "Voice input" },
        aliases: {
          id: "settings.search.alias.stt",
          message: "stt | microphone | dictation | speech recognition | audio to text",
          comment: SEARCH_TERMS_COMMENT,
        },
      },
      {
        label: { id: "settings.voice.tts.title", message: "Read answers aloud" },
        aliases: {
          id: "settings.search.alias.tts",
          message: "tts | speech synthesis | read aloud | audio preview",
          comment: SEARCH_TERMS_COMMENT,
        },
      },
    ],
    label: { id: "settings.catalog.voice.label", message: "Voice" },
    description: {
      id: "settings.catalog.voice.description",
      message: "Speech recognition and synthesis endpoints for voice input and output.",
    },
    searchTerms: {
      id: "settings.catalog.voice.searchTerms",
      message: "voice | stt | tts | speech | dictation | recognition | synthesis",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.voice.stt.title", message: "Voice input" },
      { id: "settings.voice.tts.title", message: "Read answers aloud" },
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
      message: "github | gh | issue | pull request | release | token | git identity | watch",
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
    rowLabels: [settingsFieldCopy.learningLearn, settingsFieldCopy.learningAutonomy],
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
      settingsFieldCopy.memoryMatch,
      settingsFieldCopy.memoryCount,
      settingsFieldCopy.memoryThreshold,
      settingsFieldCopy.embeddingModel,
      settingsFieldCopy.embeddingSource,
      settingsFieldCopy.embeddingFiles,
      settingsFieldCopy.embeddingOrigin,
      settingsFieldCopy.embeddingCache,
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
      settingsFieldCopy.experienceMatch,
      settingsFieldCopy.experienceCount,
      settingsFieldCopy.experienceExploration,
      settingsFieldCopy.experienceThreshold,
      settingsFieldCopy.experienceProbability,
      settingsFieldCopy.encodingHealth,
    ],
  },
  skills: {
    label: { id: "settings.catalog.skills.label", message: "Skills" },
    description: {
      id: "settings.catalog.skills.description",
      message: "Skill discovery compatibility with other agent tools.",
    },
    searchTerms: {
      id: "settings.catalog.skills.searchTerms",
      message: "skill | skills | claude | codex | openclaw | agents | compatibility",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      settingsFieldCopy.skillsAgents,
      settingsFieldCopy.skillsClaude,
      settingsFieldCopy.skillsCodex,
      settingsFieldCopy.skillsOpenclaw,
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
      message: "channel | feishu | github | messaging",
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
      { id: "settings.permissions.modeRow.title", message: "Permission Mode" },
      { id: "settings.permissions.smartAllow.title", message: "Smart Allow" },
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
  secrets: {
    label: { id: "settings.catalog.secrets.label", message: "Secrets" },
    description: {
      id: "settings.catalog.secrets.description",
      message: "Registered secrets masked from model context, resolved at execution.",
    },
    searchTerms: {
      id: "settings.catalog.secrets.searchTerms",
      message: "secret | vault | api key | token | mask | credential",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  questions: {
    label: { id: "settings.catalog.questions.label", message: "Waiting for response" },
    description: {
      id: "settings.catalog.questions.description",
      message: "Choose how long unanswered questions remain open.",
    },
    searchTerms: {
      id: "settings.catalog.questions.searchTerms",
      message: "question | timeout | prompt",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [settingsFieldCopy.questionResponse],
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
      settingsFieldCopy.compactionAuto,
      settingsFieldCopy.compactionOverflow,
      settingsFieldCopy.compactionImages,
    ],
  },
  timeouts: {
    label: { id: "settings.catalog.timeouts.label", message: "Agent runtime" },
    description: {
      id: "settings.catalog.timeouts.description",
      message: "Agent worker capacity, subagent concurrency, provider timeouts, and tool timeout controls.",
    },
    searchTerms: {
      id: "settings.catalog.timeouts.searchTerms",
      message:
        "agent | worker | pool | parallel | subagent | concurrency | timeout | provider | tool | coauthor | commit | git | prompt",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      settingsFieldCopy.agentWorkers,
      settingsFieldCopy.agentConcurrency,
      settingsFieldCopy.coauthor,
      settingsFieldCopy.defaultAgent,
      settingsFieldCopy.invokeTimeout,
      settingsFieldCopy.providerTtfb,
      settingsFieldCopy.providerIdle,
      settingsFieldCopy.providerWall,
      settingsFieldCopy.toolTimeout,
      settingsFieldCopy.toolOverrides,
    ],
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
    rowLabels: [settingsFieldCopy.codeInclude, settingsFieldCopy.codeSeverity, settingsFieldCopy.codeScope],
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
    label: { id: "settings.catalog.observability.label", message: "Diagnostics" },
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
  boss: {
    label: { id: "settings.catalog.boss.label", message: "Boss Mode" },
    description: {
      id: "settings.catalog.boss.description",
      message: "Coordinate tasks and projects from one entry point.",
    },
    searchTerms: {
      id: "settings.catalog.boss.searchTerms",
      message: "boss | task | project | assistant | feishu",
      comment: SEARCH_TERMS_COMMENT,
    },
    rowLabels: [
      { id: "settings.runtime.boss.title", message: "Boss Mode" },
      settingsFieldCopy.bossPersonality,
      settingsFieldCopy.bossName,
    ],
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
      message:
        "Review project worktrees, their status and associated tasks, and clean up worktrees you no longer need.",
    },
    searchTerms: {
      id: "settings.catalog.worktrees.searchTerms",
      message: "worktree | git | checkout | branch | delete | project",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
  storage: {
    label: { id: "settings.catalog.storage.label", message: "Storage" },
    description: {
      id: "settings.catalog.storage.description",
      message: "File snapshot storage usage per project scope and the snapshot switch.",
    },
    searchTerms: {
      id: "settings.catalog.storage.searchTerms",
      message: "storage | snapshot | usage | disk | legacy | migrate | compact",
      comment: SEARCH_TERMS_COMMENT,
    },
  },
} satisfies Record<BuiltinSettingsId, SettingsCopyDefinition>

export const BUILTIN_SETTINGS_SECTIONS: SettingsCatalogSection[] = [
  section("account", "personal", 30, "settings.account", ["holos"]),
  section("personalize", "personal", 20, "settings.personalize"),
  section("general", "personal", 10, "settings.general", ["general"]),
  section("models", "core", 20, "settings.models", ["models"]),
  section("voice", "core", 25, "settings.voice", ["voice"]),
  section("providers", "core", 10, "providers.main", ["providers"]),
  section("usage", "core", 60, "settings.usage", ["providers"]),
  section("github", "integrations", 5, "github.main", ["providers", "github"]),
  section("learning", "library", 10, "settings.learning", ["library"]),
  section("memory", "library", 20, "memory.main", ["library", "general"]),
  section("experience", "library", 30, "experience.main", ["library"]),
  section("skills", "library", 40, "settings.skills", ["skills"]),
  section("mcp", "integrations", 10, "mcp.main", ["mcp"]),
  section("channels", "integrations", 20, "channels.main", ["channels"]),
  section("email", "integrations", 30, "email.main", ["email"]),
  section("permissions", "safety", 20, "settings.permissions", ["permissions"]),
  section("sandbox", "safety", 30, "settings.sandbox", ["permissions"]),
  section("control-profile", "safety", 10, "settings.controlProfile", ["permissions"]),
  section("secrets", "safety", 40, "settings.secrets", ["permissions"]),
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
  section("boss", "runtime", 80, "prompt.boss", { domainIds: ["runtime"] }),
  section("import", "system", 40, "settings.import"),
  section("config-files", "system", 50, "settings.configFiles"),
  section("archived-sessions", "system", 30, "session.archive"),
  section("worktrees", "system", 10, "workspace.worktree"),
  section("storage", "system", 20, "settings.storage", ["general"]),
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
    fieldAliases: Object.fromEntries(
      (copy.fieldAliases ?? []).map((target) => [
        defaultMessage(target.label),
        splitSearchTerms(defaultMessage(target.aliases)),
      ]),
    ),
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

export function isBuiltinSettingsId(id: string): id is BuiltinSettingsId {
  return (BUILTIN_SETTINGS_IDS as readonly string[]).includes(id)
}

export function settingsGroupOrder(groupKey: string): number {
  const index = SETTINGS_GROUP_ORDER.indexOf(groupKey as SettingsGroupKey)
  return index === -1 ? SETTINGS_GROUP_ORDER.length + 1 : index
}
