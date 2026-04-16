import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel, isGlobalScope } from "@/utils/scope"
import { useLayout } from "./layout"
import { useGlobalSync } from "./global-sync"
import { useNotification } from "./notification"
import type { LocalScope } from "./layout"
import type { Message, Part, Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"

type PendingKind = "current" | "retrying" | "working" | "needs-input" | "error" | "unread"

const RECENT_WINDOW_MS = 1000 * 60 * 60 * 72
const MAX_RECENT_SESSIONS = 30
const RECENT_CLOCK_TICK_MS = 1000 * 60

export type RecentSessionPreview = {
  userText?: string
  assistantText?: string
}

export type RecentSessionBadge = {
  tone: PendingKind
  label: string
}

export type RecentSessionItem = {
  id: string
  session: Session
  scope: LocalScope
  recentAt: number
  isCurrent: boolean
  preview: RecentSessionPreview
  badge?: RecentSessionBadge
}

export type RecentSessionsSummary = {
  pendingCount: number
  workingCount: number
  needsInputCount: number
  label: string
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function truncate(text: string, max = 120) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  if (normalized.length <= max) return normalized
  return normalized.slice(0, max - 1).trimEnd() + "…"
}

function previewText(parts: Part[]) {
  const text = parts
    .filter(
      (part): part is Part & { type: "text"; text: string; ignored?: boolean; synthetic?: boolean } =>
        part.type === "text",
    )
    .filter((part) => !part.ignored && !part.synthetic)
    .map((part) => part.text)
    .join("\n\n")
  const value = truncate(text)
  if (value) return value

  const attachments = parts.filter((part) => part.type === "file")
  if (attachments.length > 1) return `[${attachments.length} files attached]`
  if (attachments.length === 1) {
    const attachment = attachments[0]
    if (attachment.mime.startsWith("image/")) return `[Image attached]`
    return `[File attached]`
  }
  return undefined
}

function latestMessagePreview(messages: Message[], partsByMessage: Record<string, Part[]>) {
  let userText: string | undefined
  let assistantText: string | undefined

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const preview = previewText(partsByMessage[message.id] ?? [])
    if (!preview) continue
    if (message.role === "user" && !userText) userText = preview
    if (message.role === "assistant" && !assistantText) assistantText = preview
    if (userText && assistantText) break
  }

  return { userText, assistantText }
}

function lastMeaningfulTime(session: Session, messages: Message[], notifications: Array<{ time: number }>) {
  let latest = session.time.created

  for (const message of messages) {
    if (message.role === "user") {
      latest = Math.max(latest, message.time.created)
      continue
    }
    latest = Math.max(latest, message.time.completed ?? message.time.created)
  }

  for (const notification of notifications) {
    latest = Math.max(latest, notification.time)
  }

  return latest
}

function getPendingKind(input: {
  isCurrent: boolean
  isRetrying: boolean
  isRunning: boolean
  hasPermission: boolean
  hasError: boolean
  unreadCount: number
}): PendingKind | undefined {
  if (input.isCurrent) return "current"
  if (input.isRetrying) return "retrying"
  if (input.isRunning) return "working"
  if (input.hasPermission) return "needs-input"
  if (input.hasError) return "error"
  if (input.unreadCount > 0) return "unread"
}

function pendingBadge(kind: PendingKind | undefined, unreadCount: number): RecentSessionBadge | undefined {
  switch (kind) {
    case "current":
      return { tone: kind, label: "Current" }
    case "retrying":
      return { tone: kind, label: "Retrying" }
    case "working":
      return { tone: kind, label: "Working" }
    case "needs-input":
      return { tone: kind, label: "Needs input" }
    case "error":
      return { tone: kind, label: "Error" }
    case "unread":
      return {
        tone: kind,
        label: unreadCount === 1 ? "1 unread" : `${unreadCount} unread`,
      }
  }
}

function pendingPriority(kind: PendingKind | undefined) {
  switch (kind) {
    case "current":
      return 6
    case "retrying":
      return 5
    case "working":
      return 4
    case "needs-input":
      return 3
    case "error":
      return 2
    case "unread":
      return 1
    default:
      return 0
  }
}

export const { use: useRecentSessions, provider: RecentSessionsProvider } = createSimpleContext({
  name: "RecentSessions",
  init: () => {
    const layout = useLayout()
    const globalSync = useGlobalSync()
    const notification = useNotification()
    const params = useParams()
    const [now, setNow] = createSignal(Date.now())
    const [recentItems, setRecentItems] = createStore<RecentSessionItem[]>([])

    const currentDirectory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
    const currentSessionID = createMemo(() => params.id)
    const scopes = createMemo(() => layout.scopes.list())

    createEffect(() => {
      if (typeof window === "undefined") return
      const intervalID = window.setInterval(() => setNow(Date.now()), RECENT_CLOCK_TICK_MS)
      onCleanup(() => window.clearInterval(intervalID))
    })

    const candidates = createMemo<RecentSessionItem[]>(() => {
      const recentCutoff = now() - RECENT_WINDOW_MS
      const currentDir = currentDirectory()
      const currentID = currentSessionID()
      const seen = new Set<string>()
      const output: RecentSessionItem[] = []

      for (const scope of scopes()) {
        const sessions = layout.nav.projectSessions(scope)
        for (const session of sessions) {
          if (!session.scope.directory) continue
          if (seen.has(session.id)) continue
          seen.add(session.id)

          const [childStore] = globalSync.child(session.scope.directory)
          const status = (childStore.session_status[session.id] ?? { type: "idle" }) as SessionStatus
          const allNotifications = notification.session.all(session.id)
          const unseenNotifications = notification.session.unseen(session.id)
          const unreadCount = unseenNotifications.length
          const hasError = unseenNotifications.some((entry) => entry.type === "error")
          const hasPermission = (childStore.permission[session.id]?.length ?? 0) > 0
          const isRetrying = status.type === "retry"
          const isRunning = status.type === "busy"
          const isCurrent = currentID === session.id && currentDir === session.scope.directory
          const messages = childStore.message[session.id] ?? []
          const recentAt = lastMeaningfulTime(session, messages, allNotifications)
          const kind = getPendingKind({
            isCurrent,
            isRetrying,
            isRunning,
            hasPermission,
            hasError,
            unreadCount,
          })

          if (!kind && recentAt < recentCutoff) continue

          output.push({
            id: session.id,
            session,
            scope,
            recentAt,
            isCurrent,
            preview: latestMessagePreview(messages, childStore.part),
            badge: pendingBadge(kind, unreadCount),
          })
        }
      }

      output.sort((a, b) => {
        if (b.recentAt !== a.recentAt) return b.recentAt - a.recentAt
        const priorityDiff = pendingPriority(b.badge?.tone) - pendingPriority(a.badge?.tone)
        if (priorityDiff !== 0) return priorityDiff
        return a.session.id.localeCompare(b.session.id)
      })

      return output
    })

    createEffect(() => {
      setRecentItems(reconcile(candidates().slice(0, MAX_RECENT_SESSIONS), { key: "id" }))
    })

    const summary = createMemo<RecentSessionsSummary>(() => {
      let pendingCount = 0
      let workingCount = 0
      let needsInputCount = 0

      for (const item of candidates()) {
        const tone = item.badge?.tone
        if (!tone) continue
        pendingCount += 1
        if (tone === "working" || tone === "retrying") workingCount += 1
        if (tone === "needs-input") needsInputCount += 1
      }

      let label = pluralize(pendingCount, "pending")
      if (needsInputCount > 0) label = pluralize(needsInputCount, "needs input", "need input")
      else if (workingCount > 0) label = pluralize(workingCount, "working")

      return {
        pendingCount,
        workingCount,
        needsInputCount,
        label,
      }
    })

    createEffect(() => {
      for (const item of recentItems.slice(0, 4)) {
        layout.nav.prefetchSession(item.session, item.isCurrent ? "low" : "high")
      }
    })

    return {
      list: () => recentItems,
      summary,
      currentSessionID,
      currentDirectory,
      sessionTitle(item: RecentSessionItem) {
        if (isGlobalScope(item.scope.worktree)) return "Home"
        return item.session.title || "New session"
      },
      scopeLabel(scope: LocalScope) {
        return getScopeLabel(scope)
      },
      prefetch(item: RecentSessionItem, priority: "high" | "low" = "high") {
        layout.nav.prefetchSession(item.session, priority)
      },
    }
  },
})
