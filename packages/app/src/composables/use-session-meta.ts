import type { Session, SessionCortexDelegation } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, type Accessor } from "solid-js"
export interface SessionMeta {
  // Source
  source: "web" | "channel"

  // Hierarchy
  isSubsession: boolean
  isCortexSubagent: boolean
  parentID: string | null

  // Cortex delegation (full object for SubagentSessionFooter)
  cortex: SessionCortexDelegation | undefined

  // Interaction mode
  isUnattended: boolean
  isAgenda: boolean

  // Read/write state
  isReadOnly: boolean
  canSelectModel: boolean
  showInputBar: boolean
  showBackToParent: boolean

  // Workspace
  workspaceType: string
  isWorktree: boolean
  workspaceName: string
  branch: string | undefined
}

const DEFAULT_META: SessionMeta = {
  source: "web",
  isSubsession: false,
  isCortexSubagent: false,
  parentID: null,
  cortex: undefined,
  isUnattended: false,
  isAgenda: false,
  isReadOnly: false,
  canSelectModel: true,
  showInputBar: true,
  showBackToParent: false,
  workspaceType: "main",
  isWorktree: false,
  workspaceName: "main",
  branch: undefined,
}

export function deriveSessionMeta(session: Session | undefined, hasMessages: boolean): SessionMeta {
  if (!session) return DEFAULT_META

  const endpointKind = session.endpoint?.kind
  const source: SessionMeta["source"] = endpointKind === "channel" ? "channel" : "web"

  const isSubsession = session.parentID != null
  const isCortexSubagent = session.cortex != null
  const parentID = session.parentID ?? null
  const isUnattended = session.interaction?.mode === "unattended"
  const isAgenda = session.agenda != null
  const isReadOnly = isCortexSubagent && hasMessages
  const canSelectModel = !isReadOnly
  const showInputBar = !isReadOnly
  const showBackToParent = isSubsession && parentID !== null

  const workspaceType = session.workspace?.type ?? "main"
  const isWorktree = workspaceType === "git_worktree"
  const wsExtra = session.workspace as Record<string, unknown> | undefined
  const workspaceName: string = (wsExtra?.name as string) ?? (isWorktree ? "worktree" : "main")
  const branch: string | undefined = (wsExtra?.branch as string | undefined) ?? undefined

  return {
    source,
    isSubsession,
    isCortexSubagent,
    parentID,
    cortex: session.cortex ?? undefined,
    isUnattended,
    isAgenda,
    isReadOnly,
    canSelectModel,
    showInputBar,
    showBackToParent,
    workspaceType,
    isWorktree,
    workspaceName,
    branch,
  }
}
export function useSessionMeta(
  session: Accessor<Session | undefined>,
  hasMessages: Accessor<boolean>,
): Accessor<SessionMeta> {
  return createMemo(() => deriveSessionMeta(session(), hasMessages()))
}
