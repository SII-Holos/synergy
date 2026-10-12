import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { RuntimeComponents } from "../lifecycle/components"
import { MessageV2 } from "./message-v2"
import { WorkflowKindRegistry } from "./workflow-kind-registry"
import { independentExecutionInfo, type Info as SessionInfo } from "./types"

export namespace SessionExecutionOwners {
  export const UnavailableError = NamedError.create(
    "SessionExecutionOwnerUnavailableError",
    z.object({
      sessionID: z.string(),
      message: z.string(),
    }),
  )
  export interface Contribution {
    allowsSession?(session: Readonly<SessionInfo>): boolean | Promise<boolean>
    allowsMessage?(session: Readonly<SessionInfo>, message: Readonly<MessageV2.OwnerInput>): boolean | Promise<boolean>
  }
  const state = RuntimeContext.state(() => new Map<string, Contribution>())

  export function register(owner: string, contribution: Contribution) {
    RuntimeContext.assertCompositionOpen("session execution owner")
    if (state().has(owner)) throw new Error(`Session execution owner ${owner} is already registered`)
    state().set(owner, contribution)
  }

  export function available(owners: readonly string[]): boolean {
    const selected = new Set(RuntimeComponents.selected().map((component) => component.id))
    return owners.every((owner) => selected.has(owner))
  }

  export async function allowsMessage(session: SessionInfo, message: MessageV2.OwnerInput): Promise<boolean> {
    const owners = MessageV2.requiredOwners(message)
    if (!available(owners)) return false
    for (const owner of owners) {
      const allowed = state().get(owner)?.allowsMessage
      if (allowed && !(await allowed(session, message))) return false
    }
    return true
  }

  export async function allowsSession(session: SessionInfo): Promise<boolean> {
    const kind = WorkflowKindRegistry.effectiveKind(session.workflow)
    if (kind && !WorkflowKindRegistry.get(kind)) return false
    const fields = session as unknown as Record<string, unknown>
    for (const owner of ["agenda", "blueprint"]) {
      if (fields[owner] && !available([owner])) return false
    }
    for (const [owner, contribution] of state()) {
      if (available([owner]) && contribution.allowsSession && !(await contribution.allowsSession(session))) return false
    }
    return true
  }

  export async function latestRoot(sessionID: string) {
    const { SessionHistory } = await import("./history")
    const messages = await SessionHistory.detachedModelMessages({ sessionID })
    const root = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)?.info
    return root?.role === "user" ? root : undefined
  }

  export function forRoot(session: SessionInfo, root: MessageV2.Info | undefined): SessionInfo {
    return MessageV2.isIndependentRoot(root) ? independentExecutionInfo(session) : session
  }

  export async function currentSession(session: SessionInfo): Promise<SessionInfo> {
    return forRoot(session, await latestRoot(session.id))
  }

  export async function admitTask(
    session: SessionInfo,
    input: MessageV2.OwnerInput,
  ): Promise<MessageV2.RootExecution | undefined> {
    if (!MessageV2.isHumanInput(input)) return
    const root = await latestRoot(session.id)
    if (!MessageV2.isIndependentRoot(root) && (await allowsResume(session))) return
    return { version: 1, kind: "independent", ...(root ? { previousRootID: root.id } : {}) }
  }

  export async function allowsResume(session: SessionInfo): Promise<boolean> {
    const { SessionHistory } = await import("./history")
    const messages = await SessionHistory.detachedModelMessages({ sessionID: session.id })
    const root = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)?.info
    const context = forRoot(session, root)
    if (!(await allowsSession(context))) return false
    const latest = messages.findLast((message) => message.info.role === "user")
    if (!root) {
      const { SessionInbox } = await import("./inbox")
      return !(await SessionInbox.hasUnavailableItem(session.id))
    }
    return (await allowsMessage(context, root)) && (!latest || (await allowsMessage(context, latest.info)))
  }

  export async function assertResume(session: SessionInfo): Promise<void> {
    if (await allowsResume(session)) return
    throw new UnavailableError({
      sessionID: session.id,
      message:
        "This saved task requires a component that is not available. Reinstall its component to continue, or send a new message.",
    })
  }
}
