import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
import { ToolMcpSource } from "@ericsanchezok/synergy-harness/tool/mcp-source"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { MCP } from "."
import { builtinServerStaged } from "./builtin-catalog"

/**
 * P9 source inversion: the L1 tool domain reads MCP tool entries, call
 * timeouts, and the deferred-group catalog through this registered source
 * instead of importing the mcp product domain. Loaded through
 * src/product-registration.ts.
 */
export function registerMcpToolSource() {
  ToolMcpSource.register({
    async exposureConfiguration() {
      const config = await Config.current()
      return {
        expandByDefault: (serverName) =>
          ToolExposure.mcpExpandByDefault(
            config.mcp?.[serverName],
            config.mcpDefaults,
            builtinServerStaged(serverName, config.mcp),
          ),
      }
    },
    normalizeResult(value) {
      const result = CallToolResultSchema.parse(value)
      return {
        content: result.content,
        text: result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n\n"),
        images: result.content.filter((item) => item.type === "image"),
        metadata:
          typeof result.metadata === "object" && result.metadata !== null
            ? (result.metadata as Record<string, unknown>)
            : {},
      }
    },
    toolEntries: () => MCP.toolEntries(),
    toolCallTimeout: (toolName) => MCP.toolCallTimeout(toolName),
    deferredGroupCatalog: () => MCP.deferredGroupCatalog(),
  })
}
