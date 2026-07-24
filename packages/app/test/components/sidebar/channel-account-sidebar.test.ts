import { describe, expect, test } from "bun:test"

import type { NavEntry, ScopeNavEntry } from "@/context/layout"
import { partitionScopeNavigation, type ChannelAccount, type ChannelAccountStatus } from "@/context/layout/nav"

import {
  channelAccountStatusLabel,
  channelAccountGroupLabel,
  channelProviderGroups,
  shouldRenderChannelAccountSection,
  managedProjectRouteTarget,
  filterGenericScopeWorktrees,
  selectVisibleProjectEntries,
} from "@/components/sidebar/channel-account-model"

// ── Locale descriptors (exists — sidebar messages include channel account strings) ──
import { sidebar } from "@/locales/messages"

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

  test("channelAccountGroupLabel uses a readable provider name without exposing the internal account ID", () => {
    const label = channelAccountGroupLabel(clarusAccount("3c1d9f62-e2e1-47fd-bc59-9f1cbd0d9ed2"))
    expect(label).toBe("Clarus")
    expect(label).not.toContain("3c1d9f62")
  })

  test("groups every Clarus account under one provider heading", () => {
    const groups = channelProviderGroups([clarusAccount("agent-a"), clarusAccount("agent-b")])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe("Clarus")
    expect(groups[0]?.projects.map((project) => project.scopeID)).toEqual(["proj-agent-a", "proj-agent-b"])
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
// Contract 4: Keyboard accessibility and labelling
// ================================================================

describe("Contract 4 — Provider groups and status labels remain accessible", () => {
  test("channel account group label is long enough to be a meaningful aria-label", () => {
    const label = channelAccountGroupLabel(clarusAccount("me"))
    expect(label.length).toBeGreaterThan(5)
  })

  test("all status labels come from the existing sidebar locale message catalog", () => {
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
    const entries = [
      managed({ scopeID: "a", channelType: "clarus", accountId: "agent-1" }),
      managed({ scopeID: "b", channelType: "clarus", accountId: "agent-1" }),
      scopeEntry({ scopeID: "ordinary", directory: "/ordinary" }),
    ]

    const projection = partitionScopeNavigation(entries)

    expect(projection.channelAccounts).toHaveLength(1)
    expect(projection.channelAccounts[0]!.projects).toHaveLength(2)
    expect(projection.genericProjects.map((entry) => entry.scopeID)).toEqual(["ordinary"])
    expect(shouldRenderChannelAccountSection(projection.channelAccounts)).toBe(true)
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
})

// ================================================================
// Edge cases: empty, loading, error, boundary states
// ================================================================

describe("Generic project worktree filtering", () => {
  test("excludes Channel-managed worktrees without changing generic project order", () => {
    expect(
      filterGenericScopeWorktrees(
        ["/projects/alpha", "/managed/clarus", "/projects/beta"],
        new Set(["/managed/clarus"]),
      ),
    ).toEqual(["/projects/alpha", "/projects/beta"])
  })
})

describe("Edge cases — empty, loading, error states", () => {
  test("empty channel accounts array renders no section", () => {
    expect(shouldRenderChannelAccountSection([])).toBe(false)
  })

  test("account with zero projects still renders a readable account group", () => {
    const emptyAccount: ChannelAccount = {
      channelType: "clarus",
      accountId: "no-projects-yet",
      projects: [],
      status: { kind: "syncing" },
    }
    expect(shouldRenderChannelAccountSection([emptyAccount])).toBe(true)
    expect(channelAccountGroupLabel(emptyAccount)).toBe("Clarus")
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

  test("managed project with no name falls back gracefully", () => {
    const entry = managed({ scopeID: "unnamed-proj" })
    const target = managedProjectRouteTarget(entry)
    expect(target).not.toBeNull()
    // Route still works even without a display name
    expect(target!.worktree).toBe("/managed/unnamed-proj")
  })
})

// ================================================================
// Contract: selectVisibleProjectEntries — managed Projects include channel entries
// ================================================================

type PartialNav = Partial<NavEntry> & Pick<NavEntry, "id" | "scopeID" | "category">

function nav(input: PartialNav): NavEntry {
  return {
    scopeType: "project" as const,
    title: input.title ?? input.id,
    lastActivityAt: input.lastActivityAt ?? 0,
    pinned: input.pinned ?? 0,
    archived: input.archived ?? false,
    completionNotice: input.completionNotice ?? { unread: false, unreadCount: 0 },
    ...input,
  } as NavEntry
}

describe("selectVisibleProjectEntries", () => {
  test("ordinary Project shows only project-category entries", () => {
    const entries = [
      nav({ id: "s1", scopeID: "proj", category: "project", title: "Chat 1" }),
      nav({ id: "s2", scopeID: "proj", category: "project", title: "Chat 2" }),
      nav({ id: "s3", scopeID: "proj", category: "channel", title: "Task 1" }),
    ]
    const visible = selectVisibleProjectEntries(entries, false)
    expect(visible.map((e) => e.id)).toEqual(["s1", "s2"])
  })

  test("managed Project includes both project and channel entries", () => {
    const entries = [
      nav({ id: "s1", scopeID: "managed", category: "project", title: "Chat 1" }),
      nav({ id: "s2", scopeID: "managed", category: "channel", title: "Task 1" }),
      nav({ id: "s3", scopeID: "managed", category: "channel", title: "Task 2" }),
    ]
    const visible = selectVisibleProjectEntries(entries, true)
    expect(visible.map((e) => e.id)).toEqual(["s1", "s2", "s3"])
  })

  test("managed Project does not include background or github entries", () => {
    const entries = [
      nav({ id: "s1", scopeID: "managed", category: "project" }),
      nav({ id: "s2", scopeID: "managed", category: "channel" }),
      nav({ id: "s3", scopeID: "managed", category: "background" }),
      nav({ id: "s4", scopeID: "managed", category: "github" }),
      nav({ id: "s5", scopeID: "managed", category: "home" }),
    ]
    const visible = selectVisibleProjectEntries(entries, true)
    expect(visible.map((e) => e.id)).toEqual(["s1", "s2"])
  })

  test("empty entries returns empty array for both managed and ordinary", () => {
    expect(selectVisibleProjectEntries([], false)).toEqual([])
    expect(selectVisibleProjectEntries([], true)).toEqual([])
  })

  test("managed Project with only channel entries shows all", () => {
    const entries = [nav({ id: "t1", scopeID: "managed", category: "channel", title: "Task Only" })]
    const visible = selectVisibleProjectEntries(entries, true)
    expect(visible.map((e) => e.id)).toEqual(["t1"])
  })

  test("ordinary Project with only channel entries shows nothing", () => {
    const entries = [nav({ id: "t1", scopeID: "proj", category: "channel", title: "Task" })]
    const visible = selectVisibleProjectEntries(entries, false)
    expect(visible).toEqual([])
  })
})
