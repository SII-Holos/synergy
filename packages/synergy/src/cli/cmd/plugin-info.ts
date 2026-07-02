import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import type { Argv } from "yargs"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginStatus {
  id: string
  name?: string
  version?: string
  source: string
  trust: { tier: string; source: string; userTrusted: boolean; verifiedIntegrity: boolean; reason: string }
  loaded: boolean
  loadError?: string
  manifestValid: boolean
  integrity: string
  permissions: {
    base: string[]
    tools: Record<string, string[]>
    overallRisk: "low" | "medium" | "high"
    warnings: Array<{ type: string; message: string }>
  }
  appRoutes: string[]
  tools: Array<{ id: string; fullId: string; capabilities: string[]; warnings: string[] }>
  ui: { contributions: number; errors: string[] }
  stores: { config: boolean; secrets: string; cacheBytes?: number }
  runtime?: {
    mode: string
    pid?: number
    state: string
    restarts: number
    lastHeartbeatAt?: number
    memoryMb?: number
    limits: Record<string, number>
    lastError?: string
  }
  warnings: Array<{ type: string; message: string; toolId?: string }>
}

function tierLabel(tier: string): string {
  if (tier === "sandbox") return UI.Style.TEXT_SUCCESS + "sandbox" + UI.Style.TEXT_NORMAL
  if (tier === "trusted-import") return UI.Style.TEXT_WARNING + "trusted-import" + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_DANGER + "declarative" + UI.Style.TEXT_NORMAL
}

function riskLabel(risk: "low" | "medium" | "high"): string {
  if (risk === "high") return UI.Style.TEXT_DANGER + "high" + UI.Style.TEXT_NORMAL
  if (risk === "medium") return UI.Style.TEXT_WARNING + "medium" + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_SUCCESS + "low" + UI.Style.TEXT_NORMAL
}

// ---------------------------------------------------------------------------
// info <plugin>
// ---------------------------------------------------------------------------

export const PluginInfoCommand = cmd({
  command: "info <plugin>",
  describe: "show detailed plugin status and metadata",
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
      `${UI.Style.TEXT_NORMAL_BOLD}${status.name ?? status.id}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}v${status.version ?? "?"}${UI.Style.TEXT_NORMAL}`,
    )
    UI.println(`${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL}     ${status.id}`)

    // Source & Trust
    UI.println(
      `${UI.Style.TEXT_DIM}Source:${UI.Style.TEXT_NORMAL} ${status.source}  ${UI.Style.TEXT_DIM}Trust:${UI.Style.TEXT_NORMAL} ${tierLabel(status.trust.tier)}`,
    )
    UI.println(
      `${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL}  ${riskLabel(status.permissions.overallRisk)}  ${UI.Style.TEXT_DIM}Integrity:${UI.Style.TEXT_NORMAL} ${status.integrity}`,
    )

    // Loaded state
    const loadStatus = status.loaded
      ? UI.Style.TEXT_SUCCESS + "loaded" + UI.Style.TEXT_NORMAL
      : UI.Style.TEXT_DANGER + "not loaded" + UI.Style.TEXT_NORMAL
    UI.println(`${UI.Style.TEXT_DIM}Loaded:${UI.Style.TEXT_NORMAL} ${loadStatus}`)
    if (status.loadError) {
      UI.println(`  ${UI.Style.TEXT_DANGER}${status.loadError}${UI.Style.TEXT_NORMAL}`)
    }

    // Tools
    UI.println()
    UI.println(`${UI.Style.TEXT_DIM}Tools:${UI.Style.TEXT_NORMAL} ${status.tools.length}`)
    for (const tool of status.tools) {
      const caps = tool.capabilities.length > 0 ? ` (${tool.capabilities.join(", ")})` : ""
      const warns =
        tool.warnings.length > 0
          ? ` ${UI.Style.TEXT_WARNING}[${tool.warnings.length} warning${tool.warnings.length !== 1 ? "s" : ""}]${UI.Style.TEXT_NORMAL}`
          : ""
      UI.println(`  ${tool.id}${caps}${warns}`)
    }

    // UI contributions
    if (status.ui.contributions > 0) {
      UI.println()
      UI.println(`${UI.Style.TEXT_DIM}UI Contributions:${UI.Style.TEXT_NORMAL} ${status.ui.contributions}`)
      if (status.appRoutes.length > 0) {
        UI.println(`  App routes: ${status.appRoutes.join(", ")}`)
      }
      if (status.ui.errors.length > 0) {
        for (const err of status.ui.errors) {
          UI.println(`  ${UI.Style.TEXT_DANGER}✘${UI.Style.TEXT_NORMAL} ${err}`)
        }
      }
    }

    // Runtime
    if (status.runtime) {
      const rt = status.runtime
      UI.println()
      UI.println(`${UI.Style.TEXT_DIM}Runtime:${UI.Style.TEXT_NORMAL} ${rt.mode}  ${rt.state}`)
    }

    // Approval — check approval endpoint
    try {
      const approval = await fetchPluginApi<any>(serverUrl, `/${pluginId}/approval`)
      UI.println()
      UI.println(
        `${UI.Style.TEXT_DIM}Approval:${UI.Style.TEXT_NORMAL} ${approval.trustTier} (approved ${new Date(approval.approvedAt).toLocaleDateString()})`,
      )
    } catch {
      UI.println()
      UI.println(
        `${UI.Style.TEXT_DIM}Approval:${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_WARNING}not yet approved${UI.Style.TEXT_NORMAL}`,
      )
    }

    // Warnings
    if (status.warnings.length > 0) {
      UI.println()
      UI.println(`${UI.Style.TEXT_WARNING_BOLD}Warnings:${UI.Style.TEXT_NORMAL}`)
      for (const w of status.warnings) {
        UI.println(`  ${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} ${w.message}`)
      }
    }

    UI.println()
  },
})
