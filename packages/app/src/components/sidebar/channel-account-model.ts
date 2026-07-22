/**
 * Channel Account Sidebar Model
 *
 * Pure model functions for Channel Account → managed Project → Task Session
 * sidebar rendering and account actions. All functions derive from the
 * canonical layout projection (partitionScopeNavigation / deriveChannelAccountActions).
 */

import type { ChannelAccount, ChannelAccountActions, ChannelAccountStatus } from "@/context/layout/nav"
import type { ScopeNavEntry } from "@/context/layout"
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

/** Produce a stable, screen-reader-safe label for a ChannelAccount group. */
export function channelAccountGroupLabel(account: ChannelAccount): string {
  return `${account.channelType}: ${account.accountId}`
}

// ── Account Actions ───────────────────────────────────────────────────

/** Resolve which account-level actions are available and in what state. */
export interface ChannelAccountActionState {
  action: "refreshProjects" | "downloadDiagnostics"
  label: AppMessageDescriptor
  /** Whether the action should be rendered as disabled (e.g. sync in progress). */
  disabled: boolean
  /** Non-empty when the action is disabled with a reason. */
  disabledReason?: string
  /** The keyboard shortcut hint, if any. */
  shortcut?: string
}

/** Return the sorted list of visible action states for a ChannelAccount. */
export function channelAccountActionStates(
  account: ChannelAccount,
  actions: ChannelAccountActions,
  refreshPending?: boolean,
): ChannelAccountActionState[] {
  const states: ChannelAccountActionState[] = []

  if (!actions.hiddenActions.includes("refreshProjects")) {
    const pending = refreshPending === true || isRefreshPending(account)
    states.push({
      action: "refreshProjects",
      label: sidebar.channelRefreshProjects,
      disabled: pending,
      disabledReason: pending ? "Sync is in progress" : undefined,
    })
  }

  if (!actions.hiddenActions.includes("downloadDiagnostics")) {
    states.push({
      action: "downloadDiagnostics",
      label: sidebar.channelDownloadDiagnostics,
      disabled: false,
    })
  }

  return states
}

/** Determine whether a ChannelAccount's refresh action is currently pending. */
export function isRefreshPending(account: ChannelAccount): boolean {
  return account.status?.kind === "syncing"
}

// ── Diagnostics ───────────────────────────────────────────────────────

/** Derive a stable diagnostics filename from account identity and timestamp. */
export function diagnosticsFilename(account: ChannelAccount): string {
  return `${account.channelType}-${account.accountId}-diagnostics.ndjson`
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
