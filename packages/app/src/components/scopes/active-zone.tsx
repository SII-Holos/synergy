import { createMemo, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { relativeTime } from "@/utils/time"
import type { Session, SessionStatus, PermissionRequest, QuestionRequest } from "@ericsanchezok/synergy-sdk/client"

type ChildStore = {
  session_status: { [sessionID: string]: SessionStatus }
  permission: { [sessionID: string]: PermissionRequest[] }
  question: { [sessionID: string]: QuestionRequest[] }
}

interface ActiveZoneProps {
  sessions: Session[]
  childStore: ChildStore
  childStatus?: Record<string, { count: number; running: number }>
  notification: {
    session: { unseen: (sessionID: string) => { type: string }[] }
  }
  onSelectSession: (session: Session) => void
}

type ActiveReason = "working" | "permission" | "error" | "notification"

function getActiveReason(
  session: Session,
  childStore: ChildStore,
  notification: ActiveZoneProps["notification"],
): ActiveReason | null {
  const status = childStore.session_status[session.id]
  if (status?.type === "busy" || status?.type === "retry") return "working"

  const permissions = childStore.permission[session.id] ?? []
  if (permissions.length > 0) return "permission"

  const unseen = notification.session.unseen(session.id)
  if (unseen.some((n) => n.type === "error")) return "error"
  if (unseen.length > 0) return "notification"

  return null
}

const REASON_ORDER: Record<ActiveReason, number> = {
  working: 0,
  permission: 1,
  error: 2,
  notification: 3,
}

export function ActiveZone(props: ActiveZoneProps) {
  const activeSessions = createMemo(() => {
    const result: { session: Session; reason: ActiveReason }[] = []

    for (const session of props.sessions) {
      const reason = getActiveReason(session, props.childStore, props.notification)
      if (reason) {
        result.push({ session, reason })
      }
    }

    result.sort((a, b) => {
      const orderDiff = REASON_ORDER[a.reason] - REASON_ORDER[b.reason]
      if (orderDiff !== 0) return orderDiff

      const ta = a.session.time.updated ?? a.session.time.created
      const tb = b.session.time.updated ?? b.session.time.created
      return tb - ta
    })

    return result
  })

  return (
    <Show when={activeSessions().length > 0}>
      <div class="px-6 pt-1 pb-3">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-1.5">
            <div class="size-1.5 rounded-full bg-icon-success-base animate-pulse" />
            <span class="text-11-medium text-text-weak uppercase tracking-wider">Active</span>
          </div>
          <span class="text-10-medium bg-surface-raised-base px-1.5 py-0.5 rounded-md">{activeSessions().length}</span>
        </div>

        <div class="flex gap-2.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <For each={activeSessions()}>
            {({ session, reason }, index) => (
              <ActiveCard
                session={session}
                reason={reason}
                childStore={props.childStore}
                childStatus={props.childStatus?.[session.id]}
                index={index}
                onSelect={props.onSelectSession}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

function ActiveCard(props: {
  session: Session
  reason: ActiveReason
  childStore: ChildStore
  childStatus?: { count: number; running: number }
  index: () => number
  onSelect: (session: Session) => void
}) {
  const statusText = createMemo(() => {
    if (props.reason === "working") {
      const status = props.childStore.session_status[props.session.id]
      if (status?.type === "retry") return status.message ?? "Retrying…"
      if (status?.type === "busy") return status.description ?? "Working…"
      return "Working…"
    }
    if (props.reason === "permission") return "Permission request"
    if (props.reason === "error") return "Error"
    return "New activity"
  })

  const updatedAt = () => props.session.time.updated ?? props.session.time.created
  const isPinned = () => props.session.pinned && props.session.pinned > 0

  return (
    <div
      class="min-w-[200px] max-w-[240px] flex flex-col rounded-[1.15rem] bg-surface-raised-base/90 p-3 border border-border-weaker-base/50 shadow-sm cursor-pointer transition-all duration-150 hover:bg-surface-raised-base-hover hover:border-border-base/60 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
      style={{
        animation: "cardPopIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        "animation-delay": `${props.index() * 40}ms`,
      }}
      onClick={() => props.onSelect(props.session)}
    >
      <div class="flex items-center gap-1.5 mb-2">
        <Show when={props.reason === "working"}>
          <Spinner class="size-3" />
        </Show>
        <Show when={props.reason === "permission"}>
          <div class="size-1.5 rounded-full bg-surface-warning-strong" />
        </Show>
        <Show when={props.reason === "error"}>
          <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
        </Show>
        <Show when={props.reason === "notification"}>
          <div class="size-1.5 rounded-full bg-text-interactive-base" />
        </Show>
        <span class="text-11-regular text-text-weak truncate">{statusText()}</span>
      </div>

      <span class="text-12-medium text-text-base line-clamp-2">{props.session.title || "New session"}</span>

      <Show when={props.childStatus && props.childStatus.count > 0}>
        <span class="text-10-regular text-text-weaker mt-1">
          {props.childStatus!.running > 0
            ? `${props.childStatus!.running}/${props.childStatus!.count} tasks running`
            : `${props.childStatus!.count} tasks`}
        </span>
      </Show>

      <div class="flex items-center justify-between mt-auto pt-2">
        <span class="text-10-regular text-text-weak">{relativeTime(updatedAt())}</span>
        <Show when={isPinned()}>
          <Icon name="pin" size="small" class="text-text-weaker size-3" />
        </Show>
      </div>
    </div>
  )
}
