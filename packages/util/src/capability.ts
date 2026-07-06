export type SynergyCapabilityRisk = "low" | "medium" | "high"
export type SynergyCapabilityRiskScope = "install" | "agent"
export const SYNERGY_CAPABILITY_CATEGORIES = [
  "tools",
  "files",
  "network",
  "data",
  "ui",
  "runtime",
  "hooks",
  "session",
  "browser",
  "identity",
  "communication",
  "platform",
] as const
export type SynergyCapabilityCategory = (typeof SYNERGY_CAPABILITY_CATEGORIES)[number]
export type SynergyCapabilitySeverity = SynergyCapabilityRisk

export interface SynergyCapabilityPermissionItem {
  key: string
  category: SynergyCapabilityCategory
  severity: SynergyCapabilitySeverity
  title: string
  description: string
  technical?: string
}

export interface RegistryPermissionItem {
  key: string
  description: string
  risk: SynergyCapabilityRisk
}

export type ManifestTool = NonNullable<NonNullable<SynergyCapabilityManifest["contributes"]>["tools"]>[number]

export interface SynergyCapabilityManifestTool {
  id?: string
  name: string
  exposure?: { mode?: string }
  capabilities?: {
    filesystem?: "none" | "read" | "write"
    shell?: boolean
    network?: boolean
    session?: "none" | "metadata" | "read"
    workspace?: "none" | "metadata" | "read"
    config?: "none" | "plugin" | "global"
  }
}

export interface SynergyCapabilityManifest {
  permissions?: {
    tools?: {
      filesystem?: "none" | "read" | "write"
      shell?: boolean
      network?: boolean
      mcp?: "none" | "invoke" | "spawn"
      task?: unknown
    }
    data?: {
      session?: "none" | "metadata" | "read"
      workspace?: "none" | "metadata" | "read"
      config?: "none" | "plugin" | "global"
      secrets?: "none" | "own"
    }
    ui?: {
      toolRenderers?: boolean
      partRenderers?: boolean
      workbenchPanels?: boolean
      appPanels?: boolean
      settings?: boolean
      messageSlots?: boolean
      themes?: boolean
      icons?: boolean
      appRoutes?: boolean
      commands?: boolean
      trustedImport?: boolean
      sandboxIframe?: boolean
    }
    hooks?: {
      promptTransform?: boolean
      compactionTransform?: boolean
      toolExecute?: "none" | "own" | "declared" | "all"
      permissionAsk?: "none" | "own" | "all"
      events?: "none" | "selected" | "all"
      eventNames?: string[]
      config?: boolean
    }
    network?: { connectDomains?: string[] }
  }
  contributes?: {
    permissions?: unknown
    tools?: SynergyCapabilityManifestTool[]
    agents?: Array<{
      name?: string
      mode?: string
      hidden?: boolean
      model?: unknown
      modelRole?: unknown
      permission?: unknown
    }>
    mcp?: unknown
    ui?: {
      toolRenderers?: unknown[]
      partRenderers?: unknown[]
      workbenchPanels?: unknown[]
      appPanels?: unknown[]
      settings?: unknown[]
      messageSlots?: unknown[]
      themes?: unknown[]
      icons?: unknown[]
      appRoutes?: unknown[]
      commands?: unknown[]
    }
  }
  lifecycle?: unknown
}

export interface SynergyCapabilityDefinition extends Omit<SynergyCapabilityPermissionItem, "key"> {
  nonBypassable?: boolean
}

export function publicToolNames(manifest: SynergyCapabilityManifest): string[] {
  return (manifest.contributes?.tools ?? [])
    .filter((tool) => tool.exposure?.mode !== "internal")
    .map((tool) => tool.name)
}

export function hasPublicTools(manifest: SynergyCapabilityManifest): boolean {
  return publicToolNames(manifest).length > 0
}

export const SYNERGY_CAPABILITY_DETAILS: Record<string, SynergyCapabilityDefinition> = {
  shell_read: {
    category: "runtime",
    severity: "low",
    title: "Run read-only shell commands",
    description: "Can run shell commands classified as read-only.",
  },
  shell: {
    category: "runtime",
    severity: "medium",
    title: "Run shell commands",
    description: "Can execute non-destructive shell commands in the current workspace.",
  },
  shell_remote_write: {
    category: "runtime",
    severity: "medium",
    title: "Run remote-write shell commands",
    description: "Can modify existing remote state outside ordinary branch/PR publication workflows.",
  },
  shell_remote_publish: {
    category: "runtime",
    severity: "medium",
    title: "Publish development changes",
    description: "Can push explicit non-protected branches or create pull requests without destructive remote updates.",
  },
  shell_destructive: {
    category: "runtime",
    severity: "high",
    title: "Run destructive shell commands",
    description: "Can run commands that may delete, overwrite, or rewrite important local state.",
    nonBypassable: true,
  },
  shell_hardline: {
    category: "runtime",
    severity: "high",
    title: "Run forbidden shell commands",
    description: "Matches shell commands that Synergy treats as a hard safety boundary.",
    nonBypassable: true,
  },
  file_write: {
    category: "files",
    severity: "medium",
    title: "Write workspace files",
    description: "Can create, modify, or delete files in your workspace.",
  },
  file_read: {
    category: "files",
    severity: "low",
    title: "Read workspace files",
    description: "Can read files and directories in your workspace.",
  },
  file_external_read: {
    category: "files",
    severity: "low",
    title: "Read external files",
    description: "Can read files outside the active workspace.",
  },
  file_external_write: {
    category: "files",
    severity: "high",
    title: "Write external files",
    description: "Can create, modify, or delete files outside the active workspace.",
    nonBypassable: true,
  },
  network_read: {
    category: "network",
    severity: "low",
    title: "Read from network",
    description: "Can fetch or search public network resources without mutating remote state.",
  },
  network_request: {
    category: "network",
    severity: "medium",
    title: "Access network",
    description: "Can make outbound network requests.",
  },
  mcp_spawn: {
    category: "runtime",
    severity: "medium",
    title: "Spawn MCP servers",
    description: "Can start and manage MCP server processes.",
    nonBypassable: true,
  },
  mcp_invoke: {
    category: "tools",
    severity: "medium",
    title: "Invoke MCP tools",
    description: "Can call tools exposed by MCP servers.",
    nonBypassable: true,
  },
  session_data: {
    category: "data",
    severity: "low",
    title: "Read session data",
    description: "Can access session metadata and message history.",
  },
  workspace_data: {
    category: "data",
    severity: "low",
    title: "Read workspace metadata",
    description: "Can access workspace metadata and directory information.",
  },
  "config:write": {
    category: "data",
    severity: "medium",
    title: "Write configuration",
    description: "Can modify global Synergy configuration values.",
  },
  "config:read": {
    category: "data",
    severity: "low",
    title: "Read configuration",
    description: "Can read Synergy configuration values.",
  },
  secrets: {
    category: "data",
    severity: "high",
    title: "Access stored credentials",
    description: "Can read stored API keys, tokens, and other credentials.",
    nonBypassable: true,
  },
  task: {
    category: "tools",
    severity: "medium",
    title: "Delegate tasks to subagents",
    description: "Can launch approved Synergy subagents from plugin tools.",
  },
  prompt_transform: {
    category: "hooks",
    severity: "high",
    title: "Transform prompts",
    description: "Can modify the system prompt and message context sent to the LLM.",
  },
  compaction_transform: {
    category: "hooks",
    severity: "high",
    title: "Transform compaction",
    description: "Can modify session compaction inputs and outputs.",
  },
  tool_execution_hook: {
    category: "hooks",
    severity: "medium",
    title: "Intercept tool execution",
    description: "Can rewrite tool arguments or outputs within its declared hook scope.",
  },
  permission_hook: {
    category: "hooks",
    severity: "high",
    title: "Override permission decisions",
    description: "Can allow or deny permission requests within its declared hook scope.",
  },
  event_hook: {
    category: "hooks",
    severity: "medium",
    title: "Subscribe to Synergy events",
    description: "Can receive approved Synergy runtime events.",
  },
  config_hook: {
    category: "hooks",
    severity: "medium",
    title: "Observe runtime config",
    description: "Can receive redacted runtime configuration snapshots when Synergy starts or reloads config.",
  },
  session_state: {
    category: "session",
    severity: "low",
    title: "Update session state",
    description: "Can update local session coordination state.",
  },
  browser_interact: {
    category: "browser",
    severity: "medium",
    title: "Interact with browser",
    description: "Can click, type, scroll, or otherwise interact with the browser workspace.",
  },
  browser_inspect: {
    category: "browser",
    severity: "low",
    title: "Inspect browser",
    description: "Can inspect browser page state, screenshots, console, or network metadata.",
  },
  browser_eval_readonly: {
    category: "browser",
    severity: "medium",
    title: "Evaluate read-only browser code",
    description: "Can run read-only JavaScript inspection in the browser workspace.",
  },
  browser_eval_trusted: {
    category: "browser",
    severity: "high",
    title: "Evaluate trusted browser code",
    description: "Can run privileged JavaScript in the browser workspace.",
    nonBypassable: true,
  },
  browser_clipboard: {
    category: "browser",
    severity: "medium",
    title: "Use browser clipboard",
    description: "Can read from or write to browser clipboard state.",
  },
  browser_download: {
    category: "browser",
    severity: "medium",
    title: "Download browser files",
    description: "Can download files through the browser workspace.",
  },
  browser_viewport: {
    category: "browser",
    severity: "low",
    title: "Resize browser viewport",
    description: "Can change the browser workspace viewport.",
  },
  identity_act: {
    category: "identity",
    severity: "high",
    title: "Act as an identity",
    description: "Can perform actions under a user or agent identity.",
    nonBypassable: true,
  },
  communication_email: {
    category: "communication",
    severity: "high",
    title: "Use email",
    description: "Can read or send email through configured accounts.",
    nonBypassable: true,
  },
  channel_outbound: {
    category: "communication",
    severity: "high",
    title: "Send outbound channel messages",
    description: "Can send messages through configured external channels.",
    nonBypassable: true,
  },
  platform_control: {
    category: "platform",
    severity: "high",
    title: "Control platform integrations",
    description: "Can modify or control platform-level integrations.",
    nonBypassable: true,
  },
  protected_op: {
    category: "platform",
    severity: "high",
    title: "Protected operation",
    description: "Touches a protected Synergy safety boundary.",
    nonBypassable: true,
  },
}

export const SYNERGY_PROFILE_CAPABILITIES = [
  "file_read",
  "file_write",
  "shell_read",
  "shell",
  "shell_remote_write",
  "shell_remote_publish",
  "shell_destructive",
  "shell_hardline",
  "file_external_read",
  "file_external_write",
  "network_read",
  "network_request",
  "mcp_invoke",
  "mcp_spawn",
  "session_data",
  "workspace_data",
  "config:read",
  "config:write",
  "secrets",
  "task",
  "prompt_transform",
  "compaction_transform",
  "tool_execution_hook",
  "permission_hook",
  "event_hook",
  "config_hook",
  "identity_act",
  "communication_email",
  "channel_outbound",
  "platform_control",
  "protected_op",
  "session_state",
  "browser_interact",
  "browser_inspect",
  "browser_eval_readonly",
  "browser_eval_trusted",
  "browser_clipboard",
  "browser_download",
  "browser_viewport",
] as const

export const SYNERGY_PERMISSION_CAPABILITY: Record<string, string> = {
  read: "file_read",
  view_file: "file_read",
  scan_files: "file_read",
  parse_code: "file_read",
  grep: "file_read",
  file_search: "file_read",
  glob: "file_read",
  list: "file_read",
  edit: "file_write",
  write: "file_write",
  revise_file: "file_write",
  save_file: "file_write",
  bash: "shell",
  external_directory: "file_external_read",
  webfetch: "network_read",
  websearch: "network_read",
  arxiv_search: "network_read",
  arxiv_download: "network_read",
  download: "network_read",
  network_request: "network_request",
  scan_document: "file_read",
  look_at: "file_read",
  view_image: "file_read",
  attach: "file_read",
  ast_grep: "file_read",
  lsp: "file_read",
  dagread: "file_read",
  todoread: "file_read",
  task_list: "file_read",
  task_output: "file_read",
  question: "file_read",
  skill: "file_read",
  render: "file_read",
  diagram: "file_read",
  agenda_list: "file_read",
  agenda_logs: "file_read",
  session_list: "file_read",
  session_search: "file_read",
  session_read: "file_read",
  note_list: "file_read",
  note_search: "file_read",
  note_read: "file_read",
  memory_search: "file_read",
  memory_get: "file_read",
  worktree_list: "file_read",
  dagwrite: "session_state",
  dagpatch: "session_state",
  todowrite: "session_state",
  task_cancel: "session_state",
  batch: "session_state",
  doom_loop: "session_state",
  worktree_enter: "file_write",
  worktree_leave: "file_write",
  session_data: "session_data",
  workspace_data: "workspace_data",
  "config:read": "config:read",
  "config:write": "config:write",
  secrets: "secrets",
  email_read: "communication_email",
  email_send: "communication_email",
  communication_email: "communication_email",
  session_send: "channel_outbound",
  channel_outbound: "channel_outbound",
  identity_act: "identity_act",
  platform_control: "platform_control",
}

export function permissionCapability(permission: string): string {
  return SYNERGY_PERMISSION_CAPABILITY[permission] ?? permission
}

export function capabilityNonBypassable(capability: string): boolean {
  return SYNERGY_CAPABILITY_DETAILS[capability]?.nonBypassable === true
}

export function capabilityRisk(capability: string, manifest?: SynergyCapabilityManifest): SynergyCapabilityRisk {
  if (capability === "network_request" && manifest) {
    return (manifest.permissions?.network?.connectDomains ?? []).length > 0 ? "medium" : "high"
  }
  const details = SYNERGY_CAPABILITY_DETAILS[capability]
  if (details) return details.severity
  return "high"
}

function maxRisk(current: SynergyCapabilityRisk, next: SynergyCapabilityRisk): SynergyCapabilityRisk {
  if (current === "high" || next === "high") return "high"
  if (current === "medium" || next === "medium") return "medium"
  return "low"
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    const result: Record<string, unknown> = {}
    for (const [key, item] of entries) {
      result[key] = sortKeys(item)
    }
    return result
  }
  return value
}

function buildCapabilitySet(
  permissions: SynergyCapabilityManifest["permissions"],
  toolOverrides?: ManifestTool["capabilities"],
): string[] {
  const caps = new Set<string>()
  const pt = permissions?.tools
  const pd = permissions?.data
  const tc = toolOverrides

  const fs = tc?.filesystem ?? pt?.filesystem ?? "none"
  if (fs === "read") caps.add("file_read")
  if (fs === "write") {
    caps.add("file_read")
    caps.add("file_write")
  }

  if (tc?.shell ?? pt?.shell ?? false) caps.add("shell")
  if (tc?.network ?? pt?.network ?? false) caps.add("network_request")

  if (pt?.mcp === "invoke") caps.add("mcp_invoke")
  if (pt?.mcp === "spawn") {
    caps.add("mcp_invoke")
    caps.add("mcp_spawn")
  }

  if (pt?.task) caps.add("task")

  const sess = tc?.session ?? pd?.session ?? "none"
  if (sess === "read") caps.add("session_data")

  const ws = tc?.workspace ?? pd?.workspace ?? "none"
  if (ws === "read") caps.add("workspace_data")

  const cfg = tc?.config ?? pd?.config ?? "none"
  if (cfg === "global") {
    caps.add("config:read")
    caps.add("config:write")
  }
  if (cfg === "plugin") caps.add("config:read")

  if (pd?.secrets === "own") caps.add("secrets")

  const hooks = permissions?.hooks
  if (hooks?.promptTransform) caps.add("prompt_transform")
  if (hooks?.compactionTransform) caps.add("compaction_transform")
  if (hooks?.config) caps.add("config_hook")
  if (hooks?.toolExecute && hooks.toolExecute !== "none") caps.add("tool_execution_hook")
  if (hooks?.permissionAsk && hooks.permissionAsk !== "none") caps.add("permission_hook")
  if (hooks?.events === "all" || (hooks?.events === "selected" && (hooks.eventNames?.length ?? 0) > 0)) {
    caps.add("event_hook")
  }

  return [...caps].sort()
}

export function baseCapabilities(manifest: SynergyCapabilityManifest): string[] {
  return buildCapabilitySet(manifest.permissions)
}

export function toolCapabilities(manifest: SynergyCapabilityManifest, tool: ManifestTool): string[] {
  return buildCapabilitySet(manifest.permissions, tool.capabilities)
}

export function publicToolCapabilities(manifest: SynergyCapabilityManifest): string[] {
  const caps = new Set<string>()
  for (const tool of manifest.contributes?.tools ?? []) {
    if (tool.exposure?.mode === "internal") continue
    for (const capability of toolCapabilities(manifest, tool)) caps.add(capability)
  }
  return [...caps].sort()
}

export function computeRisk(capabilities: string[], manifest?: SynergyCapabilityManifest): SynergyCapabilityRisk {
  if (capabilities.length === 0) return "low"

  let risk: SynergyCapabilityRisk = "low"
  for (const cap of capabilities) {
    risk = maxRisk(risk, capabilityRisk(cap, manifest))
  }

  return risk
}

export function capabilitiesForRiskScope(
  manifest: SynergyCapabilityManifest,
  scope: SynergyCapabilityRiskScope,
): string[] {
  return scope === "agent" ? publicToolCapabilities(manifest) : baseCapabilities(manifest)
}

export function pluginRisk(
  manifest: SynergyCapabilityManifest,
  input: { scope: SynergyCapabilityRiskScope },
): SynergyCapabilityRisk {
  return computeRisk(capabilitiesForRiskScope(manifest, input.scope), manifest)
}

export function toolRisk(manifest: SynergyCapabilityManifest, tool: ManifestTool): SynergyCapabilityRisk {
  return computeRisk(toolCapabilities(manifest, tool), manifest)
}

function networkPermissionItem(manifest: SynergyCapabilityManifest): SynergyCapabilityPermissionItem {
  const domains = manifest.permissions?.network?.connectDomains ?? []
  const severity = capabilityRisk("network_request", manifest)
  return {
    key: "network_request",
    category: "network",
    severity,
    title: "Access network",
    description:
      domains.length > 0
        ? `Can make network requests to: ${domains.join(", ")}.`
        : "Can make outbound network requests to any domain.",
    technical: domains.length > 0 ? `domains: ${domains.join(", ")}` : undefined,
  }
}

function contributionPermissionItems(manifest: SynergyCapabilityManifest): SynergyCapabilityPermissionItem[] {
  const ui = manifest.contributes?.ui
  const perms = manifest.permissions?.ui
  const items: SynergyCapabilityPermissionItem[] = []

  if (ui?.toolRenderers || perms?.toolRenderers) {
    items.push({
      key: "ui.toolRenderers",
      category: "ui",
      severity: "low",
      title: "Custom tool renderers",
      description: "Overrides how tool outputs appear in the chat UI.",
    })
  }
  if (ui?.partRenderers || perms?.partRenderers) {
    items.push({
      key: "ui.partRenderers",
      category: "ui",
      severity: "low",
      title: "Custom part renderers",
      description: "Overrides how message parts appear in the chat UI.",
    })
  }
  if (ui?.workbenchPanels || perms?.workbenchPanels) {
    items.push({
      key: "ui.workbenchPanels",
      category: "ui",
      severity: "low",
      title: "Workbench panels",
      description: "Adds custom panels to the side workspace or BottomSpace.",
    })
  }
  if (ui?.appPanels || perms?.appPanels) {
    items.push({
      key: "ui.appPanels",
      category: "ui",
      severity: "low",
      title: "App panels",
      description: "Adds top-level sidebar panels to the app.",
    })
  }
  if (ui?.settings || perms?.settings) {
    items.push({
      key: "ui.settings",
      category: "ui",
      severity: "low",
      title: "Settings page",
      description: "Adds a custom settings page or form.",
    })
  }
  if (ui?.themes || perms?.themes) {
    items.push({
      key: "ui.themes",
      category: "ui",
      severity: "low",
      title: "Custom themes",
      description: "Adds custom color themes to the UI.",
    })
  }
  if (ui?.icons || perms?.icons) {
    items.push({
      key: "ui.icons",
      category: "ui",
      severity: "low",
      title: "Custom icons",
      description: "Adds custom icon sets to the UI.",
    })
  }
  if (ui?.messageSlots || perms?.messageSlots) {
    items.push({
      key: "ui.messageSlots",
      category: "ui",
      severity: "low",
      title: "Message slots",
      description: "Adds custom components around reasoning and tool timeline sections.",
    })
  }
  if (ui?.appRoutes || perms?.appRoutes) {
    items.push({
      key: "ui.appRoutes",
      category: "ui",
      severity: "low",
      title: "App routes",
      description: "Adds custom plugin pages to the app.",
    })
  }
  if (ui?.commands || perms?.commands) {
    items.push({
      key: "ui.commands",
      category: "ui",
      severity: "low",
      title: "Custom commands",
      description: "Adds custom UI commands to the command palette.",
    })
  }

  return items
}

function dataPermissionItems(manifest: SynergyCapabilityManifest): SynergyCapabilityPermissionItem[] {
  const data = manifest.permissions?.data
  const items: SynergyCapabilityPermissionItem[] = []
  if (data?.session === "read") {
    items.push({
      key: "data.session",
      category: "data",
      severity: "medium",
      title: "Read session data",
      description: "Can access session history and metadata across all sessions.",
    })
  } else if (data?.session === "metadata") {
    items.push({
      key: "data.session",
      category: "data",
      severity: "low",
      title: "Read session metadata",
      description: "Can access session metadata but not message content.",
    })
  }
  if (data?.workspace === "read") {
    items.push({
      key: "data.workspace",
      category: "data",
      severity: "low",
      title: "Read workspace metadata",
      description: "Can access workspace metadata and directory information.",
    })
  }
  if (data?.secrets === "own") {
    items.push({
      key: "data.secrets",
      category: "data",
      severity: "high",
      title: "Own credential store",
      description: "Can read and write its own stored credentials.",
    })
  }
  return items
}

function hookPermissionItems(manifest: SynergyCapabilityManifest): SynergyCapabilityPermissionItem[] {
  const hooks = manifest.permissions?.hooks
  const items: SynergyCapabilityPermissionItem[] = []
  if (hooks?.promptTransform) {
    items.push({
      key: "hooks.promptTransform",
      category: "hooks",
      severity: "high",
      title: "Transform prompts",
      description: "Can modify the system prompt and message context sent to the LLM.",
    })
  }
  if (hooks?.config) {
    items.push({
      key: "hooks.config",
      category: "hooks",
      severity: "medium",
      title: "Observe runtime config",
      description: "Can observe redacted runtime configuration snapshots when Synergy starts or reloads config.",
    })
  }
  if (hooks?.toolExecute === "all") {
    items.push({
      key: "hooks.toolExecute",
      category: "hooks",
      severity: "medium",
      title: "Intercept all tool execution",
      description: "Can rewrite arguments and outputs for all tool calls, including from other plugins.",
    })
  } else if (hooks?.toolExecute === "declared") {
    items.push({
      key: "hooks.toolExecute",
      category: "hooks",
      severity: "low",
      title: "Intercept declared tool execution",
      description: "Can rewrite arguments and outputs for tools declared in its manifest.",
    })
  } else if (hooks?.toolExecute === "own") {
    items.push({
      key: "hooks.toolExecute",
      category: "hooks",
      severity: "low",
      title: "Intercept own tool execution",
      description: "Can rewrite arguments and outputs for its own tool calls.",
    })
  }
  if (hooks?.permissionAsk === "all") {
    items.push({
      key: "hooks.permissionAsk",
      category: "hooks",
      severity: "high",
      title: "Override all permission decisions",
      description: "Can allow or deny any permission request, including from other plugins.",
    })
  } else if (hooks?.permissionAsk === "own") {
    items.push({
      key: "hooks.permissionAsk",
      category: "hooks",
      severity: "medium",
      title: "Override own permission decisions",
      description: "Can allow or deny its own permission requests.",
    })
  }
  return items
}

export function permissionItems(
  manifest: SynergyCapabilityManifest,
  capabilities: string[],
): SynergyCapabilityPermissionItem[] {
  const items: SynergyCapabilityPermissionItem[] = []
  const seen = new Set<string>()
  const add = (item: SynergyCapabilityPermissionItem) => {
    if (seen.has(item.key)) return
    seen.add(item.key)
    items.push(item)
  }

  for (const capability of capabilities) {
    if (capability === "network_request") {
      add(networkPermissionItem(manifest))
      continue
    }
    const details = SYNERGY_CAPABILITY_DETAILS[capability]
    if (details) add({ key: capability, ...details })
  }

  for (const item of contributionPermissionItems(manifest)) add(item)
  for (const item of dataPermissionItems(manifest)) add(item)
  for (const item of hookPermissionItems(manifest)) add(item)
  return items
}

export function registryPermissionSummary(
  manifest: SynergyCapabilityManifest,
  capabilities: string[],
): RegistryPermissionItem[] {
  return permissionItems(manifest, capabilities).map((item) => ({
    key: item.key,
    description: item.description,
    risk: item.severity,
  }))
}

export function permissionCategoryForKey(key: string): SynergyCapabilityCategory {
  const details = SYNERGY_CAPABILITY_DETAILS[key]
  if (details) return details.category
  if (key.startsWith("ui.")) return "ui"
  if (key.startsWith("hooks.")) return "hooks"
  if (key.startsWith("data.")) return "data"
  if (key.startsWith("runtime.")) return "runtime"
  if (key.startsWith("session.")) return "session"
  if (key.startsWith("browser.")) return "browser"
  return "tools"
}

export function permissionsHashPayload(manifest: SynergyCapabilityManifest, capabilities: string[]) {
  return {
    capabilities: [...capabilities].sort(),
    permissions: manifest.permissions ?? {},
    contributes: permissionsRelevantContributes(manifest),
    lifecycle: manifest.lifecycle ?? {},
  }
}

function permissionsRelevantContributes(manifest: SynergyCapabilityManifest) {
  const contributes = manifest.contributes
  if (!contributes) return undefined

  return {
    ...(contributes.permissions ? { permissions: contributes.permissions } : {}),
    ...(contributes.tools
      ? {
          tools: contributes.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            exposure: tool.exposure,
            capabilities: tool.capabilities,
          })),
        }
      : {}),
    ...(contributes.agents
      ? {
          agents: contributes.agents.map((agent) => ({
            name: agent.name,
            mode: agent.mode,
            hidden: agent.hidden,
            model: agent.model,
            modelRole: agent.modelRole,
            permission: agent.permission,
          })),
        }
      : {}),
    ...(contributes.mcp ? { mcp: contributes.mcp } : {}),
    ...(contributes.ui
      ? {
          ui: {
            toolRenderers: Boolean(contributes.ui.toolRenderers?.length),
            partRenderers: Boolean(contributes.ui.partRenderers?.length),
            workbenchPanels: Boolean(contributes.ui.workbenchPanels?.length),
            appPanels: Boolean(contributes.ui.appPanels?.length),
            settings: Boolean(contributes.ui.settings?.length),
            messageSlots: Boolean(contributes.ui.messageSlots?.length),
            themes: Boolean(contributes.ui.themes?.length),
            icons: Boolean(contributes.ui.icons?.length),
            appRoutes: Boolean(contributes.ui.appRoutes?.length),
            commands: Boolean(contributes.ui.commands?.length),
          },
        }
      : {}),
  }
}

export function manifestHashPayload(manifest: SynergyCapabilityManifest): SynergyCapabilityManifest {
  return manifest
}

export function stablePluginJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export type BridgeMethodPolicy =
  | { type: "capability"; capability: string }
  | { type: "unprivileged" }
  | { type: "unknown" }

export const SYNERGY_BRIDGE_METHOD_POLICY = {
  "config.get": { type: "capability", capability: "config:read" },
  "config.set": { type: "capability", capability: "config:write" },
  "config.replace": { type: "capability", capability: "config:write" },
  "secret.get": { type: "capability", capability: "secrets" },
  "secret.set": { type: "capability", capability: "secrets" },
  "secret.delete": { type: "capability", capability: "secrets" },
  "cache.get": { type: "unprivileged" },
  "cache.set": { type: "unprivileged" },
  "cache.delete": { type: "unprivileged" },
  "file.read": { type: "capability", capability: "file_read" },
  "file.write": { type: "capability", capability: "file_write" },
  "network.fetch": { type: "capability", capability: "network_request" },
  "shell.run": { type: "capability", capability: "shell" },
  "session.getMetadata": { type: "capability", capability: "session_data" },
  "workspace.getMetadata": { type: "capability", capability: "workspace_data" },
  "task.run": { type: "capability", capability: "task" },
  "tool.invoke": { type: "unprivileged" },
  "permission.request": { type: "unprivileged" },
} as const satisfies Record<string, Exclude<BridgeMethodPolicy, { type: "unknown" }>>

export function bridgeMethodPolicy(method: string): BridgeMethodPolicy {
  return SYNERGY_BRIDGE_METHOD_POLICY[method as keyof typeof SYNERGY_BRIDGE_METHOD_POLICY] ?? { type: "unknown" }
}

export function bridgeCapability(method: string): string | undefined {
  const policy = bridgeMethodPolicy(method)
  return policy.type === "capability" ? policy.capability : undefined
}
