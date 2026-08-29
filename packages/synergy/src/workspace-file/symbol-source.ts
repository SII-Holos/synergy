/**
 * S9d symbol source port: the L1 workspace-file search reaches LSP client
 * availability and workspace symbols through this registered source instead
 * of importing the lsp product domain. Unregistered, symbol search reports
 * the capability as unavailable.
 */
export namespace WorkspaceFileSymbolSource {
  export interface Symbol {
    name: string
    kind: number
    location: {
      uri: string
      range: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      }
    }
  }

  export interface Source {
    activeClientCount(): Promise<number>
    workspaceSymbol(query: string): Promise<Symbol[]>
  }

  let source: Source | undefined

  export function register(value: Source | undefined): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
