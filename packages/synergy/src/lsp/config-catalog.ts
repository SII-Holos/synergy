import { ConfigLspCatalog } from "../config/lsp-catalog"
import { LSPServer } from "./server"

/**
 * S9d catalog inversion: the L1 config schema's lsp refinement checks builtin
 * server IDs through the registered catalog instead of importing the lsp
 * product domain. Loaded through src/product-registration.ts.
 */
export function registerLspConfigCatalog() {
  ConfigLspCatalog.registerServerIds(Object.values(LSPServer).map((server) => server.id))
}
