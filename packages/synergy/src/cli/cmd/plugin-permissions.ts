import { SYNERGY_CAPABILITY_DETAILS } from "@ericsanchezok/synergy-util/capability"
import type { Argv } from "yargs"
import type { PluginStatus } from "../../plugin/status"
import { cmd } from "./cmd"
import { UI } from "../../util/ui"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"

function describeCapability(capability: string) {
  const details = SYNERGY_CAPABILITY_DETAILS[capability]
  return details
    ? { label: details.title, description: details.description }
    : { label: capability, description: capability }
}

function printCapability(capability: string, indent = "  ") {
  const info = describeCapability(capability)
  UI.println(`${indent}${info.label}`)
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
    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}This plugin can${UI.Style.TEXT_NORMAL} — ${status.id}`)
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
