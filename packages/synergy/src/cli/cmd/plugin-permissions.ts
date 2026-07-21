import { SYNERGY_CAPABILITY_DETAILS } from "@ericsanchezok/synergy-util/capability"
import type { Argv } from "yargs"
import type { PluginStatus } from "../../plugin/status"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"

function riskBadge(risk: PluginStatus["risk"]): string {
  if (risk === "high") return UI.Style.TEXT_DANGER + "⬤ HIGH" + UI.Style.TEXT_NORMAL
  if (risk === "medium") return UI.Style.TEXT_WARNING + "◉ MEDIUM" + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_SUCCESS + "● LOW" + UI.Style.TEXT_NORMAL
}

function severityBadge(risk: string): string {
  if (risk === "high") return `[${UI.Style.TEXT_DANGER}!!!${UI.Style.TEXT_NORMAL}]`
  if (risk === "medium") return `[${UI.Style.TEXT_WARNING}!!${UI.Style.TEXT_NORMAL}]`
  return `[${UI.Style.TEXT_SUCCESS}!${UI.Style.TEXT_NORMAL}]`
}

function describeCapability(capability: string) {
  const details = SYNERGY_CAPABILITY_DETAILS[capability]
  return details
    ? { label: details.title, risk: details.severity, description: details.description }
    : { label: capability, risk: "low", description: capability }
}

function printCapability(capability: string, indent = "  ") {
  const info = describeCapability(capability)
  UI.println(`${indent}${severityBadge(info.risk)} ${info.label}`)
  UI.println(`${indent}  ${UI.Style.TEXT_DIM}${info.description}${UI.Style.TEXT_NORMAL}`)
}

export const PluginPermissionsCommand = cmd({
  command: "permissions <plugin>",
  describe: "show declared plugin capabilities in user-language format",
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
      `${UI.Style.TEXT_NORMAL_BOLD}Capabilities${UI.Style.TEXT_NORMAL} for ${status.id}  ${riskBadge(status.risk)}`,
    )
    UI.println()

    if (status.capabilities.length === 0) {
      UI.println(`  ${UI.Style.TEXT_DIM}No host capabilities declared${UI.Style.TEXT_NORMAL}`)
    } else {
      for (const capability of status.capabilities) printCapability(capability)
    }

    const tools = status.tools.filter((tool) => tool.capabilities.length > 0)
    if (tools.length > 0) {
      UI.println()
      UI.println(`${UI.Style.TEXT_DIM}Contribution requirements:${UI.Style.TEXT_NORMAL}`)
      for (const tool of tools) {
        UI.println(`  ${tool.id}`)
        for (const capability of tool.capabilities) printCapability(capability, "    ")
      }
    }

    UI.println()
  },
})
