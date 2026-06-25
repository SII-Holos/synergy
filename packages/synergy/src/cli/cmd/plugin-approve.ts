import { cmd } from "./cmd"
import { UI } from "../ui"
import type { Argv } from "yargs"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"

// ---------------------------------------------------------------------------
// approve <plugin>
// ---------------------------------------------------------------------------

export const PluginApproveCommand = cmd({
  command: "approve <plugin>",
  describe: "approve the latest pending consent request for a plugin",
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

    // Get plugin info to discover manifest data and capabilities
    const info = await fetchPluginApi<any>(serverUrl, `/${pluginId}/status`)

    // Check current approval state
    let hasApproval = false
    try {
      const approval = await fetchPluginApi<any>(serverUrl, `/${pluginId}/approval`)
      hasApproval = true
    } catch {
      // No existing approval — new install
    }

    const manifest = { name: info.name ?? pluginId, version: info.version ?? "0.0.0" }
    const capabilities = info.permissions?.base ?? []

    UI.println(`${UI.Style.TEXT_DIM}Approving ${pluginId}...${UI.Style.TEXT_NORMAL}`)

    try {
      if (hasApproval) {
        const result = await fetchPluginApi<any>(serverUrl, `/${pluginId}/approve-update`, "POST", {
          manifest,
          capabilities,
        })
        UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Update approved for ${pluginId}`)
        UI.println(
          `  ${UI.Style.TEXT_DIM}Trust Tier:${UI.Style.TEXT_NORMAL} ${result.trustTier}  ${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL} ${result.risk}`,
        )
      } else {
        const result = await fetchPluginApi<any>(serverUrl, `/${pluginId}/approve-install`, "POST", {
          manifest,
          capabilities,
        })
        UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Install approved for ${pluginId}`)
        UI.println(
          `  ${UI.Style.TEXT_DIM}Trust Tier:${UI.Style.TEXT_NORMAL} ${result.trustTier}  ${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL} ${result.risk}`,
        )
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      UI.error(`Approval failed: ${msg}`)
      process.exitCode = 1
    }
  },
})
