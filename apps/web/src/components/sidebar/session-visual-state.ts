import type { MessageDescriptor } from "@lingui/core"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { HOME_SCOPE_KEY } from "@/utils/scope"
import { classifySessionActivity } from "@/utils/session-status"

export type SessionVisualState = {
  icon: IconName
  label: MessageDescriptor
  tone:
    | "default"
    | "active"
    | "retry"
    | "waiting"
    | "worktree"
    | "muted"
    | "blueprint"
    | "blueprint-running"
    | "blueprint-waiting"
    | "blueprint-audit"
    | "loop"
  pulse?: boolean
  completionUnread?: boolean
}

export interface SessionVisualScope {
  id?: string
  worktree?: string
}

/**
 * Resolve a session row's leading glyph from data that outlives a Scope store.
 *
 * Identity (Blueprint binding and phase, worktree, child, Light Loop) comes from
 * the nav entry, which is paginated, persisted, and refreshed by
 * `session.updated`; runtime activity, the pending-decision signal, and the
 * delegated-child-task pulse come from the global indexes. Nothing here reads a
 * per-Scope store, so evicting an inactive Scope — which happens the moment its
 * last retention lease is released, i.e. as soon as the user switches project —
 * can no longer degrade a row to a category fallback.
 *
 * The row's identity wins over its activity: a Blueprint-bound or Light Loop
 * session keeps its loop glyph while the loop is active, with tone and pulse
 * carrying whether it is working, waiting, or resting.
 *
 * The pulse is an input rather than part of the resolution because the caller
 * already holds the task collection and filtering it per row would repeat the
 * same scan. It is the global Cortex index, whose reach is process-wide, so it
 * survives eviction like the other two carriers.
 */
export interface SessionVisualInput {
  entry: NavEntry
  status?: SessionStatus
  waiting?: boolean
  /** Whether this session has a running delegated child task, from the global Cortex index. */
  runningChildTasks?: boolean
}

export function scopeKeyForNavEntry(entry: Pick<NavEntry, "scopeID" | "scopeType">, scopes: SessionVisualScope[]) {
  if (entry.scopeType === "home" || entry.scopeID === HOME_SCOPE_KEY) return HOME_SCOPE_KEY
  return scopes.find((scope) => scope.id === entry.scopeID)?.worktree
}

export function resolveSessionVisualState(input: SessionVisualInput): SessionVisualState {
  const { entry } = input
  const unread = entry.completionNotice?.unread
  const activity = classifySessionActivity({ status: input.status, waiting: input.waiting })
  const childTasksRunning = input.runningChildTasks === true
  const blueprintIcon = getSemanticIcon("blueprint.main")

  if (entry.blueprint?.loopID) {
    if (activity === "waiting")
      return {
        icon: blueprintIcon,
        label: { id: "session.state.blueprintWaiting", message: "Blueprint waiting for you" },
        tone: "blueprint-waiting",
        pulse: true,
      }
    if (entry.blueprint.loopRole === "audit" || entry.blueprint.phase === "auditing")
      return {
        icon: getSemanticIcon("command.review"),
        label: { id: "session.state.auditingBlueprint", message: "Auditing Blueprint" },
        tone: "blueprint-audit",
        pulse: activity === "working" || childTasksRunning ? true : undefined,
      }
    if (activity === "working")
      return {
        icon: blueprintIcon,
        label: { id: "session.state.runningBlueprint", message: "Running Blueprint" },
        tone: "blueprint-running",
        pulse: true,
      }
    if (childTasksRunning)
      return {
        icon: blueprintIcon,
        label: { id: "session.state.runningBlueprint", message: "Running Blueprint" },
        tone: "blueprint-running",
        pulse: true,
      }
    return {
      icon: blueprintIcon,
      label: { id: "session.state.blueprint", message: "Blueprint session" },
      tone: "blueprint",
      completionUnread: unread || undefined,
    }
  }

  if (entry.workflow?.kind === "lightloop" && entry.workflow.active) {
    if (activity === "waiting")
      return {
        icon: getSemanticIcon("prompt.lightLoop"),
        label: { id: "session.state.loopWaiting", message: "Light Loop waiting for you" },
        tone: "waiting",
        pulse: true,
      }
    if (activity === "working")
      return {
        icon: getSemanticIcon("prompt.lightLoop"),
        label: { id: "session.state.runningLoop", message: "Running Light Loop" },
        tone: "loop",
        pulse: true,
      }
    return {
      icon: getSemanticIcon("prompt.lightLoop"),
      label: unread
        ? { id: "session.state.loop.unread", message: "Light Loop session; response ready" }
        : { id: "session.state.loop", message: "Light Loop session" },
      tone: "loop",
      completionUnread: unread || undefined,
    }
  }

  if (activity === "waiting")
    return {
      icon: getSemanticIcon("session.waiting"),
      label: { id: "session.state.waiting", message: "Waiting for you" },
      tone: "waiting",
      pulse: true,
    }

  if (input.status?.type === "retry" || input.status?.type === "recovering")
    return {
      icon: getSemanticIcon("session.retry"),
      label: { id: "session.state.recovering", message: "Session recovering" },
      tone: "retry",
      pulse: true,
    }

  if (activity === "working" || childTasksRunning)
    return {
      icon: getSemanticIcon("session.running"),
      label: { id: "session.state.running", message: "Running session" },
      tone: "active",
      pulse: true,
    }

  if (entry.workspaceType === "git_worktree") {
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

  return categoryVisualState(entry, unread)
}

function categoryVisualState(entry: NavEntry, unread: boolean | undefined): SessionVisualState {
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
    const githubChannel = entry.channelType === "github"
    return {
      icon: githubChannel ? getSemanticIcon("github.main") : getSemanticIcon("channels.main"),
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
  return {
    icon: getSemanticIcon("session.default"),
    label: unread
      ? { id: "session.state.default.unread", message: "Session; response ready" }
      : { id: "session.state.default", message: "Session" },
    tone: "default",
    completionUnread: unread || undefined,
  }
}
