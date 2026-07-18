import type { MessageDescriptor } from "@lingui/core"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { HOME_SCOPE_KEY } from "@/utils/scope"

export type SessionVisualState = {
  icon: IconName
  label: MessageDescriptor
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
  completionUnread?: boolean
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
    blueprint?: { loopID?: string; loopRole?: "execution" | "audit" }
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
  const unread = entry.completionNotice?.unread
  if (store) {
    const status = store.session_status[entry.id]
    const waiting = !!store.permission[entry.id]?.length || !!store.question[entry.id]?.length
    const running = status?.type === "busy" || status?.type === "retry"
    const childTasksRunning = store.cortex.some(
      (task) => task.parentSessionID === entry.id && task.status === "running",
    )
    const fullSession = store.session.find((session) => session.id === entry.id)

    if (fullSession?.blueprint?.loopID) {
      const blueprintIcon = getSemanticIcon("blueprint.main")
      if (waiting)
        return {
          icon: blueprintIcon,
          label: { id: "session.state.blueprintWaiting", message: "Blueprint waiting for you" },
          tone: "blueprint-waiting",
          pulse: true,
        }
      if (fullSession.blueprint.loopRole === "audit") {
        return {
          icon: getSemanticIcon("command.review"),
          label: { id: "session.state.auditingBlueprint", message: "Auditing Blueprint" },
          tone: "blueprint-audit",
          pulse: running || childTasksRunning ? true : undefined,
        }
      }
      if (running)
        return {
          icon: blueprintIcon,
          label: { id: "session.state.runningBlueprint", message: "Running Blueprint" },
          tone: "blueprint-running",
          pulse: true,
        }
      if (childTasksRunning)
        return {
          icon: getSemanticIcon("command.review"),
          label: { id: "session.state.auditingBlueprint", message: "Auditing Blueprint" },
          tone: "blueprint-audit",
          pulse: true,
        }
      return {
        icon: blueprintIcon,
        label: { id: "session.state.blueprint", message: "Blueprint session" },
        tone: "blueprint",
      }
    }
    if (waiting)
      return {
        icon: getSemanticIcon("session.waiting"),
        label: { id: "session.state.waiting", message: "Waiting for you" },
        tone: "waiting",
        pulse: true,
      }
    if (running || childTasksRunning)
      return {
        icon: getSemanticIcon("session.running"),
        label: { id: "session.state.running", message: "Running session" },
        tone: "active",
        pulse: true,
      }
    if (fullSession?.workspace?.type === "git_worktree") {
      return {
        icon: getSemanticIcon("workspace.worktree"),
        label: unread
          ? { id: "session.state.worktree.unread", message: "Worktree session; response ready" }
          : { id: "session.state.worktree", message: "Worktree session" },
        tone: "worktree",
        completionUnread: unread || undefined,
      }
    }
    if (entry.parentID) {
      return {
        icon: getSemanticIcon("session.child"),
        label: unread
          ? { id: "session.state.child.unread", message: "Child session; response ready" }
          : { id: "session.state.child", message: "Child session" },
        tone: "muted",
        completionUnread: unread || undefined,
      }
    }
  }

  if (entry.category === "github") {
    return {
      icon: getSemanticIcon("github.main"),
      label: unread
        ? { id: "session.state.github.unread", message: "GitHub session; response ready" }
        : { id: "session.state.github", message: "GitHub session" },
      tone: "muted",
      completionUnread: unread || undefined,
    }
  }
  if (entry.category === "background") {
    return {
      icon: getSemanticIcon("session.background"),
      label: unread
        ? { id: "session.state.background.unread", message: "Background session; response ready" }
        : { id: "session.state.background", message: "Background session" },
      tone: "muted",
      completionUnread: unread || undefined,
    }
  }
  if (entry.category === "channel") {
    return {
      icon: getSemanticIcon("channels.main"),
      label: unread
        ? { id: "session.state.channel.unread", message: "Channel session; response ready" }
        : { id: "session.state.channel", message: "Channel session" },
      tone: "muted",
      completionUnread: unread || undefined,
    }
  }
  if (entry.category === "home") {
    return {
      icon: getSemanticIcon("navigation.home"),
      label: unread
        ? { id: "session.state.home.unread", message: "Home session; response ready" }
        : { id: "session.state.home", message: "Home session" },
      tone: "default",
      completionUnread: unread || undefined,
    }
  }
  {
    return {
      icon: getSemanticIcon("session.default"),
      label: unread
        ? { id: "session.state.default.unread", message: "Session; response ready" }
        : { id: "session.state.default", message: "Session" },
      tone: "default",
      completionUnread: unread || undefined,
    }
  }
}
