import type { NavEntry, NavListState, ScopeNavEntry } from "./index"

// Instant in-place projection of a session.updated event onto a nav list
// (frontend sync redesign, P3). Applying the event directly gives the sidebar
// immediate feedback for an already-loaded session — title, pin, activity, and
// archival — without waiting on the debounced refetch, which still runs as the
// authority for ordering, new entries, and project-level aggregates. Because
// orderNavEntries sorts at read time, updating lastActivityAt in place is enough
// to reorder; no explicit re-sort is needed here.

export type NavSessionUpdate = {
  id: string
  title?: string
  pinned?: number
  lastActivityAt?: number
  archived: boolean
  parentID?: string
  completionNoticeUnread?: boolean
  completionNoticeUnreadCount?: number
}

export function navUpdateFromSession(
  info: {
    id: string
    title?: string
    pinned?: number
    parentID?: string
    time?: { updated?: number; archived?: number }
    completionNotice?: { unread?: boolean; unreadCount?: number }
  },
  navEntry?: Pick<NavEntry, "lastActivityAt">,
): NavSessionUpdate {
  return {
    id: info.id,
    title: info.title,
    pinned: info.pinned,
    lastActivityAt: navEntry?.lastActivityAt ?? info.time?.updated,
    archived: !!info.time?.archived,
    parentID: info.parentID,
    completionNoticeUnread: info.completionNotice?.unread,
    completionNoticeUnreadCount: info.completionNotice?.unreadCount,
  }
}

/**
 * Apply a session update to a nav list in place. Returns the (possibly new) list
 * and whether the entry was present. `applied: false` means the session is not
 * in this list (e.g. a brand-new session) and the caller should rely on the
 * refetch to surface it.
 */
export function applySessionToNavList(
  list: NavListState,
  update: NavSessionUpdate,
): { list: NavListState; applied: boolean } {
  const idx = list.items.findIndex((entry) => entry.id === update.id)
  if (idx === -1) return { list, applied: false }
  if (update.archived) {
    const items = list.items.filter((_, i) => i !== idx)
    return { list: { ...list, items, total: Math.max(0, list.total - 1) }, applied: true }
  }
  const prev = list.items[idx]
  const merged: NavEntry = {
    ...prev,
    title: update.title ?? prev.title,
    pinned: update.pinned ?? prev.pinned,
    lastActivityAt: update.lastActivityAt ?? prev.lastActivityAt,
    parentID: update.parentID ?? prev.parentID,
    completionNotice: {
      unread: update.completionNoticeUnread ?? prev.completionNotice.unread,
      unreadCount: update.completionNoticeUnreadCount ?? prev.completionNotice.unreadCount,
    },
  }
  const items = list.items.map((entry, i) => (i === idx ? merged : entry))
  return { list: { ...list, items }, applied: true }
}

export function githubNavQuery(limit: number, cursor?: { lastActivityAt: number; id: string }) {
  return {
    category: "github" as const,
    parentOnly: false,
    limit,
    ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
  }
}

export function orderNavEntries(entries: readonly NavEntry[]): NavEntry[] {
  return entries.toSorted((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    if (a.pinned && b.pinned) return b.pinned - a.pinned
    return b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id)
  })
}

export function mergeNavListByID(previous: NavListState | undefined, next: NavListState): NavListState {
  if (!previous) return next

  const previousByID = new Map(previous.items.map((entry) => [entry.id, entry]))
  return {
    ...next,
    items: next.items.map((entry) => {
      const previousEntry = previousByID.get(entry.id)
      if (!previousEntry) return entry
      return { ...previousEntry, ...entry }
    }),
  }
}

export function removeScopeFromIndex(
  entries: readonly ScopeNavEntry[],
  scopeID: string,
  fallbackDirectory?: string,
): { entries: ScopeNavEntry[]; directory?: string; removed: boolean } {
  const removed = entries.find((entry) => entry.scopeID === scopeID)
  if (!removed) return { entries: entries.slice(), directory: fallbackDirectory, removed: false }
  return {
    entries: entries.filter((entry) => entry.scopeID !== scopeID),
    directory: removed.directory || fallbackDirectory,
    removed: true,
  }
}

export type ChannelAccountStatus =
  | { kind: "disabled" }
  | { kind: "waiting_for_transport"; reason?: string }
  | { kind: "disconnected"; reason?: string }
  | { kind: "syncing" }
  | { kind: "connected" }
  | { kind: "sync_failed"; error?: string; lastGoodAt?: number }
  | { kind: "degraded"; error?: string }

export interface ChannelAccountActions {
  canRefreshProjects: boolean
  canDownloadDiagnostics: boolean
  hiddenActions: string[]
}

export interface ChannelAccount {
  channelType: string
  accountId: string
  projects: ScopeNavEntry[]
  status?: ChannelAccountStatus
}

export function partitionScopeNavigation(entries: readonly ScopeNavEntry[]): {
  genericProjects: ScopeNavEntry[]
  channelAccounts: ChannelAccount[]
} {
  const accountsByChannel = new Map<string, Map<string, ChannelAccount>>()
  const genericProjects: ScopeNavEntry[] = []
  for (const entry of entries) {
    if (entry.scopeType !== "project") continue
    const managedProject = entry.managedProject
    if (!managedProject) {
      genericProjects.push(entry)
      continue
    }
    let accounts = accountsByChannel.get(managedProject.channelType)
    if (!accounts) {
      accounts = new Map()
      accountsByChannel.set(managedProject.channelType, accounts)
    }
    let account = accounts.get(managedProject.accountId)
    if (!account) {
      account = {
        channelType: managedProject.channelType,
        accountId: managedProject.accountId,
        projects: [],
        status: { kind: "connected" },
      }
      accounts.set(managedProject.accountId, account)
    }
    account.projects.push(entry)
  }
  const channelAccounts = Array.from(accountsByChannel.values()).flatMap((accounts) => Array.from(accounts.values()))
  for (const account of channelAccounts) {
    account.projects.sort((a, b) => b.latestActivityAt - a.latestActivityAt || a.scopeID.localeCompare(b.scopeID))
  }
  channelAccounts.sort((a, b) => {
    if (a.channelType !== b.channelType) return a.channelType.localeCompare(b.channelType)
    return a.accountId.localeCompare(b.accountId)
  })
  return { genericProjects, channelAccounts }
}

const CHANNEL_ACCOUNT_PROVIDER_ACTIONS: Record<string, Partial<ChannelAccountActions>> = {
  clarus: {
    canRefreshProjects: true,
    canDownloadDiagnostics: true,
  },
}

export function deriveChannelAccountActions(channelType: string): ChannelAccountActions {
  const providerActions = CHANNEL_ACCOUNT_PROVIDER_ACTIONS[channelType]
  const canRefreshProjects = providerActions?.canRefreshProjects ?? false
  const canDownloadDiagnostics = providerActions?.canDownloadDiagnostics ?? false
  const hiddenActions: string[] = []
  if (!canRefreshProjects) hiddenActions.push("refreshProjects")
  if (!canDownloadDiagnostics) hiddenActions.push("downloadDiagnostics")
  return { canRefreshProjects, canDownloadDiagnostics, hiddenActions }
}
