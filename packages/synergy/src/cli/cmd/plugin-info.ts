import type { Argv } from "yargs"
import type { PluginStatus } from "../../plugin/status"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"
import { pluginInfoStateText } from "./plugin-consent"

function tierLabel(tier: PluginStatus["trust"]): string {
  return tier === "trusted-import"
    ? UI.Style.TEXT_WARNING + tier + UI.Style.TEXT_NORMAL
    : UI.Style.TEXT_SUCCESS + tier + UI.Style.TEXT_NORMAL
}

function riskLabel(risk: PluginStatus["risk"]): string {
  if (risk === "high") return UI.Style.TEXT_DANGER + risk + UI.Style.TEXT_NORMAL
  if (risk === "medium") return UI.Style.TEXT_WARNING + risk + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_SUCCESS + risk + UI.Style.TEXT_NORMAL
}

function installationLabel(installation: PluginStatus["installation"]): string {
  if (installation.kind === "directory") return `directory (${installation.path})`
  if (installation.kind === "archive") return `archive (${installation.path})`
  if (installation.kind === "registry") return `${installation.registry} registry`
  if (installation.kind === "package") return `${installation.source} package`
  return "built in"
}

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
    const stateText = pluginInfoStateText(status)
    const state = status.loaded
      ? UI.Style.TEXT_SUCCESS + stateText + UI.Style.TEXT_NORMAL
      : status.disabledPhase === "approval"
        ? UI.Style.TEXT_WARNING + stateText + UI.Style.TEXT_NORMAL
        : UI.Style.TEXT_DANGER + stateText + UI.Style.TEXT_NORMAL

    UI.println()
    UI.println(
      `${UI.Style.TEXT_NORMAL_BOLD}${status.name}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}v${status.version ?? "?"}${UI.Style.TEXT_NORMAL}`,
    )
    UI.println(`${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL}           ${status.id}`)
    UI.println(`${UI.Style.TEXT_DIM}Installation:${UI.Style.TEXT_NORMAL} ${installationLabel(status.installation)}`)
    UI.println(
      `${UI.Style.TEXT_DIM}Trust:${UI.Style.TEXT_NORMAL}        ${tierLabel(status.trust)}  ${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL} ${riskLabel(status.risk)}`,
    )
    UI.println(`${UI.Style.TEXT_DIM}State:${UI.Style.TEXT_NORMAL}        ${state}`)
    if (status.apiVersion) UI.println(`${UI.Style.TEXT_DIM}Plugin API:${UI.Style.TEXT_NORMAL}   ${status.apiVersion}`)
    if (status.generation) UI.println(`${UI.Style.TEXT_DIM}Generation:${UI.Style.TEXT_NORMAL}   ${status.generation}`)
    if (status.disabledReason) UI.println(`  ${UI.Style.TEXT_DANGER}${status.disabledReason}${UI.Style.TEXT_NORMAL}`)
    if (status.disabledPhase === "approval") {
      UI.println(`  ${UI.Style.TEXT_WARNING}Review with: synergy plugin approve ${status.id}${UI.Style.TEXT_NORMAL}`)
    }

    UI.println()
    UI.println(`${UI.Style.TEXT_DIM}Capabilities:${UI.Style.TEXT_NORMAL} ${status.capabilities.length}`)
    for (const capability of status.capabilities) UI.println(`  ${capability}`)

    UI.println()
    UI.println(
      `${UI.Style.TEXT_DIM}Contributions:${UI.Style.TEXT_NORMAL} ${status.tools.length} tools, ${status.operations.length} operations, ${status.uiContributions} UI surfaces`,
    )
    for (const tool of status.tools) {
      const capabilities = tool.capabilities.length > 0 ? ` (${tool.capabilities.join(", ")})` : ""
      UI.println(`  tool ${tool.id}${capabilities}`)
    }
    for (const operation of status.operations) {
      UI.println(`  ${operation.type} ${operation.id} [${operation.expose.join(", ")}]`)
    }

    if (status.runtime) {
      UI.println()
      UI.println(
        `${UI.Style.TEXT_DIM}Runtime:${UI.Style.TEXT_NORMAL} ${status.runtime.mode}  ${status.runtime.state}  ${status.runtime.inFlight} in flight`,
      )
      if (status.runtime.pid) UI.println(`  PID ${status.runtime.pid}`)
      if (status.runtime.lastError)
        UI.println(`  ${UI.Style.TEXT_DANGER}${status.runtime.lastError}${UI.Style.TEXT_NORMAL}`)
    }

    const degraded = Object.entries(status.contributionHealth).filter(([, health]) => health.state === "degraded")
    if (degraded.length > 0) {
      UI.println()
      UI.println(`${UI.Style.TEXT_WARNING_BOLD}Degraded contributions:${UI.Style.TEXT_NORMAL}`)
      for (const [id, health] of degraded) UI.println(`  ${id}${health.lastError ? `: ${health.lastError}` : ""}`)
    }

    UI.println()
  },
})
