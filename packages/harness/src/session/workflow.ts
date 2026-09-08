import { ScopeContext } from "../scope/context"
import { Lock } from "../util/lock"
import { Session } from "."
import { SessionManager } from "./manager"
import { WorkflowPromptRegistry } from "./workflow-prompt-registry"
import { WorkflowKindRegistry } from "./workflow-kind-registry"
import { SessionExecutionContributions } from "./execution-contributions"

export class WorkflowConflictError extends Error {
  constructor(
    public readonly state: string,
    reason: string,
  ) {
    super(reason)
    this.name = "WorkflowConflictError"
  }
}

export namespace SessionWorkflowService {
  export function lock(sessionID: string) {
    return Lock.write(`session-workflow:${ScopeContext.current.scope.id}:${sessionID}`)
  }
  export async function hasPendingExecution(session: Session.Info) {
    if (await SessionExecutionContributions.isActive(session)) return true
    const kind = WorkflowKindRegistry.effectiveKind(session.workflow)
    if (!kind) return false
    const contribution = WorkflowPromptRegistry.get(kind)
    return contribution?.isActive ? contribution.isActive(session) : !!WorkflowKindRegistry.get(kind)
  }
  export function current(session: Session.Info) {
    return session.workflow
  }
  export async function setNone(sessionID: string, options?: { allowRunning?: boolean }): Promise<Session.Info> {
    using _ = await lock(sessionID)
    if (!options?.allowRunning) SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    const kind = WorkflowKindRegistry.effectiveKind(session.workflow)
    if (kind) {
      await WorkflowPromptRegistry.get(kind)?.disable?.(sessionID)
      await WorkflowKindRegistry.get(kind)?.disable?.(sessionID)
    }
    return Session.update(sessionID, (draft) => {
      draft.workflow = undefined
    })
  }
  export async function set(sessionID: string, input: { kind: string; [key: string]: unknown }) {
    if (input.kind === "none") return setNone(sessionID)
    const descriptor = WorkflowKindRegistry.get(input.kind)
    if (!descriptor) throw new Error(`Workflow kind "${input.kind}" is not registered`)
    if (!descriptor.managesLock) return setExtension(sessionID, input.kind, input)
    await descriptor.enable({ sessionID, args: input })
    return Session.get(sessionID)
  }
  export async function setExtension(sessionID: string, kind: string, args: Record<string, unknown>) {
    const descriptor = WorkflowKindRegistry.get(kind)
    if (!descriptor) throw new Error(`Workflow kind "${kind}" is not registered`)
    using _ = await lock(sessionID)
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    const current = WorkflowKindRegistry.effectiveKind(session.workflow)
    if (current)
      throw new WorkflowConflictError(current, `Cannot enable ${kind} while the ${current} workflow is active.`)
    await SessionExecutionContributions.assertWorkflowAllowed(session, kind)
    await descriptor.enable({ sessionID, args })
    return Session.get(sessionID)
  }
}
