import { ToolLspSource } from "../tool/lsp-source"
import { LSP } from "./index"

/**
 * S9d source inversion: the L1 tool domain warms LSP clients and reads
 * diagnostics through this registered source instead of importing the lsp
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerLspToolSource() {
  ToolLspSource.register({
    touchFile: (file, waitForDiagnostics) => LSP.touchFile(file, waitForDiagnostics),
    diagnostics: () => LSP.diagnostics(),
  })
}
