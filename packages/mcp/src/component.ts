import { registerReload } from "./reload"
import { MCP } from "."
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerMcpCommandSource } from "./instruction-source"
import { registerMcpToolSource } from "./tool-source"
import { registerMcpSessionInput } from "./session-input"
import { registerPluginMcpServices } from "@ericsanchezok/synergy-plugin-host/plugin/mcp"
import { McpSupervisor } from "./supervisor"
import { registerConfig } from "./config-schema"

export function mcp(): RuntimeComponent {
  return {
    id: "mcp",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, "plugin-host": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      disposeExtensions: () => MCP.stop(),
      resident: {
        async start() {
          MCP.ensureStarted()
        },
        async stop() {},
      },
    }),
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url), http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerConfig()
      registerMcpCommandSource()
      registerMcpToolSource()
      registerMcpSessionInput()
      registerPluginMcpServices(McpSupervisor())
    },
  }
}
