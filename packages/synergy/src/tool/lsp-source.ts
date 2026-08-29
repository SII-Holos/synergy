/**
 * S9d LSP source port: the L1 tool domain warms LSP clients and reads
 * diagnostics through this registry instead of importing the lsp product
 * domain. The L4 product manifest registers the concrete source; unregistered
 * access degrades to no warm-up and empty diagnostics.
 */
export namespace ToolLspSource {
  export interface Diagnostic {
    severity?: number
    message: string
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    code?: number | string
    source?: string
  }

  export type DiagnosticsSnapshot = Record<string, Diagnostic[]>

  export interface Source {
    touchFile(file: string, waitForDiagnostics?: boolean): Promise<void>
    diagnostics(): Promise<DiagnosticsSnapshot>
  }

  let source: Source | undefined

  export function register(value: Source | undefined): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }
}
