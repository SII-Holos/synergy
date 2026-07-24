import type { ChannelAccount, ChannelAccountStatus } from "@/context/layout/nav"
import type { NavEntry, ScopeNavEntry } from "@/context/layout"
import type { AppMessageDescriptor } from "@/locales/messages"
import { sidebar } from "@/locales/messages"
// ── Status Labels ─────────────────────────────────────────────────────

/** Map every ChannelAccountStatus variant to an accessibility-safe i18n descriptor. */
export function channelAccountStatusLabel(status: ChannelAccountStatus): AppMessageDescriptor {
  const kind = status.kind
  switch (kind) {
    case "disabled":
      return sidebar.channelAccountDisabled
    case "waiting_for_transport":
      return sidebar.channelAccountWaitingForTransport
    case "disconnected":
      return sidebar.channelAccountDisconnected
    case "syncing":
      return sidebar.channelAccountSyncing
    case "connected":
      return sidebar.channelAccountConnected
    case "sync_failed":
      return sidebar.channelAccountSyncFailed
    case "degraded":
      return sidebar.channelAccountDegraded
  }
}

// ── Account Display ───────────────────────────────────────────────────

/** Produce a stable, human-readable label without exposing internal account identity. */
export function channelAccountGroupLabel(account: ChannelAccount): string {
  if (account.channelType === "clarus") return "Clarus"
  if (account.channelType === "feishu") return "Feishu"
  return account.channelType.charAt(0).toUpperCase() + account.channelType.slice(1)
}

export type ChannelProviderGroup = {
  channelType: string
  label: string
  projects: ScopeNavEntry[]
}

export function channelProviderGroups(accounts: readonly ChannelAccount[]): ChannelProviderGroup[] {
  const groups = new Map<string, ChannelProviderGroup>()
  for (const account of accounts) {
    const existing = groups.get(account.channelType)
    if (existing) {
      existing.projects.push(...account.projects)
      continue
    }
    groups.set(account.channelType, {
      channelType: account.channelType,
      label: channelAccountGroupLabel(account),
      projects: [...account.projects],
    })
  }
  return [...groups.values()]
}

/** Exclude Channel-managed worktrees from the ordinary Projects section while preserving order. */
export function filterGenericScopeWorktrees(
  worktrees: readonly string[],
  managedWorktrees: ReadonlySet<string>,
): string[] {
  return worktrees.filter((worktree) => !managedWorktrees.has(worktree))
}

// ── Section Prerequisites ──────────────────────────────────────────────

/** Check whether sidebar should render the channel account section at all. */
export function shouldRenderChannelAccountSection(accounts: ChannelAccount[]): boolean {
  return accounts.length > 0
}

// ── Navigation Targeting ──────────────────────────────────────────────

/** Construct the route target for a managed Project; never falls back to Feishu fields. */
export function managedProjectRouteTarget(entry: ScopeNavEntry): { worktree: string; sessionID?: string } | null {
  if (!entry.managedProject) return null
  return { worktree: entry.directory }
}

// ── Session Visibility ─────────────────────────────────────────────────

/** Managed Projects include channel Task Sessions; ordinary Projects remain project-only. */
export function selectVisibleProjectEntries(entries: readonly NavEntry[], isManaged: boolean): NavEntry[] {
  if (isManaged) {
    return entries.filter((entry) => entry.category === "project" || entry.category === "channel")
  }
  return entries.filter((entry) => entry.category === "project")
}
