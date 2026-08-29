import type { Tool, JSONSchema7 } from "ai"

/**
 * P9 tool execution context (MCP half): the L1 tool domain reads MCP tool
 * entries and deferred-group metadata through this registry instead of
 * importing the mcp product domain. The L4 product manifest registers the
 * concrete source.
 */
export namespace ToolMcpSource {
  export interface Entry {
    id: string
    serverName: string
    toolName: string
    tool: Tool
    inputSchema: JSONSchema7
  }

  export interface DeferredGroupCatalog {
    totalTools: number
    servers: Array<{ serverName: string; toolNames: string[] }>
  }

  export interface Source {
    toolEntries(): Promise<Entry[]>
    toolCallTimeout(toolName: string): number | undefined
    deferredGroupCatalog(): Promise<DeferredGroupCatalog>
  }

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
