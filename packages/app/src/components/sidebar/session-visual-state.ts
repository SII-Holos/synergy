import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { HOME_SCOPE_KEY } from "@/utils/scope"

export type SessionVisualState = {
  icon: IconName
  label: string
  tone:
    | "default"
    | "active"
    | "waiting"
    | "worktree"
    | "muted"
    | "blueprint"
    | "blueprint-running"
    | "blueprint-waiting"
    | "blueprint-audit"
  pulse?: boolean
}

export interface SessionVisualStore {
  session_status: Record<string, { type?: string } | undefined>
  permission: Record<string, unknown[] | undefined>
  question: Record<string, unknown[] | undefined>
  cortex: { parentSessionID?: string; status?: string }[]
  session: {
    id: string
    parentID?: string
    category?: string
    workspace?: { type?: string }
    blueprint?: { loopID?: string; loopRole?: "execution" | "audit"; planMode?: boolean }
  }[]
}

export interface SessionVisualScope {
  id?: string
  worktree?: string
}

export function scopeKeyForNavEntry(entry: Pick<NavEntry, "scopeID" | "scopeType">, scopes: SessionVisualScope[]) {
  if (entry.scopeType === "home" || entry.scopeID === HOME_SCOPE_KEY) return HOME_SCOPE_KEY
  return scopes.find((scope) => scope.id === entry.scopeID)?.worktree
}

export function resolveSessionVisualState(store: SessionVisualStore | undefined, entry: NavEntry): SessionVisualState {
  if (store) {
    const status = store.session_status[entry.id]
    const waiting = !!store.permission[entry.id]?.length || !!store.question[entry.id]?.length
    const running = status?.type === "busy" || status?.type === "retry"
    const childTasksRunning = store.cortex.some(
      (task) => task.parentSessionID === entry.id && task.status === "running",
    )
    const fullSession = store.session.find((session) => session.id === entry.id)

    if (fullSession?.blueprint?.loopID) {
      const blueprintIcon = getSemanticIcon("orchestration.blueprint")
      if (waiting)
        return { icon: blueprintIcon, label: "Blueprint waiting for you", tone: "blueprint-waiting", pulse: true }
      if (fullSession.blueprint.loopRole === "audit") {
        return {
          icon: blueprintIcon,
          label: "Auditing Blueprint",
          tone: "blueprint-audit",
          pulse: running || childTasksRunning ? true : undefined,
        }
      }
      if (running || childTasksRunning)
        return { icon: blueprintIcon, label: "Running Blueprint", tone: "blueprint-running", pulse: true }
      return { icon: blueprintIcon, label: "Blueprint session", tone: "blueprint" }
    }
    if (waiting)
      return { icon: getSemanticIcon("session.waiting"), label: "Waiting for you", tone: "waiting", pulse: true }
    if (running || childTasksRunning)
      return { icon: getSemanticIcon("session.running"), label: "Running session", tone: "active", pulse: true }
    if (fullSession?.workspace?.type === "git_worktree")
      return { icon: getSemanticIcon("workspace.worktree"), label: "Worktree session", tone: "worktree" }
    if (entry.parentID) return { icon: getSemanticIcon("session.child"), label: "Child session", tone: "muted" }
  }

  if (entry.category === "background")
    return { icon: getSemanticIcon("session.background"), label: "Background session", tone: "muted" }
  if (entry.category === "channel")
    return { icon: getSemanticIcon("session.channel"), label: "Channel session", tone: "muted" }
  if (entry.category === "home") return { icon: "home", label: "Home session", tone: "default" }
  return { icon: getSemanticIcon("session.default"), label: "Session", tone: "default" }
}
