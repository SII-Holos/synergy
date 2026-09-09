import { WorkspaceFileSymbolSource } from "@ericsanchezok/synergy-runtime-local/workspace-file/symbol-source"
import { LSP } from "."

/**
 * S9d source inversion: the L1 workspace-file search reads LSP client
 * availability and workspace symbols through this registered source instead
 * of importing the lsp product domain. Loaded through
 * src/product-registration.ts.
 */
export function registerWorkspaceFileSymbolSource() {
  WorkspaceFileSymbolSource.register({
    async activeClientCount() {
      return (await LSP.status()).length
    },
    workspaceSymbol: (query) => LSP.workspaceSymbol(query),
  })
}
