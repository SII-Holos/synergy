import { RuntimeContext } from "../lifecycle/context"
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

  export interface WritePolicy {
    enabled: boolean
    severity?: "error" | "warning"
    scope?: "file" | "project" | "delta"
  }

  export interface Source {
    writePolicy?(): Promise<WritePolicy>
    touchFile(file: string, waitForDiagnostics?: boolean): Promise<void>
    diagnostics(): Promise<DiagnosticsSnapshot>
  }

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source | undefined): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("tool/lsp-source")
    if (instanceState.source && value) throw new Error("tool/lsp-source is already registered")
    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }
}
