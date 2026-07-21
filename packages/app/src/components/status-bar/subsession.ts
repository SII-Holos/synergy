import type { Session } from "@ericsanchezok/synergy-sdk/client"
import type { I18n } from "@lingui/core"
import { statusBar as copy } from "@/locales/messages"

export type SubsessionCursor = {
  lastActivityAt: number
  id: string
}

export type SubsessionStatus = {
  waiting: boolean
  running: boolean
}

export function sessionActivityTime(session: Pick<Session, "time">): number {
  return session.time.updated ?? session.time.created
}

export function normalizeSubsessionSearch(value: string): string {
  return value.trim()
}

export function subsessionRangeLabel(
  pageIndex: number,
  pageSize: number,
  itemCount: number,
  total: number,
  i18n: I18n,
): string {
  if (total <= 0 || itemCount <= 0) return i18n._(copy.emptyRange)
  const start = pageIndex * pageSize + 1
  const end = Math.min(start + itemCount - 1, total)
  return i18n._({ ...copy.range, values: { start, end, total } })
}

export function subsessionCursorParams(cursor: SubsessionCursor | null | undefined): {
  cursorLastActivityAt?: number
  cursorId?: string
} {
  if (!cursor) return {}
  return {
    cursorLastActivityAt: cursor.lastActivityAt,
    cursorId: cursor.id,
  }
}

export function resolveSubsessionStatus(state: SubsessionStatus): "waiting" | "running" | "idle" {
  if (state.waiting) return "waiting"
  if (state.running) return "running"
  return "idle"
}
