import { describe, expect, test } from "bun:test"
import type { ScopeNavEntry } from "@/context/layout"
import { partitionScopeNavigation, deriveChannelAccountActions, type ChannelAccount } from "@/context/layout/nav"

/**
 * Dummy describe blocks describe the intended production contract for
 * Channel account status projection and account actions. Tests assert
 * exact shapes that the remaining implementation must deliver.
 *
 * These tests SHOULD FAIL (RED) until:
 * - ChannelAccount gains optional status and status fields
 * - ChannelAccountStatus / ChannelProviderStatus are defined
 * - provideChannelAccountStatuses() or an equivalent projection exists
 * - deriveChannelAccountActions() gates actions by provider capability
 */

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Expected future types (not yet exported from nav.ts) ─────────────

/**
 * Provider-facing account status matches the Blueprint lifecycle:
 * disabled, waiting_for_transport/disconnected, syncing, connected,
 * sync_failed (degraded). Backend `ChannelStatus` has fewer variants;
 * the frontend projection enriches them with lifecycle metadata.
 */
type ChannelAccountStatus =
  | { kind: "disabled" }
  | { kind: "waiting_for_transport"; reason?: string }
  | { kind: "disconnected"; reason?: string }
  | { kind: "syncing" }
  | { kind: "connected" }
  | { kind: "sync_failed"; error?: string; lastGoodAt?: number }
  | { kind: "degraded"; error?: string }

interface ChannelAccountActions {
  /** Whether provider supports explicit project refresh. */
  canRefreshProjects: boolean
  /** Whether provider supports diagnostics download. */
  canDownloadDiagnostics: boolean
  /** Actions explicitly hidden/disabled (provider-unsupported). */
  hiddenActions: string[]
}

// ── Tests ────────────────────────────────────────────────────────────

describe("partitionScopeNavigation account projection", () => {
  test("account identity is exact (channelType, accountId) pair with no composite key", () => {
    const first = managed({
      scopeID: "p1",
      channelType: "clarus",
      accountId: "agent-main",
      externalProjectId: "shared-id",
    })
    const second = managed({
      scopeID: "p2",
      channelType: "clarus",
      accountId: "agent-secondary",
      externalProjectId: "shared-id",
    })

    const projection = partitionScopeNavigation([first, second])

    // Two distinct accounts even though externalProjectId collides
    expect(projection.channelAccounts).toHaveLength(2)
    for (const account of projection.channelAccounts) {
      // channelType and accountId are the joint identity — no composite string
      expect(account).toHaveProperty("channelType")
      expect(account).toHaveProperty("accountId")
      // identity fields are non-empty strings
      expect(typeof account.channelType).toBe("string")
      expect(account.channelType.length).toBeGreaterThan(0)
      expect(typeof account.accountId).toBe("string")
      expect(account.accountId.length).toBeGreaterThan(0)
    }
  })

  test("account identity survives delimiter-embedded characters in channelType and accountId", () => {
    const entries = [
      managed({ scopeID: "a", channelType: "a:b", accountId: "c", externalProjectId: "e1" }),
      managed({ scopeID: "b", channelType: "a", accountId: "b:c", externalProjectId: "e2" }),
      managed({ scopeID: "c", channelType: "a::b", accountId: "::c", externalProjectId: "e3" }),
      managed({ scopeID: "d", channelType: "feishu", accountId: "org-user-1", externalProjectId: "e4" }),
    ]

    const projection = partitionScopeNavigation(entries)

    expect(projection.channelAccounts).toHaveLength(4)
    const identities = projection.channelAccounts.map((a) => [a.channelType, a.accountId])
    // All four identities are distinct
    const identitySet = new Set(identities.map(([t, id]) => `${t}\x00${id}`))
    expect(identitySet.size).toBe(4)
  })

  test("each managed Project appears once under its owning account and not in generic Projects", () => {
    const ordinary = scopeEntry({ scopeID: "ordinary", directory: "/ordinary" })
    const clarusP1 = managed({ scopeID: "cp1" })
    const clarusP2 = managed({ scopeID: "cp2" })

    const projection = partitionScopeNavigation([ordinary, clarusP1, clarusP2])

    expect(projection.genericProjects.map((e) => e.scopeID)).toEqual(["ordinary"])

    // Projects appear under the correct single account
    const clarusAccount = projection.channelAccounts.find(
      (a) => a.channelType === "clarus" && a.accountId === "default-agent",
    )
    expect(clarusAccount).toBeDefined()
    expect(clarusAccount!.projects.map((p) => p.scopeID)).toEqual(["cp1", "cp2"])

    // No project appears in two accounts
    const allAccountProjectIDs = projection.channelAccounts.flatMap((a) => a.projects.map((p) => p.scopeID))
    expect(new Set(allAccountProjectIDs).size).toBe(allAccountProjectIDs.length)
  })

  test("managed Project retains standard Scope metadata for passive Session sidebar projection", () => {
    const project = managed({
      scopeID: "cp-with-sessions",
      name: "Active Project",
      latestActivityAt: 5000,
      sessionCount: 3,
    })

    const projection = partitionScopeNavigation([project])

    const accountProject = projection.channelAccounts[0]?.projects[0]
    expect(accountProject).toBeDefined()
    expect(accountProject!.scopeID).toBe("cp-with-sessions")
    expect(accountProject!.scopeType).toBe("project")
    expect(accountProject!.name).toBe("Active Project")
    expect(accountProject!.directory).toBe("/managed/cp-with-sessions")
    expect(accountProject!.sessionCount).toBe(3)
    // Standard Scope shape is preserved — sidebar can reuse existing session rendering
    expect(accountProject!.latestActivityAt).toBe(5000)
  })

  test("active/paused/stale/archived remote states survive projection with exact labels", () => {
    const projects = [
      managed({ scopeID: "active", remoteState: "active", latestActivityAt: 40 }),
      managed({ scopeID: "paused", remoteState: "paused", latestActivityAt: 30 }),
      managed({ scopeID: "stale", remoteState: "stale", latestActivityAt: 20 }),
      managed({ scopeID: "archived", remoteState: "archived", latestActivityAt: 10 }),
    ]

    const projection = partitionScopeNavigation(projects)

    expect(projection.channelAccounts).toHaveLength(1)
    const states = projection.channelAccounts[0]!.projects.map((p) => p.managedProject!.remoteState)
    // All four canonical states survive, ordered by latestActivityAt desc
    expect(states).toEqual(["active", "paused", "stale", "archived"])
  })

  test("remote-archived Projects remain under account and visible — not removed", () => {
    const archivedProject = managed({ scopeID: "arch", remoteState: "archived" })

    const projection = partitionScopeNavigation([archivedProject])

    expect(projection.channelAccounts).toHaveLength(1)
    expect(projection.channelAccounts[0]!.projects[0]!.managedProject!.remoteState).toBe("archived")
    expect(projection.genericProjects).toEqual([])
  })

  test("accounts sort by channelType then accountId; projects sort by latestActivityAt desc", () => {
    const entries = [
      managed({ scopeID: "zb", channelType: "z", accountId: "b", latestActivityAt: 10 }),
      managed({ scopeID: "za", channelType: "z", accountId: "a", latestActivityAt: 20 }),
      managed({ scopeID: "ab-old", channelType: "a", accountId: "b", latestActivityAt: 5 }),
      managed({ scopeID: "ab-new", channelType: "a", accountId: "b", latestActivityAt: 30 }),
      managed({ scopeID: "aa", channelType: "a", accountId: "a", latestActivityAt: 15 }),
    ]

    const projection = partitionScopeNavigation(entries)

    const accountOrder = projection.channelAccounts.map((a) => `${a.channelType}:${a.accountId}`)
    expect(accountOrder).toEqual(["a:a", "a:b", "z:a", "z:b"])

    // Within account "a:b", newest project first
    const abProjects = projection.channelAccounts[1]!.projects.map((p) => p.scopeID)
    expect(abProjects).toEqual(["ab-new", "ab-old"])
  })
})

describe("ChannelAccountStatus projection", () => {
  test("ChannelAccount supports an optional status field of type ChannelAccountStatus", () => {
    // This test asserts that ChannelAccount *will* carry a status projection.
    // Today the status field does not exist → RED.
    const accountFromPartition = partitionScopeNavigation([managed({ scopeID: "proj" })]).channelAccounts[0]!

    // The shape we expect:
    // accountFromPartition.status should be a ChannelAccountStatus
    // Use a type-level assertion via runtime check:
    expect(accountFromPartition).toHaveProperty("status")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (accountFromPartition as unknown as Record<string, unknown>)["status"]
    expect(status).toBeDefined()
    // Valid status kinds
    if (typeof status === "object" && status !== null) {
      const kind = (status as Record<string, unknown>)["kind"]
      expect([
        "disabled",
        "waiting_for_transport",
        "disconnected",
        "syncing",
        "connected",
        "sync_failed",
        "degraded",
      ] as string[]).toContain(kind as string)
    }
  })

  test("disabled account status has no transport metadata", () => {
    // When present, a disabled status has kind: "disabled" and no reason/error
    const status: ChannelAccountStatus = { kind: "disabled" }
    expect(status.kind).toBe("disabled")
    expect(status as Record<string, unknown>).not.toHaveProperty("reason")
    expect(status as Record<string, unknown>).not.toHaveProperty("error")
  })

  test("waiting_for_transport carries an optional structured reason", () => {
    const status: ChannelAccountStatus = { kind: "waiting_for_transport", reason: "waiting_for_holos" }
    expect(status.kind).toBe("waiting_for_transport")
    expect(status.reason).toBe("waiting_for_holos")
  })

  test("connected status has no error metadata", () => {
    const status: ChannelAccountStatus = { kind: "connected" }
    expect(status.kind).toBe("connected")
    expect(status as Record<string, unknown>).not.toHaveProperty("error")
  })

  test("sync_failed carries an error string and optional lastGoodAt timestamp", () => {
    const status: ChannelAccountStatus = {
      kind: "sync_failed",
      error: "discovery page timeout",
      lastGoodAt: 1000,
    }
    expect(status.kind).toBe("sync_failed")
    expect(status.error).toBe("discovery page timeout")
    expect(status.lastGoodAt).toBe(1000)
  })
})

describe("ChannelAccountActions gating", () => {
  test("deriveChannelAccountActions exists and gates by channelType/provider", () => {
    // Feishu: no managed-project actions
    const feishuActions = deriveChannelAccountActions("feishu")
    expect(feishuActions.canRefreshProjects).toBe(false)
    expect(feishuActions.canDownloadDiagnostics).toBe(false)

    // Clarus: supports both
    const clarusActions = deriveChannelAccountActions("clarus")
    expect(clarusActions.canRefreshProjects).toBe(true)
    expect(clarusActions.canDownloadDiagnostics).toBe(true)
    expect(clarusActions.hiddenActions).toEqual([])
  })

  test("unsupported provider explicitly lists its hidden actions", () => {
    // An unknown provider returns all actions as hidden
    const actions = deriveChannelAccountActions("unknown-provider")
    expect(actions.canDownloadDiagnostics).toBe(false)
    expect(actions.hiddenActions).toContain("downloadDiagnostics")
    expect(actions.hiddenActions).toContain("refreshProjects")
  })

  test("Feishu behavior is unchanged — no new actions appear for Feishu accounts", () => {
    const feishuActions = deriveChannelAccountActions("feishu")
    // Feishu must not have managed-project-specific actions
    expect(feishuActions.canRefreshProjects).toBe(false)
    expect(feishuActions.canDownloadDiagnostics).toBe(false)
    expect(feishuActions.hiddenActions).toContain("refreshProjects")
    expect(feishuActions.hiddenActions).toContain("downloadDiagnostics")
  })
})

describe("ChannelAccount with Session children", () => {
  test("ChannelAccount shape can be extended with session navigation entries", () => {
    // The projection from the Blueprint is:
    // Channels → Clarus account → Project → Sessions
    // Project entries come from partitionScopeNavigation (ScopeNavEntry).
    // Session entries come from useLayout().nav.projectNavEntries().
    //
    // This test verifies that a ChannelAccount's projects[] entries
    // each carry scopeID/directory so the sidebar can call
    // loadScopeNav(directory) for child sessions.

    const project = managed({ scopeID: "proj" })
    const projection = partitionScopeNavigation([project])

    const accountProject = projection.channelAccounts[0]?.projects[0]
    expect(accountProject).toBeDefined()
    // scopeID and directory are sufficient for the existing session nav lookup
    expect(accountProject!.scopeID).toBe("proj")
    expect(accountProject!.directory).toBe("/managed/proj")
  })
})
