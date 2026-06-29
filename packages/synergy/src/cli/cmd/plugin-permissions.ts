import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import type { Argv } from "yargs"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CapabilityWarning {
  type: string
  message: string
  toolId?: string
}

interface PluginStatus {
  id: string
  permissions: {
    base: string[]
    tools: Record<string, string[]>
    overallRisk: "low" | "medium" | "high"
    warnings: CapabilityWarning[]
  }
}

function riskBadge(risk: string): string {
  if (risk === "high") return UI.Style.TEXT_DANGER + "⬤ HIGH" + UI.Style.TEXT_NORMAL
  if (risk === "medium") return UI.Style.TEXT_WARNING + "◉ MEDIUM" + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_SUCCESS + "● LOW" + UI.Style.TEXT_NORMAL
}

function severityBadge(risk: string): string {
  if (risk === "high") return `[${UI.Style.TEXT_DANGER}!!!${UI.Style.TEXT_NORMAL}]`
  if (risk === "medium") return `[${UI.Style.TEXT_WARNING}!!${UI.Style.TEXT_NORMAL}]`
  return `[${UI.Style.TEXT_SUCCESS}!${UI.Style.TEXT_NORMAL}]`
}

// ---------------------------------------------------------------------------
// User-language descriptions for permission categories
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, { label: string; risk: string; description: string }> = {
  shell: { label: "Shell Execution", risk: "high", description: "Can run shell commands on your system" },
  file_write: { label: "File Write", risk: "high", description: "Can write and modify files" },
  file_read: { label: "File Read", risk: "medium", description: "Can read files" },
  network_request: { label: "Network Access", risk: "medium", description: "Can make network requests" },
  mcp_invoke: { label: "MCP Invoke", risk: "medium", description: "Can call MCP tool endpoints" },
  mcp_spawn: { label: "MCP Spawn", risk: "medium", description: "Can launch MCP server processes" },
  session_data: { label: "Session Data Read", risk: "low", description: "Can read session data" },
  workspace_data: { label: "Workspace Data Read", risk: "low", description: "Can read workspace files and data" },
  secrets: { label: "Secrets Access", risk: "high", description: "Can read plugin-scoped secrets" },
  "config:write": { label: "Config Write", risk: "medium", description: "Can modify global configuration" },
  "config:read": { label: "Config Read", risk: "low", description: "Can read global configuration" },
  task: { label: "Task Delegation", risk: "medium", description: "Can launch approved Synergy subagents" },
  prompt_transform: { label: "Prompt Transform", risk: "high", description: "Can modify prompt context sent to the LLM" },
  compaction_transform: { label: "Compaction Transform", risk: "high", description: "Can modify session compaction context" },
  tool_execution_hook: { label: "Tool Execution Hook", risk: "medium", description: "Can intercept tool calls" },
  permission_hook: { label: "Permission Hook", risk: "high", description: "Can influence permission decisions" },
  event_hook: { label: "Event Hook", risk: "medium", description: "Can receive approved runtime events" },
}

function describeCapability(cap: string): { label: string; risk: string; description: string } {
  return CATEGORY_LABELS[cap] ?? { label: cap, risk: "low", description: cap }
}

function classifyCapabilities(caps: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = { high: [], medium: [], low: [] }
  for (const cap of caps) {
    const info = describeCapability(cap)
    result[info.risk].push(cap)
  }
  return result
}

// ---------------------------------------------------------------------------
// permissions <plugin>
// ---------------------------------------------------------------------------

export const PluginPermissionsCommand = cmd({
  command: "permissions <plugin>",
  describe: "show resolved plugin permissions in user-language format",
  builder: (yargs: Argv) =>
    yargs
      .positional("plugin", {
        type: "string",
        describe: "plugin id",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const pluginId = args.plugin as string
    const status = await fetchPluginApi<PluginStatus>(serverUrl, `/${pluginId}/status`)

    UI.println()
    UI.println(
      `${UI.Style.TEXT_NORMAL_BOLD}Permissions${UI.Style.TEXT_NORMAL} for ${status.id}  ${riskBadge(status.permissions.overallRisk)}`,
    )
    UI.println()

    // Base capabilities
    if (status.permissions.base.length > 0) {
      const classified = classifyCapabilities(status.permissions.base)
      for (const risk of ["high", "medium", "low"] as const) {
        const caps = classified[risk]
        if (caps.length === 0) continue
        for (const cap of caps) {
          const info = describeCapability(cap)
          UI.println(`  ${severityBadge(info.risk)} ${info.label}`)
          UI.println(`    ${UI.Style.TEXT_DIM}${info.description}${UI.Style.TEXT_NORMAL}`)
        }
      }
    } else {
      UI.println(`  ${UI.Style.TEXT_DIM}No base capabilities declared${UI.Style.TEXT_NORMAL}`)
    }

    // Tool-specific capabilities
    if (Object.keys(status.permissions.tools).length > 0) {
      UI.println()
      UI.println(`${UI.Style.TEXT_DIM}Tool-Specific Permissions:${UI.Style.TEXT_NORMAL}`)
      for (const [toolName, caps] of Object.entries(status.permissions.tools)) {
        if (caps.length === 0) continue
        const classified = classifyCapabilities(caps)
        UI.println(`  ${toolName}`)
        for (const risk of ["high", "medium", "low"] as const) {
          const riskCaps = classified[risk]
          if (riskCaps.length === 0) continue
          for (const cap of riskCaps) {
            const info = describeCapability(cap)
            UI.println(`    ${severityBadge(info.risk)} ${info.label}`)
          }
        }
      }
    }

    // Warnings
    if (status.permissions.warnings.length > 0) {
      UI.println()
      UI.println(`${UI.Style.TEXT_WARNING_BOLD}Permission Warnings:${UI.Style.TEXT_NORMAL}`)
      for (const w of status.permissions.warnings) {
        UI.println(`  ${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} ${w.message}`)
      }
    }

    UI.println()
  },
})
