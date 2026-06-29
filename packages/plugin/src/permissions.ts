import type { PluginManifest } from "./manifest"

export type PluginRisk = "low" | "medium" | "high"
export type PluginPermissionCategory = "tools" | "files" | "network" | "data" | "ui" | "runtime" | "hooks"
export type PluginPermissionSeverity = PluginRisk

export interface PluginPermissionItem {
  key: string
  category: PluginPermissionCategory
  severity: PluginPermissionSeverity
  title: string
  description: string
  technical?: string
}

export interface RegistryPermissionItem {
  key: string
  description: string
  risk: PluginRisk
}

type ManifestTool = NonNullable<NonNullable<PluginManifest["contributes"]>["tools"]>[number]

const CAPABILITY_DETAILS: Record<string, Omit<PluginPermissionItem, "key">> = {
  shell: {
    category: "runtime",
    severity: "high",
    title: "Run shell commands",
    description: "Can execute arbitrary shell commands on your system, including spawning child processes.",
  },
  file_write: {
    category: "files",
    severity: "high",
    title: "Write workspace files",
    description: "Can create, modify, or delete files in your workspace.",
  },
  file_read: {
    category: "files",
    severity: "medium",
    title: "Read workspace files",
    description: "Can read files and directories in your workspace.",
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
  },
  mcp_invoke: {
    category: "tools",
    severity: "medium",
    title: "Invoke MCP tools",
    description: "Can call tools exposed by MCP servers.",
  },
  session_data: {
    category: "data",
    severity: "medium",
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
}

const NON_BYPASSABLE_CAPABILITIES = new Set(["mcp_invoke", "mcp_spawn", "secrets", "permission_hook"])

export function capabilityNonBypassable(capability: string): boolean {
  return NON_BYPASSABLE_CAPABILITIES.has(capability)
}

export function capabilityRisk(capability: string): PluginRisk {
  const details = CAPABILITY_DETAILS[capability]
  if (details) return details.severity
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
  permissions: PluginManifest["permissions"],
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

  const cfg = tc?.config ?? pd?.config ?? "plugin"
  if (cfg === "global") {
    caps.add("config:read")
    caps.add("config:write")
  }
  if (cfg === "plugin") caps.add("config:read")

  if (pd?.secrets === "own") caps.add("secrets")

  const hooks = permissions?.hooks
  if (hooks?.promptTransform) caps.add("prompt_transform")
  if (hooks?.compactionTransform) caps.add("compaction_transform")
  if (hooks?.toolExecute && hooks.toolExecute !== "none") caps.add("tool_execution_hook")
  if (hooks?.permissionAsk && hooks.permissionAsk !== "none") caps.add("permission_hook")
  if (hooks?.events === "all" || (hooks?.events === "selected" && (hooks.eventNames?.length ?? 0) > 0)) {
    caps.add("event_hook")
  }

  return [...caps].sort()
}

export function baseCapabilities(manifest: PluginManifest): string[] {
  return buildCapabilitySet(manifest.permissions)
}

export function toolCapabilities(manifest: PluginManifest, tool: ManifestTool): string[] {
  return buildCapabilitySet(manifest.permissions, tool.capabilities)
}

export function computeRisk(capabilities: string[], manifest?: PluginManifest): PluginRisk {
  if (capabilities.length === 0) return "low"

  let risk: PluginRisk = "low"

  for (const cap of capabilities) {
    switch (cap) {
      case "shell":
      case "file_write":
      case "secrets":
      case "prompt_transform":
      case "compaction_transform":
      case "permission_hook":
        risk = "high"
        break
      case "file_read":
      case "mcp_invoke":
      case "mcp_spawn":
      case "session_data":
      case "config:write":
      case "task":
      case "tool_execution_hook":
      case "event_hook":
        if (risk !== "high") risk = "medium"
        break
      case "network_request":
        if (risk === "high") break
        risk = (manifest?.permissions?.network?.connectDomains ?? []).length > 0 ? "medium" : "high"
        break
      default:
        break
    }
  }

  return risk
}

function networkPermissionItem(manifest: PluginManifest): PluginPermissionItem {
  const domains = manifest.permissions?.network?.connectDomains ?? []
  return {
    key: "network_request",
    category: "network",
    severity: domains.length > 0 ? "medium" : "high",
    title: "Access network",
    description:
      domains.length > 0
        ? `Can make network requests to: ${domains.join(", ")}.`
        : "Can make outbound network requests to any domain.",
    technical: domains.length > 0 ? `domains: ${domains.join(", ")}` : undefined,
  }
}

function contributionPermissionItems(manifest: PluginManifest): PluginPermissionItem[] {
  const ui = manifest.contributes?.ui
  const perms = manifest.permissions?.ui
  const items: PluginPermissionItem[] = []

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
  if (ui?.workspacePanels || perms?.workspacePanels) {
    items.push({
      key: "ui.workspacePanels",
      category: "ui",
      severity: "low",
      title: "Workspace panels",
      description: "Adds custom panels to the workspace view.",
    })
  }
  if (ui?.globalPanels || perms?.globalPanels) {
    items.push({
      key: "ui.globalPanels",
      category: "ui",
      severity: "low",
      title: "Global panels",
      description: "Adds custom panels visible across all workspaces.",
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
  if (ui?.routes || perms?.routes) {
    items.push({
      key: "ui.routes",
      category: "ui",
      severity: "low",
      title: "Custom routes",
      description: "Adds custom pages and routes to the app.",
    })
  }
  if (ui?.commands) {
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

function dataPermissionItems(manifest: PluginManifest): PluginPermissionItem[] {
  const data = manifest.permissions?.data
  const items: PluginPermissionItem[] = []
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

function hookPermissionItems(manifest: PluginManifest): PluginPermissionItem[] {
  const hooks = manifest.permissions?.hooks
  const items: PluginPermissionItem[] = []
  if (hooks?.promptTransform) {
    items.push({
      key: "hooks.promptTransform",
      category: "hooks",
      severity: "high",
      title: "Transform prompts",
      description: "Can modify the system prompt and message context sent to the LLM.",
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

export function permissionItems(manifest: PluginManifest, capabilities: string[]): PluginPermissionItem[] {
  const items: PluginPermissionItem[] = []
  const seen = new Set<string>()
  const add = (item: PluginPermissionItem) => {
    if (seen.has(item.key)) return
    seen.add(item.key)
    items.push(item)
  }

  for (const capability of capabilities) {
    if (capability === "network_request") {
      add(networkPermissionItem(manifest))
      continue
    }
    const details = CAPABILITY_DETAILS[capability]
    if (details) add({ key: capability, ...details })
  }

  for (const item of contributionPermissionItems(manifest)) add(item)
  for (const item of dataPermissionItems(manifest)) add(item)
  for (const item of hookPermissionItems(manifest)) add(item)
  return items
}

export function registryPermissionSummary(manifest: PluginManifest, capabilities: string[]): RegistryPermissionItem[] {
  return permissionItems(manifest, capabilities).map((item) => ({
    key: item.key,
    description: item.description,
    risk: item.severity,
  }))
}

export function permissionsHashPayload(manifest: PluginManifest, capabilities: string[]) {
  return {
    capabilities: [...capabilities].sort(),
    permissions: manifest.permissions ?? {},
    contributes: manifest.contributes ?? {},
    lifecycle: manifest.lifecycle ?? {},
  }
}

export function manifestHashPayload(manifest: PluginManifest): PluginManifest {
  return manifest
}

export function stablePluginJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}
