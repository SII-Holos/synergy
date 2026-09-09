import { ToolLspSource } from "@ericsanchezok/synergy-harness/tool/lsp-source"
import { readConfig } from "../config-schema"
import { LSP } from "."

/**
 * S9d source inversion: the L1 tool domain warms LSP clients and reads
 * diagnostics through this registered source instead of importing the lsp
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerLspToolSource() {
  ToolLspSource.register({
    writePolicy: async () => {
      const config = await readConfig()
      return { enabled: config.lspWriteDiagnostics !== false, ...config.lspDiagnostics }
    },
    touchFile: (file, waitForDiagnostics) => LSP.touchFile(file, waitForDiagnostics),
    diagnostics: () => LSP.diagnostics(),
  })
}
