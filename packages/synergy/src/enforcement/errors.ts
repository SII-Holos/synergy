import type { SandboxBlockExplanation } from "@/sandbox/explain"

/**
 * Structured error types for enforcement and sandbox denials.
 */
export namespace EnforcementError {
  /**
   * Config rule or profile rule denied the action.
   * This is a POLICY decision — the agent should NOT retry the same approach.
   */
  export class PolicyDenied extends Error {
    readonly kind = "policy_denied" as const
    readonly retryable = false as const

    constructor(
      message: string,
      public readonly capabilities: string[],
      public readonly profileId: string,
    ) {
      super(message)
      this.name = "PolicyDenied"
    }
  }

  /**
   * OS-level sandbox or filesystem boundary blocked the action.
   * This is not something the agent should retry with equivalent shell
   * syntax. It requires a workspace-safe alternative or user intervention.
   */
  export class SandboxBlocked extends Error {
    readonly kind = "sandbox_blocked" as const
    readonly retryable = false as const
    readonly explanation: SandboxBlockExplanation | null = null

    constructor(
      message: string,
      public readonly exitCode: number | null,
      public readonly matchedKeyword: string | null,
      public readonly rawOutput: string,
      explanation?: SandboxBlockExplanation,
    ) {
      super(message)
      this.name = "SandboxBlocked"
      this.explanation = explanation ?? null
    }
  }

  /**
   * Path is outside the workspace boundary.
   * This is NOT retryable via escalation — agent should use
   * workspace-relative paths or report the limitation.
   */
  export class BoundaryHit extends Error {
    readonly kind = "boundary_hit" as const
    readonly retryable = false as const

    constructor(
      message: string,
      public readonly path: string,
    ) {
      super(message)
      this.name = "BoundaryHit"
    }
  }

  /** Union type for switch/case matching */
  export type Any = PolicyDenied | SandboxBlocked | BoundaryHit
}
