import { SessionSymbolLookup } from "../session/input-source"
import { LSP } from "./index"

/**
 * S9c source inversion: the L1 session input resolver reads LSP document
 * symbols through the SessionSymbolLookup registry instead of importing the
 * lsp product domain. Loaded through src/product-registration.ts.
 */
export function registerLspSessionInput() {
  SessionSymbolLookup.registerDocumentSymbols((uri) => LSP.documentSymbol(uri))
}
