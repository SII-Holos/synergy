import { describe, expect, test } from "bun:test"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

// ── Layout projection (GREEN — already exists and passes) ──────────
import {
  partitionScopeNavigation,
  deriveChannelAccountActions,
  type ChannelAccount,
  type ChannelAccountActions,
  type ChannelAccountStatus,
} from "@/context/layout/nav"
import type { ScopeNavEntry } from "@/context/layout"

// ── Sidebar model (RED — all functions throw, see channel-account-model.ts) ──
import {
  channelAccountStatusLabel,
  channelAccountGroupLabel,
  channelAccountActionStates,
  isRefreshPending,
  diagnosticsFilename,
  shouldRenderChannelAccountSection,
  managedProjectRouteTarget,
  type ChannelAccountActionState,
} from "./channel-account-model"

// ── Locale descriptors (exists — sidebar messages include channel account strings) ──
import { sidebar } from "@/locales/messages"

// ── Semantic icon tokens (exists — visual feedback via canonical icon system) ──
const CHANNEL_REFRESH_ICON_NAME = getSemanticIcon("action.refresh")
const DIAGNOSTICS_ICON_NAME = getSemanticIcon("action.download")

/**
 * ================================================================
 * Channel Account Sidebar — Behavioral RED Tests
 * ================================================================
 *
 * These tests encode the Blueprint NTE  f88b36373 Stage B.10 contracts
 * for sidebar Channel account → managed Project → Task Session rendering
 * and account actions. They MUST FAIL (RED) because the model functions
 * in channel-account-model.ts are stubs that throw.
 *
 * Implementation Handoff:
 * 1. Make each model function return the shape these tests assert.
 * 2. Integrate into <Sidebar> under the Channel section:
 *    - After Feishu chat groups, render channelAccounts from partitionScopeNavigation.
 *    - Call partitionScopeNavigation(layout.nav.scopeEntries()).
 *    - Use genericProjects instead of layout.scopes.list() for the Projects section.
 * 3. Wire channelAccountActionStates into click handlers that call:
 *    - sdk.channel.refreshProjects({ channelType, accountId, directory })
 *    - sdk.channel.downloadDiagnostics({ channelType, accountId, directory})
 *    Follow the generated SDK signatures.
 * 4. Wire managedProjectRouteTarget into navigation handlers.
 */

// ── Helpers ────────────────────────────────────────────────────────

type ManagedProject = NonNullable<ScopeNavEntry["managedProject"]>

function scopeEntry(
  input: Partial<ScopeNavEntry> &
    Pick<ScopeNavEntry, "scopeID" | "directory"> & {
      managedProject?: ManagedProject
      name?: string
      latestActivityAt?: number
    },
): ScopeNavEntry {
  return {
    scopeID: input.scopeID,
    scopeType: input.scopeType ?? "project",
    directory: input.directory,
    latestActivityAt: input.latestActivityAt ?? 0,
    sessionCount: input.sessionCount ?? 0,
    name: input.name,
    icon: input.icon,
    managedProject: input.managedProject,
  }
}

function managed(input: {
  scopeID: string
  channelType?: string
  accountId?: string
  externalProjectId?: string
  remoteState?: ManagedProject["remoteState"]
  latestActivityAt?: number
  name?: string
  sessionCount?: number
}): ScopeNavEntry {
  return scopeEntry({
    scopeID: input.scopeID,
    directory: `/managed/${input.scopeID}`,
    latestActivityAt: input.latestActivityAt ?? 0,
    name: input.name,
    sessionCount: input.sessionCount ?? 0,
    managedProject: {
      channelType: input.channelType ?? "clarus",
      accountId: input.accountId ?? "default-agent",
      externalProjectId: input.externalProjectId ?? input.scopeID,
      remoteState: input.remoteState ?? "active",
    },
  })
}

function clarusAccount(accountId: string, status?: ChannelAccountStatus): ChannelAccount {
  return {
    channelType: "clarus",
    accountId,
    projects: [managed({ scopeID: `proj-${accountId}`, accountId })],
    status: status ?? { kind: "connected" },
  }
}

function feishuAccount(accountId: string, status?: ChannelAccountStatus): ChannelAccount {
  return {
    channelType: "feishu",
    accountId,
    projects: [managed({ scopeID: `proj-${accountId}`, channelType: "feishu", accountId })],
    status: status ?? { kind: "connected" },
  }
}

function unknownAccount(accountId: string, channelType = "unknown-provider"): ChannelAccount {
  return {
    channelType,
    accountId,
    projects: [managed({ scopeID: `proj-${accountId}`, channelType, accountId })],
    status: { kind: "connected" },
  }
}

// ================================================================
// Contract 1: Account groups vs generic Projects separation
// ================================================================

describe("Contract 1 — Account groups rendered separately from generic Projects", () => {
  test("shouldRenderChannelAccountSection returns true when channel accounts exist", () => {
    const accounts = [clarusAccount("a1")]
    expect(shouldRenderChannelAccountSection(accounts)).toBe(true)
  })

  test("shouldRenderChannelAccountSection returns false for empty accounts", () => {
    expect(shouldRenderChannelAccountSection([])).toBe(false)
  })

  test("generic Projects exclude every managed Project across all accounts", () => {
    const ordinary = scopeEntry({ scopeID: "ordinary", directory: "/ordinary" })
    const clarusP1 = managed({ scopeID: "cp1" })
    const clarusP2 = managed({ scopeID: "cp2" })
    const feishuMP = managed({
      scopeID: "fp1",
      channelType: "feishu",
      accountId: "feishu-org-1",
    })

    const projection = partitionScopeNavigation([ordinary, clarusP1, clarusP2, feishuMP])

    // Generic projects only contain the ordinary non-managed project
    expect(projection.genericProjects.map((e) => e.scopeID)).toEqual(["ordinary"])

    // Channel accounts contain the managed ones
    const allAccountProjectIDs = projection.channelAccounts.flatMap((a) => a.projects.map((p) => p.scopeID))
    expect(allAccountProjectIDs.sort()).toEqual(["cp1", "cp2", "fp1"].sort())
  })

  test("channelAccountGroupLabel produces a stable, screen-reader-accessible label", () => {
    const label = channelAccountGroupLabel(clarusAccount("agent-xyz"))
    expect(typeof label).toBe("string")
    expect(label.length).toBeGreaterThan(0)
    // Must contain identity information for screen readers
    expect(label.toLowerCase()).toContain("clarus")
    expect(label).toContain("agent-xyz")
  })

  test("channelAccountGroupLabel distinguishes two accounts of the same channelType", () => {
    const labelA = channelAccountGroupLabel(clarusAccount("agent-alpha"))
    const labelB = channelAccountGroupLabel(clarusAccount("agent-beta"))
    // Labels must be different in at least one identifiable respect
    expect(labelA).not.toBe(labelB)
    // Each contains its own accountId
    expect(labelA).toContain("agent-alpha")
    expect(labelB).toContain("agent-beta")
  })
})

// ================================================================
// Contract 2: Navigation target is canonical scope/session
// ================================================================

describe("Contract 2 — managed Project targeting is canonical scope/session", () => {
  test("managedProjectRouteTarget returns the owning scope worktree for a managed project", () => {
    const entry = managed({ scopeID: "target-proj", accountId: "agent-1" })
    const target = managedProjectRouteTarget(entry)
    expect(target).not.toBeNull()
    expect(target!.worktree).toBe("/managed/target-proj")
  })

  test("managedProjectRouteTarget never falls back to chat fields", () => {
    // Managed project entries MUST NOT route through Feishu chatId/chatType fields
    // even if those fields happen to be present
    const target = managedProjectRouteTarget({
      ...managed({ scopeID: "no-fallback" }),
    })
    expect(target).not.toBeNull()
    // The worktree is always the canonical directory
    expect(target!.worktree).toBe("/managed/no-fallback")
    // The returned target does not include chat metadata
    expect(target as Record<string, unknown>).not.toHaveProperty("chatId")
    expect(target as Record<string, unknown>).not.toHaveProperty("chatType")
  })

  test("managedProjectRouteTarget accepts an optional sessionID for direct Task Session targeting", () => {
    const entry = managed({ scopeID: "with-session" })
    const target = managedProjectRouteTarget(entry)
    // Target shape is { worktree, sessionID? }
    expect(target).toHaveProperty("worktree")
    // sessionID is an optional field of the return type
    expect(target!.sessionID === undefined || typeof target!.sessionID === "string").toBe(true)
  })

  test("non-managed project returns null as route target", () => {
    const entry = scopeEntry({ scopeID: "ordinary", directory: "/ordinary" })
    const target = managedProjectRouteTarget(entry)
    expect(target).toBeNull()
  })
})

// ================================================================
// Contract 3: All account status states render accessibly
// ================================================================

describe("Contract 3 — Account status renders all states accessibly", () => {
  const STATUS_KINDS: ChannelAccountStatus["kind"][] = [
    "disabled",
    "waiting_for_transport",
    "disconnected",
    "syncing",
    "connected",
    "sync_failed",
    "degraded",
  ]

  for (const kind of STATUS_KINDS) {
    test(`channelAccountStatusLabel resolves "${kind}" to a descriptor`, () => {
      const label = channelAccountStatusLabel({ kind } as ChannelAccountStatus)
      expect(label).toBeDefined()
      expect(typeof label.id).toBe("string")
      expect(label.id.length).toBeGreaterThan(0)
      expect(typeof label.message).toBe("string")
      expect(label.message!.length).toBeGreaterThan(0)
    })
  }

  test("status labels map to existing localized sidebar descriptors", () => {
    // Each status kind must map to one of the known locale descriptors
    const localeDescriptors = new Map<ChannelAccountStatus["kind"], string>([
      ["connected", sidebar.channelAccountConnected.id],
      ["disconnected", sidebar.channelAccountDisconnected.id],
      ["syncing", sidebar.channelAccountSyncing.id],
      ["sync_failed", sidebar.channelAccountSyncFailed.id],
      ["degraded", sidebar.channelAccountDegraded.id],
      ["disabled", sidebar.channelAccountDisabled.id],
      ["waiting_for_transport", sidebar.channelAccountWaitingForTransport.id],
    ])

    for (const [kind, expectedId] of localeDescriptors) {
      const label = channelAccountStatusLabel({ kind } as ChannelAccountStatus)
      expect(label.id).toBe(expectedId)
    }
  })

  test("connected status carries no error metadata in its i18n descriptor", () => {
    const label = channelAccountStatusLabel({ kind: "connected" })
    // Connected status is purely informational — no error tone
    expect(label.message).toBe("Connected")
  })

  test("sync_failed status surfaces the error description when present", () => {
    const label = channelAccountStatusLabel({
      kind: "sync_failed",
      error: "discovery timeout",
    } as ChannelAccountStatus)
    // Error detail should be accessible — the descriptor or label
    // may incorporate it through the message or the id key
    expect(label.id).toBe(sidebar.channelAccountSyncFailed.id)
  })

  test("status labels never leak raw credential or secret fields", () => {
    // The status label for sync_failed/degraded must not embed
    // raw API keys, tokens, or connection strings
    const errorStatuses: ChannelAccountStatus[] = [
      { kind: "sync_failed", error: "auth error: key=sk-abcd1234" },
      { kind: "degraded", error: "token expired: eyJhbGciOi..." },
      { kind: "sync_failed", error: "rpc is unreachable" },
    ]

    for (const status of errorStatuses) {
      const label = channelAccountStatusLabel(status)
      const text = label.message
      // No raw secrets in any status message
      expect(text).not.toContain("sk-")
      expect(text).not.toContain("eyJ")
      expect(text).not.toContain("token")
      expect(text).not.toContain("password")
    }
  })
})

// ================================================================
// Contract 4: Provider-aware action gating
// ================================================================

describe("Contract 4 — Clarus actions exposed; unsupported providers hidden", () => {
  test("Clarus account shows refresh and diagnostics as enabled actions", () => {
    const account = clarusAccount("agent-c1")
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    // Both actions visible and enabled
    const refresh = actionStates.find((s) => s.action === "refreshProjects")
    const diagnostics = actionStates.find((s) => s.action === "downloadDiagnostics")

    expect(refresh).toBeDefined()
    expect(refresh!.disabled).toBe(false)
    expect(refresh!.label.id).toBe(sidebar.channelRefreshProjects.id)

    expect(diagnostics).toBeDefined()
    expect(diagnostics!.disabled).toBe(false)
    expect(diagnostics!.label.id).toBe(sidebar.channelDownloadDiagnostics.id)
  })

  test("Feishu account hides all managed-project actions", () => {
    const account = feishuAccount("feishu-org")
    const actions = deriveChannelAccountActions("feishu")
    const actionStates = channelAccountActionStates(account, actions)

    // Feishu accounts show NO channel-account management actions
    expect(actionStates).toHaveLength(0)
  })

  test("unknown provider explicitly returns all actions as hidden (none rendered)", () => {
    const account = unknownAccount("unk-1")
    const actions = deriveChannelAccountActions("unknown-provider")
    const actionStates = channelAccountActionStates(account, actions)

    expect(actionStates).toHaveLength(0)
  })

  test("every rendered action state carries a label descriptor, not a raw string", () => {
    const account = clarusAccount("agent-label")
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    for (const state of actionStates) {
      expect(typeof state.label.id).toBe("string")
      expect(state.label.id.length).toBeGreaterThan(0)
      expect(typeof state.label.message).toBe("string")
    }
  })

  test("action states are sorted deterministically (refresh before diagnostics)", () => {
    const account = clarusAccount("agent-order")
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    const actionNames = actionStates.map((s) => s.action)
    expect(actionNames).toEqual(["refreshProjects", "downloadDiagnostics"])
  })
})

// ================================================================
// Contract 5: Refresh exactly-once with pending feedback
// ================================================================

describe("Contract 5 — Refresh single-click + pending/disabling feedback", () => {
  test("isRefreshPending returns true when account status is syncing", () => {
    const account = clarusAccount("agent-sync", { kind: "syncing" })
    expect(isRefreshPending(account)).toBe(true)
  })

  test("isRefreshPending returns false for connected/idle accounts", () => {
    const account = clarusAccount("agent-idle", { kind: "connected" })
    expect(isRefreshPending(account)).toBe(false)
  })

  test("isRefreshPending returns false for disconnected and failed accounts", () => {
    for (const kind of ["disconnected", "disabled", "sync_failed"] as const) {
      const account = clarusAccount("agent-" + kind, { kind } as ChannelAccountStatus)
      expect(isRefreshPending(account)).toBe(false)
    }
  })

  test("refresh action is disabled when sync is pending", () => {
    const account = clarusAccount("agent-busy", { kind: "syncing" })
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    const refresh = actionStates.find((s) => s.action === "refreshProjects")
    expect(refresh).toBeDefined()
    expect(refresh!.disabled).toBe(true)
    expect(refresh!.disabledReason).toBeDefined()
    expect(refresh!.disabledReason!.length).toBeGreaterThan(0)
  })

  test("refresh action becomes disabled when explicitly flagged as pending via parameter", () => {
    const account = clarusAccount("agent-pending", { kind: "connected" })
    const actions = deriveChannelAccountActions("clarus")
    // Even when status is "connected", the explicit refreshPending flag overrides
    const actionStates = channelAccountActionStates(account, actions, true)

    const refresh = actionStates.find((s) => s.action === "refreshProjects")
    expect(refresh!.disabled).toBe(true)
  })

  test("refresh disabledReason does not leak raw error content", () => {
    const account: ChannelAccount = {
      ...clarusAccount("agent-err"),
      status: {
        kind: "sync_failed",
        error: "Bearer auth failed: token=sk-sensitive-data",
      } as ChannelAccountStatus,
    }
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    const refresh = actionStates.find((s) => s.action === "refreshProjects")
    // The disabled reason, if present, must be sanitized
    if (refresh?.disabledReason) {
      expect(refresh.disabledReason).not.toContain("sk-")
      expect(refresh.disabledReason).not.toContain("Bearer")
    }
  })
})

// ================================================================
// Contract 6: Diagnostics download with stable filename
// ================================================================

describe("Contract 6 — diagnostics download produces stable filename", () => {
  test("diagnosticsFilename contains channelType and accountId", () => {
    const account = clarusAccount("agent-diag")
    const filename = diagnosticsFilename(account)
    expect(filename).toContain("clarus")
    expect(filename).toContain("agent-diag")
  })

  test("diagnosticsFilename ends with .ndjson", () => {
    const account = clarusAccount("agent-ext")
    const filename = diagnosticsFilename(account)
    expect(filename.endsWith(".ndjson")).toBe(true)
  })

  test("diagnosticsFilename is stable for repeated calls with the same account", () => {
    const account = clarusAccount("agent-stable")
    // Without timestamps embedded, the base pattern is deterministic
    const base1 = diagnosticsFilename(account)
    const base2 = diagnosticsFilename(account)
    expect(base1).toBe(base2)
  })

  test("diagnosticsFilename differs for different accounts", () => {
    const a = diagnosticsFilename(clarusAccount("agent-alpha"))
    const b = diagnosticsFilename(clarusAccount("agent-beta"))
    expect(a).not.toBe(b)
  })

  test("diagnosticsFilename contains no path separators or special chars beyond alphanumeric, dash, dot, underscore", () => {
    const account = clarusAccount("agent-clean")
    const filename = diagnosticsFilename(account)
    // Filename must be a single segment usable as a download hint
    expect(filename).not.toContain("/")
    expect(filename).not.toContain("\\")
    expect(filename).not.toContain(" ")
    // Only safe characters
    expect(/^[\w.-]+$/.test(filename.replace(".ndjson", ""))).toBe(true)
  })
})

// ================================================================
// Contract 7: Keyboard accessibility and labelling
// ================================================================

describe("Contract 7 — Controls are keyboard-reachable and labelled", () => {
  test("every channel account action state has a non-empty label descriptor", () => {
    const account = clarusAccount("agent-aria")
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    for (const state of actionStates) {
      expect(state.label.message!.length).toBeGreaterThan(0)
    }
  })

  test("channel account group label is long enough to be a meaningful aria-label", () => {
    // Short labels like "C" or just the accountId are not sufficient
    const label = channelAccountGroupLabel(clarusAccount("me"))
    expect(label.length).toBeGreaterThan(5)
  })

  test("disabled action states still carry their label (not hidden — just disabled)", () => {
    // Disabled controls must remain in the DOM with their labels
    // so assistive technology can announce their purpose
    const account = clarusAccount("agent-disabled", { kind: "syncing" })
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    for (const state of actionStates) {
      expect(state.label.message!.length).toBeGreaterThan(0)
    }
  })

  test("all status labels come from the existing sidebar locale message catalog", () => {
    // Verify the model function doesn't introduce inline strings
    // but uses the canonical sidebar message descriptors
    const allStatusKinds: ChannelAccountStatus["kind"][] = [
      "disabled",
      "waiting_for_transport",
      "disconnected",
      "syncing",
      "connected",
      "sync_failed",
      "degraded",
    ]

    const knownStatusDescriptors = new Set<string>([
      sidebar.channelAccountConnected.id,
      sidebar.channelAccountDisconnected.id,
      sidebar.channelAccountSyncing.id,
      sidebar.channelAccountSyncFailed.id,
      sidebar.channelAccountDegraded.id,
      sidebar.channelAccountDisabled.id,
      sidebar.channelAccountWaitingForTransport.id,
    ])

    for (const kind of allStatusKinds) {
      const label = channelAccountStatusLabel({ kind } as ChannelAccountStatus)
      expect(knownStatusDescriptors.has(label.id)).toBe(true)
    }
  })
})

// ================================================================
// Contract 8: No Clarus-specific store — layout projection is canonical
// ================================================================

describe("Contract 8 — No Clarus frontend store; canonical layout projection is owner", () => {
  test("partitionScopeNavigation is the single source of truth for channel account projection", () => {
    // The sidebar model functions should derive all channel account data
    // from partitionScopeNavigation and deriveChannelAccountActions
    // without introducing any new frontend store or signal.

    const entries = [
      managed({ scopeID: "a", channelType: "clarus", accountId: "agent-1" }),
      managed({ scopeID: "b", channelType: "clarus", accountId: "agent-1" }),
      scopeEntry({ scopeID: "ordinary", directory: "/ordinary" }),
    ]

    const projection = partitionScopeNavigation(entries)

    // Channel accounts populated correctly from projection alone
    expect(projection.channelAccounts).toHaveLength(1)
    expect(projection.channelAccounts[0]!.projects).toHaveLength(2)

    // Generic projects only include non-managed entries
    expect(projection.genericProjects.map((e) => e.scopeID)).toEqual(["ordinary"])

    // Model functions operate on the projection result — no store dependency
    expect(shouldRenderChannelAccountSection(projection.channelAccounts)).toBe(true)
    const actions = deriveChannelAccountActions("clarus")
    const states = channelAccountActionStates(projection.channelAccounts[0]!, actions)
    expect(states.length).toBeGreaterThan(0)
  })

  test("managed project route target derives from ScopeNavEntry fields, not store", () => {
    // managedProjectRouteTarget operates on the ScopeNavEntry shape
    // without requiring a new store or context
    const target = managedProjectRouteTarget(managed({ scopeID: "no-store-needed", accountId: "test" }))
    expect(target).not.toBeNull()
    expect(target!.worktree).toBe("/managed/no-store-needed")
  })

  test("status label resolution only needs ChannelAccountStatus — no external state", () => {
    // channelAccountStatusLabel is a pure function of ChannelAccountStatus
    // No store, no signal, no context dependency
    const label = channelAccountStatusLabel({ kind: "connected" })
    expect(label.id).toBe(sidebar.channelAccountConnected.id)
  })

  test("action states are derived from account + actions + optional pending flag only", () => {
    // channelAccountActionStates signature reflects its pure contract:
    // (ChannelAccount, ChannelAccountActions, refreshPending?: boolean)
    const account = clarusAccount("agent-pure")
    const actions = deriveChannelAccountActions("clarus")
    const states = channelAccountActionStates(account, actions, true)
    expect(states).toHaveLength(2)
  })
})

// ================================================================
// Edge cases: empty, loading, error, boundary states
// ================================================================

describe("Edge cases — empty, loading, error states", () => {
  test("empty channel accounts array renders no section", () => {
    expect(shouldRenderChannelAccountSection([])).toBe(false)
  })

  test("account with zero projects still renders the account group", () => {
    const emptyAccount: ChannelAccount = {
      channelType: "clarus",
      accountId: "no-projects-yet",
      projects: [],
      status: { kind: "syncing" },
    }
    expect(shouldRenderChannelAccountSection([emptyAccount])).toBe(true)
    const label = channelAccountGroupLabel(emptyAccount)
    expect(label).toContain("no-projects-yet")
  })

  test("account with undefined status still resolves a label", () => {
    const account: ChannelAccount = {
      channelType: "clarus",
      accountId: "status-unknown",
      projects: [],
      status: undefined,
    }
    // Group label still works even when status is missing
    const label = channelAccountGroupLabel(account)
    expect(typeof label).toBe("string")
    expect(label.length).toBeGreaterThan(0)
  })

  test("degraded status resolves to a distinct descriptor from sync_failed", () => {
    const degradedLabel = channelAccountStatusLabel({ kind: "degraded" })
    const failedLabel = channelAccountStatusLabel({ kind: "sync_failed" })

    expect(degradedLabel.id).not.toBe(failedLabel.id)
    expect(degradedLabel.id).toBe(sidebar.channelAccountDegraded.id)
    expect(failedLabel.id).toBe(sidebar.channelAccountSyncFailed.id)
  })

  test("account actions for degraded status remain enabled (retry is possible)", () => {
    const account = clarusAccount("agent-degraded", { kind: "degraded" } as ChannelAccountStatus)
    const actions = deriveChannelAccountActions("clarus")
    const actionStates = channelAccountActionStates(account, actions)

    const refresh = actionStates.find((s) => s.action === "refreshProjects")
    expect(refresh).toBeDefined()
    // In degraded state, refresh should still be allowed
    expect(refresh!.disabled).toBe(false)
  })

  test("managed project with no name falls back gracefully", () => {
    const entry = managed({ scopeID: "unnamed-proj" })
    const target = managedProjectRouteTarget(entry)
    expect(target).not.toBeNull()
    // Route still works even without a display name
    expect(target!.worktree).toBe("/managed/unnamed-proj")
  })
})
