import type { SandboxBlockExplanation } from "../sandbox/explain"

/**
 * Structured error types for enforcement and sandbox denials.
 */
export namespace EnforcementError {
  export interface PolicyDeniedOptions {
    /** False only for enforcement infrastructure failures that a retry can clear. */
    permanent?: boolean
    guidance?: string
  }

  /**
   * Config rule or profile rule denied the action, or enforcement infrastructure
   * could not classify it. A POLICY decision is permanent — the agent should NOT
   * retry the same approach. An infrastructure failure is transient and retryable.
   */
  export class PolicyDenied extends Error {
    readonly kind = "policy_denied" as const
    readonly permanent: boolean
    readonly guidance: string | undefined

    constructor(
      message: string,
      public readonly capabilities: string[],
      public readonly profileId: string,
      options?: PolicyDeniedOptions,
    ) {
      super(message)
      this.name = "PolicyDenied"
      this.permanent = options?.permanent ?? true
      this.guidance = options?.guidance
    }

    get retryable(): boolean {
      return !this.permanent
    }

    /** Model-facing text: a policy decision and an infrastructure failure must not read alike. */
    get modelMessage(): string {
      if (this.permanent) {
        return [
          `Permission denied by profile "${this.profileId}".`,
          `Blocked capabilities: ${this.capabilities.join(", ")}`,
          `This is a policy restriction. Do not retry the same approach.`,
          this.message,
        ].join("\n")
      }
      return [
        `Permission classification is temporarily unavailable for profile "${this.profileId}".`,
        `The operation was not executed; this is an enforcement infrastructure failure, not a policy decision.`,
        ...(this.guidance ? [this.guidance] : []),
        this.message,
      ].join("\n")
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
