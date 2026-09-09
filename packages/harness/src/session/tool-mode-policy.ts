import type { Capability } from "../enforcement/gate"
import type { Info } from "./types"
import type { ToolDiagnostic } from "../tool/diagnostic"

export namespace SessionModePolicy {
  export interface VisibilityInput {
    toolName: string
    session?: Info
  }
  export interface CallInput extends VisibilityInput {
    args: Record<string, unknown>
    capabilities: Capability[]
  }
  export interface UnavailableInput extends VisibilityInput {
    reason: string
    metadata?: Record<string, unknown>
  }
  export interface Contribution {
    id: string
    visibility?(input: VisibilityInput): ToolDiagnostic | undefined
    evaluateCall?(input: CallInput): ToolDiagnostic | undefined
    unavailable?(input: UnavailableInput): ToolDiagnostic | undefined
    forcedGroups?(session?: Info): Iterable<string>
    availability?(input: { session?: Info; agent: string }): Promise<Map<string, ToolDiagnostic>>
  }
  const contributions = new Map<string, Contribution>()
  export function register(contribution: Contribution) {
    contributions.set(contribution.id, contribution)
  }
  export function visibility(input: VisibilityInput) {
    for (const source of contributions.values()) {
      const result = source.visibility?.(input)
      if (result) return result
    }
  }
  export function evaluateCall(input: CallInput) {
    for (const source of contributions.values()) {
      const result = source.evaluateCall?.(input)
      if (result) return result
    }
  }
  export function forcedGroups(session?: Info) {
    return new Set([...contributions.values()].flatMap((source) => [...(source.forcedGroups?.(session) ?? [])]))
  }
  export async function availability(input: { session?: Info; agent: string }) {
    const result = new Map<string, ToolDiagnostic>()
    for (const source of contributions.values())
      for (const [id, diagnostic] of (await source.availability?.(input)) ?? []) {
        if (!result.has(id)) result.set(id, diagnostic)
      }
    return result
  }
  export function unavailable(input: UnavailableInput): ToolDiagnostic {
    for (const source of contributions.values()) {
      const result = source.unavailable?.(input)
      if (result) return result
    }
    return {
      code: input.reason === "permission" ? "permission_denied" : "tool_unavailable",
      toolName: input.toolName,
      message:
        input.reason === "permission"
          ? `The "${input.toolName}" tool is disabled by the current permission rules. Choose another tool or ask the user to adjust permissions.`
          : input.reason === "user_disabled"
            ? `The "${input.toolName}" tool is disabled for this request. Choose a currently available tool instead.`
            : `The "${input.toolName}" tool is not currently visible. Use search_tools or expand_tools when a deferred capability is appropriate.`,
      metadata: input.metadata,
    }
  }
}
