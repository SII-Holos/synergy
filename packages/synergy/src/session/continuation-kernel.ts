import { Log } from "@/util/log"
import type { Scope } from "../scope"
import { MessageV2 } from "./message-v2"
import { SessionProgress } from "./progress"
import type { Info as SessionInfo } from "./types"
import { BlueprintContinuationPolicy } from "./blueprint-continuation"
import { LightLoopContinuationPolicy } from "./light-loop-continuation"
import { LatticeContinuationPolicy } from "../lattice/policy"
import { SessionManager } from "./manager"
import { SessionInbox } from "./inbox"
import { ContinuationWait } from "./continuation-wait"

export namespace ContinuationKernel {
  const log = Log.create({ service: "session.continuation-kernel" })

  export interface Gate {
    session: SessionInfo
    scopeID: string
    sessionID: string
    terminalMessageID: string
  }

  export interface InboxProposal {
    kind: "inbox"
    deliveryKey?: string
    mode: "task" | "steer" | "context"
    message: Parameters<typeof SessionInbox.deliver>[0]["message"]
  }

  export interface HandledProposal {
    kind: "handled"
  }

  export type Proposal = InboxProposal | HandledProposal
  export type PolicyResult = Proposal | undefined

  export interface Policy {
    id: string
    priority: number
    handle(gate: Gate): Promise<PolicyResult>
  }

  const policies: Policy[] = []
  const dedup = new Map<string, Set<string>>()
  let builtinsRegistered = false

  export function register(policy: Policy): void {
    if (policies.some((candidate) => candidate.id === policy.id)) return
    policies.push(policy)
    policies.sort((a, b) => b.priority - a.priority)
  }

  export function reset(): void {
    policies.length = 0
    dedup.clear()
    builtinsRegistered = false
  }

  export function init(): () => void {
    registerBuiltins()
    return () => undefined
  }

  export async function passesSharedGate(sessionID: string): Promise<Gate | undefined> {
    const session = await SessionManager.getSession(sessionID)
    if (!session || session.time.archived) return undefined
    if (await ContinuationWait.has(sessionID)) return undefined

    const terminalMessageID = await terminalAssistantMessageID(sessionID)
    if (!terminalMessageID) return undefined

    return {
      session,
      scopeID: (session.scope as Scope).id,
      sessionID,
      terminalMessageID,
    }
  }

  export async function propose(sessionID: string): Promise<Proposal | undefined> {
    registerBuiltins()
    const gate = await passesSharedGate(sessionID)
    if (!gate) return undefined

    for (const policy of policies) {
      const key = dedupKey(policy.id, gate.terminalMessageID)
      if (dedup.get(sessionID)?.has(key)) continue

      const proposal = await policy.handle(gate).catch((error) => {
        log.error("continuation policy failed", { policy: policy.id, sessionID, error })
        return undefined
      })
      if (!proposal) continue
      if (proposal.kind === "handled") {
        markDelivered(sessionID, key)
        return proposal
      }
      return {
        ...proposal,
        deliveryKey: proposal.deliveryKey ?? `continuation:${policy.id}:${gate.terminalMessageID}`,
      }
    }
  }

  export async function markCommitted(sessionID: string, proposal: Proposal): Promise<void> {
    if (proposal.kind !== "inbox") return
    const prefix = "continuation:"
    if (!proposal.deliveryKey?.startsWith(prefix)) return
    const remainder = proposal.deliveryKey.slice(prefix.length)
    const separator = remainder.lastIndexOf(":")
    if (separator < 0) return
    markDelivered(sessionID, dedupKey(remainder.slice(0, separator), remainder.slice(separator + 1)))
  }

  export async function evaluate(sessionID: string): Promise<boolean> {
    const proposal = await propose(sessionID)
    if (!proposal) return false
    if (proposal.kind === "handled") return true

    const deliveryKey = proposal.deliveryKey
    if (!deliveryKey) {
      log.error("continuation proposal missing delivery key", { sessionID })
      return false
    }
    const result = await SessionInbox.deliverUnique({
      sessionID,
      deliveryKey,
      mode: proposal.mode,
      message: proposal.message,
    })
    await markCommitted(sessionID, proposal)
    return result.created
  }

  export async function kick(sessionID: string): Promise<boolean> {
    const { SessionDrive } = await import("./drive")
    return SessionDrive.request(sessionID, "continuation-kick")
  }

  function registerBuiltins(): void {
    if (builtinsRegistered) return
    builtinsRegistered = true
    register(BlueprintContinuationPolicy)
    register(LightLoopContinuationPolicy)
    register(LatticeContinuationPolicy)
  }

  function dedupKey(policyID: string, terminalMessageID: string): string {
    return `${policyID}:${terminalMessageID}`
  }

  function markDelivered(sessionID: string, key: string): void {
    const delivered = dedup.get(sessionID) ?? new Set<string>()
    delivered.add(key)
    dedup.set(sessionID, delivered)
  }

  async function terminalAssistantMessageID(sessionID: string): Promise<string | undefined> {
    const messages = await MessageV2.filterCompacted(MessageV2.stream({ sessionID }))
    const latestUser = latestReplyRequiredUser(messages)
    if (!latestUser) return undefined

    const assistant = latestAssistantFor(messages, latestUser.id)
    if (!assistant || assistant.error || !SessionProgress.isTerminalAssistant(assistant)) return undefined
    return assistant.id
  }

  function latestAssistantFor(messages: MessageV2.WithParts[], parentID: string): MessageV2.Assistant | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "assistant") continue
      const assistant = message.info as MessageV2.Assistant
      if (assistant.parentID === parentID) return assistant
    }
  }

  function latestReplyRequiredUser(messages: MessageV2.WithParts[]): MessageV2.User | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "user" || !MessageV2.isPromptVisible(message)) continue
      const user = message.info as MessageV2.User
      if (SessionProgress.isReplyRequiredUser(user)) return user
    }
  }
}
