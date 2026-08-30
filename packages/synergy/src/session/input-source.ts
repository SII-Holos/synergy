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

  let reader: Reader | undefined

  export function registerMcpResourceReader(value: Reader): void {
    reader = value
  }

  export function readMcpResource(clientName: string, uri: string): Promise<McpResourceResult | undefined> {
    return reader?.(clientName, uri) ?? Promise.resolve(undefined)
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

  let lookup: Lookup | undefined

  export function registerDocumentSymbols(value: Lookup): void {
    lookup = value
  }

  export function documentSymbols(uri: string): Promise<SymbolHit[]> {
    return lookup?.(uri) ?? Promise.resolve([])
  }
}
