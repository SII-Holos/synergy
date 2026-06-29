import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PermissionItem } from "./schema"

const CAPABILITY_MAP: Record<string, Omit<PermissionItem, "key">> = {
  shell: {
    category: "runtime",
    severity: "high",
    title: "Run shell commands",
    description: "Can execute arbitrary shell commands on your system, including spawning child processes.",
  },
  "filesystem:write": {
    category: "files",
    severity: "high",
    title: "Write workspace files",
    description: "Can create, modify, or delete files in your workspace.",
  },
  "filesystem:read": {
    category: "files",
    severity: "medium",
    title: "Read workspace files",
    description: "Can read files and directories in your workspace.",
  },
  network: {
    category: "network",
    severity: "medium",
    title: "Access network",
    description: "Can make outbound network requests.",
  },
  "mcp:spawn": {
    category: "runtime",
    severity: "medium",
    title: "Spawn MCP servers",
    description: "Can start and manage MCP server processes.",
  },
  "mcp:invoke": {
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
}

function buildNetworkItem(manifest: PluginManifest): PermissionItem | null {
  const domains = manifest.permissions?.network?.connectDomains ?? []
  const desc =
    domains.length > 0
      ? `Can make network requests to: ${domains.join(", ")}.`
      : "Can make outbound network requests to any domain."

  return {
    key: "network",
    category: "network",
    severity: domains.length > 0 ? "medium" : "high",
    title: "Access network",
    description: desc,
    technical: domains.length > 0 ? `domains: ${domains.join(", ")}` : undefined,
  }
}

function buildUIItems(manifest: PluginManifest): PermissionItem[] {
  const ui = manifest.contributes?.ui
  const perms = manifest.permissions?.ui
  const items: PermissionItem[] = []

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
      description: "Overrides how message parts (text, tool calls, etc.) appear in the chat UI.",
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

function buildDataItems(manifest: PluginManifest): PermissionItem[] {
  const items: PermissionItem[] = []
  const data = manifest.permissions?.data

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
      description: "Can access session metadata (titles, timestamps) but not message content.",
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

function buildHookItems(manifest: PluginManifest): PermissionItem[] {
  const items: PermissionItem[] = []
  const hooks = manifest.permissions?.hooks

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

/**
 * Generate user-language permission items from a plugin manifest and its
 * resolved capability strings.
 */
export function generatePermissionItems(manifest: PluginManifest, capabilities: string[]): PermissionItem[] {
  const items: PermissionItem[] = []
  const seen = new Set<string>()

  for (const cap of capabilities) {
    if (cap === "network") {
      const netItem = buildNetworkItem(manifest)
      if (netItem && !seen.has(netItem.key)) {
        seen.add(netItem.key)
        items.push(netItem)
      }
      continue
    }

    const mapped = CAPABILITY_MAP[cap]
    if (mapped && !seen.has(cap)) {
      seen.add(cap)
      items.push({ key: cap, ...mapped })
    }
  }

  // Add UI contribution items
  for (const item of buildUIItems(manifest)) {
    if (!seen.has(item.key)) {
      seen.add(item.key)
      items.push(item)
    }
  }

  // Add data access items
  for (const item of buildDataItems(manifest)) {
    if (!seen.has(item.key)) {
      seen.add(item.key)
      items.push(item)
    }
  }

  // Add hook items
  for (const item of buildHookItems(manifest)) {
    if (!seen.has(item.key)) {
      seen.add(item.key)
      items.push(item)
    }
  }

  return items
}
