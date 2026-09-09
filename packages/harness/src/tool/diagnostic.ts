export type ToolDiagnosticCode =
  | "plan_mode_blocked"
  | "tool_unavailable"
  | "permission_denied"
  | "unknown_tool"
  | "invalid_arguments"

export interface ToolDiagnostic {
  code: ToolDiagnosticCode
  toolName: string
  mode?: "plan"
  message: string
  metadata?: Record<string, unknown>
}

export class ToolDiagnosticError extends Error {
  readonly kind = "tool_diagnostic" as const
  readonly retryable = false as const

  constructor(readonly diagnostic: ToolDiagnostic) {
    super(diagnostic.message)
    this.name = "ToolDiagnosticError"
  }
}

export namespace ToolDiagnostic {
  export function metadata(diagnostic: ToolDiagnostic): Record<string, unknown> {
    return { toolDiagnostic: diagnostic }
  }

  export function fromError(error: unknown): ToolDiagnostic | undefined {
    return error instanceof ToolDiagnosticError ? error.diagnostic : undefined
  }
}
