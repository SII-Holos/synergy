import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
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

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source | undefined): void {
    const instanceState = runtimeState()

    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }
}
