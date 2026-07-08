import { Bus } from "@/bus"
import { Log } from "@/util/log"
import type { Scope } from "../scope"
import { ScopedState } from "../scope/scoped-state"
import { SessionEvent } from "./event"
import { SessionManager } from "./manager"
import { MessageV2 } from "./message-v2"
import { SessionProgress } from "./progress"
import type { Info as SessionInfo } from "./types"
import { BlueprintContinuationPolicy } from "./blueprint-continuation"
import { LightLoopContinuationPolicy } from "./light-loop-continuation"
import { LatticeContinuationPolicy } from "../lattice/policy"

/**
 * Session Continuation Kernel.
 *
 * A single subscriber to SessionEvent.Idle that decides whether an idle session
 * should be automatically woken to keep making progress on some outer loop
 * (BlueprintLoop execution, Lattice pathway, ...). It runs the common safety
 * gate once, then offers the idle to registered policies in priority order;
 * the first policy that handles it wins. Per (session, policy, terminal
 * assistant) de-duplication prevents re-delivering the same continuation after
 * the same terminal response.
 */
export namespace ContinuationKernel {
  const log = Log.create({ service: "session.continuation-kernel" })

  /** Result of the shared safety gate: everything a policy needs to decide. */
  export interface Gate {
    session: SessionInfo
    scopeID: string
    sessionID: string
    /** messageID of the terminal assistant for the latest reply-required user. */
    terminalMessageID: string
  }

  export interface Policy {
    id: string
    /** Higher runs first; the first policy to return true consumes the idle. */
    priority: number
    handle(gate: Gate): Promise<boolean>
  }

  const policies: Policy[] = []

  export function register(policy: Policy): void {
    if (policies.some((p) => p.id === policy.id)) return
    policies.push(policy)
    policies.sort((a, b) => b.priority - a.priority)
  }

  /** For tests: drop all registered policies. */
  export function reset(): void {
    policies.length = 0
    dedup.clear()
  }

  // De-dup: sessionID -> `${policyID}:${terminalMessageID}` already delivered.
  const dedup = new Map<string, Set<string>>()

  function dedupKey(policyID: string, terminalMessageID: string): string {
    return `${policyID}:${terminalMessageID}`
  }

  function alreadyDelivered(sessionID: string, policyID: string, terminalMessageID: string): boolean {
    return dedup.get(sessionID)?.has(dedupKey(policyID, terminalMessageID)) ?? false
  }

  function markDelivered(sessionID: string, policyID: string, terminalMessageID: string): void {
    let set = dedup.get(sessionID)
    if (!set) {
      set = new Set()
      dedup.set(sessionID, set)
    }
    set.add(dedupKey(policyID, terminalMessageID))
  }

  /**
   * The shared safety gate. Returns a Gate when it is safe for a policy to
   * continue the session, undefined otherwise.
   *
   * Gate checks (policy-agnostic):
   *  - session exists and is not archived;
   *  - no active Cortex (queued/running) work;
   *  - the latest reply-required user message has a terminal assistant reply
   *    that did not error.
   */
  export async function passesSharedGate(sessionID: string): Promise<Gate | undefined> {
    const session = await SessionManager.getSession(sessionID)
    if (!session || session.time.archived) return undefined

    const scopeID = (session.scope as Scope).id

    if (await hasActiveCortexWork(sessionID)) return undefined

    const terminalMessageID = await terminalAssistantMessageID(sessionID)
    if (!terminalMessageID) return undefined

    return { session, scopeID, sessionID, terminalMessageID }
  }

  /** Evaluate one idle session against all registered policies. */
  export async function evaluate(sessionID: string): Promise<boolean> {
    const gate = await passesSharedGate(sessionID)
    if (!gate) return false

    for (const policy of policies) {
      if (alreadyDelivered(sessionID, policy.id, gate.terminalMessageID)) continue
      const handled = await policy.handle(gate).catch((error) => {
        log.error("continuation policy failed", { policy: policy.id, sessionID, error })
        return false
      })
      if (handled) {
        markDelivered(sessionID, policy.id, gate.terminalMessageID)
        return true
      }
    }
    return false
  }

  /**
   * Proactively evaluate a session that is already idle (e.g. after resuming a
   * paused Lattice run — no fresh Idle event will arrive on its own).
   */
  export async function kick(sessionID: string): Promise<boolean> {
    if (SessionManager.isRunning(sessionID)) return false
    return evaluate(sessionID)
  }

  const subscription = ScopedState.create(
    () => {
      const unsubscribe = Bus.subscribe(SessionEvent.Idle, (event) => {
        evaluate(event.properties.sessionID).catch((error) => {
          log.error("idle continuation failed", { sessionID: event.properties.sessionID, error })
        })
      })
      return { unsubscribe }
    },
    async (state) => state.unsubscribe(),
  )

  export function init(): () => void {
    registerBuiltins()
    return subscription().unsubscribe
  }

  let builtinsRegistered = false
  function registerBuiltins(): void {
    if (builtinsRegistered) return
    builtinsRegistered = true
    register(BlueprintContinuationPolicy)
    register(LightLoopContinuationPolicy)
    register(LatticeContinuationPolicy)
  }

  async function hasActiveCortexWork(sessionID: string): Promise<boolean> {
    const { Cortex } = await import("../cortex/manager")
    return Cortex.getTasksForSession(sessionID).some((task) => task.status === "running" || task.status === "queued")
  }

  async function terminalAssistantMessageID(sessionID: string): Promise<string | undefined> {
    const messages = await MessageV2.filterCompacted(MessageV2.stream({ sessionID }))
    const latestUser = latestReplyRequiredUser(messages)
    if (!latestUser) return undefined

    const assistant = latestAssistantFor(messages, latestUser.id)
    if (!assistant) return undefined
    if (assistant.error) return undefined
    if (!SessionProgress.isTerminalAssistant(assistant)) return undefined
    return assistant.id
  }

  function latestAssistantFor(messages: MessageV2.WithParts[], parentID: string): MessageV2.Assistant | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "assistant") continue
      const assistant = message.info as MessageV2.Assistant
      if (assistant.parentID !== parentID) continue
      return assistant
    }
  }

  function latestReplyRequiredUser(messages: MessageV2.WithParts[]): MessageV2.User | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "user") continue
      if (!MessageV2.isPromptVisible(message)) continue
      const user = message.info as MessageV2.User
      if (SessionProgress.isReplyRequiredUser(user)) return user
    }
  }
}
