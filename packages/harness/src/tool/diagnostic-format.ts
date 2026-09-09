import { ToolLspSource } from "./lsp-source"

/**
 * S9d LSP diagnostic formatting: byte-identical to the lsp domain's
 * `LSP.Diagnostic.pretty`, kept L1-local so write diagnostics render without
 * importing the lsp product domain.
 */
export function prettyDiagnostic(diagnostic: ToolLspSource.Diagnostic): string {
  const severityMap: Record<number, string> = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
  }

  const severity = severityMap[diagnostic.severity || 1]
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1

  return `${severity} [${line}:${col}] ${diagnostic.message}`
}
