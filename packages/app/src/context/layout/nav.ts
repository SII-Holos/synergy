import type { LocalScope, NavCursor, NavEntry, NavListState, ScopeNavEntry } from "./index"

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

export function removeScopeFromNavList(list: NavListState, scopeID: string): NavListState {
  const items = list.items.filter((entry) => entry.scopeID !== scopeID)
  const removedCount = list.items.length - items.length
  if (removedCount === 0) return list
  return { ...list, items, total: Math.max(0, list.total - removedCount) }
}

export function channelNavQuery(limit: number, cursor?: { lastActivityAt: number; id: string }) {
  return {
    category: "channel" as const,
    channelType: "feishu",
    parentOnly: true,
    includeArchived: true,
    limit,
    ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
  }
}

export function channelGithubNavQuery(limit: number, cursor?: { lastActivityAt: number; id: string }) {
  return {
    category: "channel" as const,
    channelType: "github",
    parentOnly: true,
    includeArchived: true,
    limit,
    ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
  }
}

export type ChannelNavType = "feishu" | "github"
export type ChannelNavCursors = Record<ChannelNavType, NavCursor | null>

export type ChannelNavPage = {
  channelType: ChannelNavType
  items: NavEntry[]
  nextCursor: NavCursor | null
  total: number
}

/** Merge per-channel-type pages (feishu + github) into one Channel section list. */
export function mergeChannelNavPages(
  existing: NavListState | undefined,
  pages: ReadonlyArray<ChannelNavPage>,
  mode: "replace" | "append" = "replace",
): NavListState {
  const byID = new Map<string, NavEntry>()
  if (mode === "append") {
    for (const item of existing?.items ?? []) byID.set(item.id, item)
  }
  for (const page of pages) {
    for (const item of page.items) byID.set(item.id, item)
  }
  const items = orderNavEntries([...byID.values()])
  const channelCursors: ChannelNavCursors = {
    feishu: existing?.channelCursors?.feishu ?? null,
    github: existing?.channelCursors?.github ?? null,
  }
  for (const page of pages) channelCursors[page.channelType] = page.nextCursor
  const hasMore = channelCursors.feishu != null || channelCursors.github != null
  const last = items.at(-1)
  return {
    items,
    total: items.length,
    nextCursor: hasMore && last ? { lastActivityAt: last.lastActivityAt, id: last.id } : null,
    channelCursors,
  }
}

export type RootNavSectionKey = "home" | "channel" | "background"
export function removeScopeFromLoadedNavigation(
  input: {
    recent: NavListState
    root: Record<RootNavSectionKey, NavListState>
  },
  scopeID: string,
) {
  const recent = removeScopeFromNavList(input.recent, scopeID)
  const root = {
    home: removeScopeFromNavList(input.root.home, scopeID),
    channel: removeScopeFromNavList(input.root.channel, scopeID),
    background: removeScopeFromNavList(input.root.background, scopeID),
  }
  const affectedRoot = (Object.keys(root) as RootNavSectionKey[]).filter((key) => root[key] !== input.root[key])
  return {
    recent,
    root,
    affected: {
      recent: recent !== input.recent,
      root: affectedRoot,
    },
  }
}

export function rootNavRequest(
  category: RootNavSectionKey,
  limit: number,
  cursor?: { lastActivityAt: number; id: string },
  options?: { includeBackgroundChildren?: boolean },
) {
  if (category === "channel") return { source: "global" as const, query: channelNavQuery(limit, cursor) }
  // Background entries (boss workers, Cortex tasks, agenda sessions) carry a
  // parentID; include them only while Runtime Boss Mode is enabled so the
  // sidebar shows boss workers — other sections stay parent-only, and
  // non-boss deployments keep the pre-boss background filtering.
  const parentOnly: "true" | "false" =
    category === "background" && options?.includeBackgroundChildren ? "false" : "true"
  return {
    source: "scope" as const,
    query: {
      scopeID: "home",
      category,
      parentOnly,
      limit,
      ...(cursor ? { cursorLastActivityAt: cursor.lastActivityAt, cursorId: cursor.id } : {}),
    },
  }
}

export function rootNavSectionsForSessionUpdate(input: {
  scopeID?: string
  navCategory?: NavEntry["category"]
  channelType?: string
  channelApplied: boolean
}): RootNavSectionKey[] {
  if (input.scopeID === "home") return ["home", "channel", "background"]
  if (
    (input.navCategory === "channel" && (input.channelType === "feishu" || input.channelType === "github")) ||
    input.channelApplied
  ) {
    return ["channel"]
  }
  return []
}

export async function loadNavListToDepth(input: {
  depth: number
  pageLimit: number
  fetchPage: (limit: number, cursor?: NavCursor) => Promise<NavListState | undefined>
}): Promise<NavListState | undefined> {
  const items: NavEntry[] = []
  let cursor: NavCursor | undefined
  let nextCursor: NavCursor | null = null
  let total = 0

  while (items.length < input.depth) {
    const page = await input.fetchPage(Math.min(input.pageLimit, input.depth - items.length), cursor)
    if (!page) return undefined
    items.push(...page.items)
    total = page.total
    nextCursor = page.nextCursor
    if (!nextCursor || page.items.length === 0) break
    cursor = nextCursor
  }

  return { items, nextCursor, total }
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

export function managedProjectLocalScope(
  entry: ScopeNavEntry,
  metadata: Partial<LocalScope> | undefined,
  expanded: boolean,
): LocalScope {
  return {
    ...metadata,
    id: entry.scopeID,
    worktree: entry.directory,
    name: entry.name ?? metadata?.name,
    icon: { url: entry.icon?.url ?? metadata?.icon?.url, color: entry.icon?.color ?? metadata?.icon?.color },
    expanded,
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
export function managedProjectScopesByWorktree(
  accounts: readonly ChannelAccount[],
  metadataByID: ReadonlyMap<string, Partial<LocalScope>>,
  expandedWorktrees: ReadonlySet<string>,
): Map<string, LocalScope> {
  return new Map(
    accounts.flatMap((account) =>
      account.projects.map((entry) => [
        entry.directory,
        managedProjectLocalScope(entry, metadataByID.get(entry.scopeID), expandedWorktrees.has(entry.directory)),
      ]),
    ),
  )
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
  github: {
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
export function sameScopeIndex(previous: readonly ScopeNavEntry[], next: readonly ScopeNavEntry[]): boolean {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  return previous.every((entry, index) => {
    const candidate = next[index]
    if (!candidate) return false
    if (
      entry.scopeID !== candidate.scopeID ||
      entry.scopeType !== candidate.scopeType ||
      entry.name !== candidate.name ||
      entry.directory !== candidate.directory ||
      entry.latestActivityAt !== candidate.latestActivityAt ||
      entry.sessionCount !== candidate.sessionCount ||
      entry.icon?.url !== candidate.icon?.url ||
      entry.icon?.color !== candidate.icon?.color
    ) {
      return false
    }
    const a = entry.managedProject
    const b = candidate.managedProject
    if (a === b) return true
    if (!a || !b) return false
    return (
      a.channelType === b.channelType &&
      a.accountId === b.accountId &&
      a.externalProjectId === b.externalProjectId &&
      a.remoteState === b.remoteState
    )
  })
}
