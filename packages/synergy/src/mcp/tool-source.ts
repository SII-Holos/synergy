import { ToolMcpSource } from "../tool/mcp-source"
import { MCP } from "./index"

/**
 * P9 source inversion: the L1 tool domain reads MCP tool entries, call
 * timeouts, and the deferred-group catalog through this registered source
 * instead of importing the mcp product domain. Loaded through
 * src/product-registration.ts.
 */
export function registerMcpToolSource() {
  ToolMcpSource.register({
    toolEntries: () => MCP.toolEntries(),
    toolCallTimeout: (toolName) => MCP.toolCallTimeout(toolName),
    deferredGroupCatalog: () => MCP.deferredGroupCatalog(),
  })
}
