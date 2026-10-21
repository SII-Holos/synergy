import { RuntimeContext } from "../lifecycle/context"
import type { SymbolRange } from "./symbol-range"

/**
 * S9c source inversion: the L1 session input resolver reads MCP resources
 * and LSP document symbols through these registries instead of importing
 * the mcp and lsp product domains. The L4 product manifest registers the
 * readers; unregistered reads degrade quietly (resource not found, no
 * symbols).
 */
export namespace SessionInputResources {
  export interface McpResourceContent {
    text?: string
    blob?: string
    mimeType?: string
  }

  export interface McpResourceResult {
    contents: McpResourceContent | McpResourceContent[]
  }

  type Reader = (clientName: string, uri: string) => Promise<McpResourceResult | undefined>

  const runtimeState = RuntimeContext.state(() => ({
    reader: undefined as Reader | undefined,
  }))

  export function registerMcpResourceReader(value: Reader): void {
    const instanceState = runtimeState()

    if (instanceState.reader === value) return
    RuntimeContext.assertCompositionOpen("session/input-source")
    if (instanceState.reader && value !== undefined) throw new Error("session/input-source is already registered")
    instanceState.reader = value
  }

  export function readMcpResource(clientName: string, uri: string): Promise<McpResourceResult | undefined> {
    const instanceState = runtimeState()

    return instanceState.reader?.(clientName, uri) ?? Promise.resolve(undefined)
  }
}

export namespace SessionSymbolLookup {
  /** Document symbols (inline range) or workspace symbols (located range),
   * structural view of the lsp domain's LSP.DocumentSymbol | LSP.Symbol
   * union. */
  export type SymbolHit =
    | { range: SymbolRange; location?: undefined }
    | { range?: undefined; location: { range: SymbolRange } }

  type Lookup = (uri: string) => Promise<SymbolHit[]>

  const runtimeState = RuntimeContext.state(() => ({
    lookup: undefined as Lookup | undefined,
  }))

  export function registerDocumentSymbols(value: Lookup): void {
    const instanceState = runtimeState()

    if (instanceState.lookup === value) return
    RuntimeContext.assertCompositionOpen("session/input-source")
    if (instanceState.lookup && value !== undefined) throw new Error("session/input-source is already registered")
    instanceState.lookup = value
  }

  export function documentSymbols(uri: string): Promise<SymbolHit[]> {
    const instanceState = runtimeState()

    return instanceState.lookup?.(uri) ?? Promise.resolve([])
  }
}
