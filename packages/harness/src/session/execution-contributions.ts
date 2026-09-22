import { RuntimeContext } from "../lifecycle/context"
import type { Info } from "./types"
import type { WorkflowPromptRegistry } from "./workflow-prompt-registry"

export namespace SessionExecutionContributions {
  export interface Contribution {
    id: string
    advisory?(sessionID: string, scopeID: string, signal: AbortSignal): Promise<string[]>
    isActive?(session: Info): Promise<boolean> | boolean
    /** Cancel the workflow bound to this session on explicit user request. The
     * user asked for it to stop, so an implementation must not refuse on
     * liveness grounds; it returns true only when it cleared state. */
    abandonWorkflow?(session: Info): Promise<boolean>
    hasContinuation?(session: Info): boolean
    assertWorkflowAllowed?(session: Info, kind: string): Promise<void>
    system?(
      session: Info,
      context: WorkflowPromptRegistry.PromptContext & { agentName: string },
    ): Promise<string[]> | string[]
    archive?(session: Info): Promise<Record<string, unknown>>
  }
  const runtimeState = RuntimeContext.state(() => ({
    contributions: new Map<string, Contribution>(),
  }))
  export function register(contribution: Contribution) {
    const instanceState = runtimeState()

    const existing = instanceState.contributions.get(contribution.id)
    if (existing === contribution) return
    RuntimeContext.assertCompositionOpen("session execution")
    if (existing) throw new Error(`Session execution ${contribution.id} is already registered`)
    instanceState.contributions.set(contribution.id, contribution)
  }
  export async function advisory(sessionID: string, scopeID: string, signal: AbortSignal) {
    const instanceState = runtimeState()

    const parts: string[] = []
    for (const entry of instanceState.contributions.values()) {
      signal.throwIfAborted()
      parts.push(...((await entry.advisory?.(sessionID, scopeID, signal)) ?? []))
    }
    return parts
  }
  export async function isActive(session: Info) {
    const instanceState = runtimeState()

    for (const entry of instanceState.contributions.values()) if (await entry.isActive?.(session)) return true
    return false
  }
  /** Cancel every workflow bound to this session, for `session.abandon`. */
  export async function abandonWorkflow(session: Info) {
    const instanceState = runtimeState()
    let abandoned = false
    for (const entry of instanceState.contributions.values()) {
      if (await entry.abandonWorkflow?.(session)) abandoned = true
    }
    return abandoned
  }
  export function hasContinuation(session: Info) {
    const instanceState = runtimeState()

    return [...instanceState.contributions.values()].some((entry) => entry.hasContinuation?.(session) === true)
  }
  export async function assertWorkflowAllowed(session: Info, kind: string) {
    const instanceState = runtimeState()

    for (const entry of instanceState.contributions.values()) await entry.assertWorkflowAllowed?.(session, kind)
  }
  export async function system(session: Info, context: WorkflowPromptRegistry.PromptContext & { agentName: string }) {
    const instanceState = runtimeState()

    const parts: string[] = []
    for (const entry of instanceState.contributions.values())
      parts.push(...((await entry.system?.(session, context)) ?? []))
    return parts
  }
  export async function archive(session: Info) {
    const instanceState = runtimeState()

    const result: Record<string, unknown> = {}
    for (const entry of instanceState.contributions.values()) Object.assign(result, await entry.archive?.(session))
    return result
  }
}
