import type { ToolDisplay } from "@ericsanchezok/synergy-util/tool-display"
import { RuntimeContext } from "../lifecycle/context"
import type { Tool, JSONSchema7 } from "ai"
import type { ToolExposure } from "./exposure"

/**
 * P9 tool execution context (MCP half): the L1 tool domain reads MCP tool
 * entries and presentation through this registry instead of
 * importing the mcp product domain. The L4 product manifest registers the
 * concrete source.
 */
export namespace ToolMcpSource {
  export interface Entry {
    id: string
    serverName: string
    toolName: string
    requiresWorkspace?: boolean
    tool: Tool
    display?: ToolDisplay
    inputSchema: JSONSchema7
    presentation?: {
      title?: string
      description?: string
      exposure: ToolExposure.Info
    }
  }

  export interface Result {
    content: unknown[]
    text: string
    images: Array<{ mimeType: string; data: string }>
    metadata: Record<string, unknown>
  }

  export interface Source {
    exposureConfiguration(): Promise<{ expandByDefault(serverName: string): boolean }>
    normalizeResult(result: unknown): Result
    toolEntries(options?: { audience: "model" }): Promise<Entry[]>
    toolCallTimeout(toolName: string): number | undefined
  }

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("tool/mcp-source")
    if (instanceState.source && value) throw new Error("tool/mcp-source is already registered")
    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }
}
