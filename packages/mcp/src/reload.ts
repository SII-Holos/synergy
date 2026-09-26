import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "mcp",
    targets: {
      async mcp(ctx) {
        const { MCP } = await import("@ericsanchezok/synergy-mcp")
        const { Plugin } = await import("@ericsanchezok/synergy-plugin-host/plugin")
        await MCP.reload()
        await Plugin.reloadMcpContributions()
        return
      },
    },
  })
}
