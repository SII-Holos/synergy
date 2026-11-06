import { describe, expect, test } from "bun:test"
import type { ScopeNavEntry } from "@/context/layout"
import { partitionScopeNavigation } from "@/context/layout/nav"

type ManagedProject = NonNullable<ScopeNavEntry["managedProject"]>

function scopeEntry(
  input: Partial<ScopeNavEntry> & Pick<ScopeNavEntry, "scopeID" | "directory"> & { managedProject?: ManagedProject },
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
  channelType: string
  accountId: string
  externalProjectId: string
  remoteState?: ManagedProject["remoteState"]
  latestActivityAt?: number
}) {
  return scopeEntry({
    scopeID: input.scopeID,
    directory: `/managed/${input.scopeID}`,
    latestActivityAt: input.latestActivityAt,
    managedProject: {
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
      remoteState: input.remoteState ?? "active",
    },
  })
}

describe("partitionScopeNavigation", () => {
  test("excludes managed Projects from generic Projects and groups them by exact Channel account identity", () => {
    const ordinary = scopeEntry({ scopeID: "ordinary", directory: "/ordinary", latestActivityAt: 5 })
    const first = managed({
      scopeID: "first",
      channelType: "clarus",
      accountId: "agent-a",
      externalProjectId: "project-shared",
      latestActivityAt: 20,
    })
    const second = managed({
      scopeID: "second",
      channelType: "clarus",
      accountId: "agent-b",
      externalProjectId: "project-shared",
      latestActivityAt: 10,
    })

    const projection = partitionScopeNavigation([ordinary, first, second])

    expect(projection.genericProjects.map((entry) => entry.scopeID)).toEqual(["ordinary"])
    expect(projection.channelAccounts).toEqual([
      { channelType: "clarus", accountId: "agent-a", projects: [first], status: { kind: "connected" } },
      { channelType: "clarus", accountId: "agent-b", projects: [second], status: { kind: "connected" } },
    ])
  })

  test("keeps paused, stale, and remote-archived Projects under their owning account", () => {
    const paused = managed({
      scopeID: "paused",
      channelType: "clarus",
      accountId: "agent",
      externalProjectId: "project-paused",
      remoteState: "paused",
      latestActivityAt: 30,
    })
    const stale = managed({
      scopeID: "stale",
      channelType: "clarus",
      accountId: "agent",
      externalProjectId: "project-stale",
      remoteState: "stale",
      latestActivityAt: 20,
    })
    const archived = managed({
      scopeID: "archived",
      channelType: "clarus",
      accountId: "agent",
      externalProjectId: "project-archived",
      remoteState: "archived",
      latestActivityAt: 10,
    })

    const projection = partitionScopeNavigation([archived, stale, paused])

    expect(projection.genericProjects).toEqual([])
    expect(projection.channelAccounts).toEqual([
      {
        channelType: "clarus",
        accountId: "agent",
        projects: [paused, stale, archived],
        status: { kind: "connected" },
      },
    ])
  })

  test("does not collide account identities containing delimiters", () => {
    const first = managed({
      scopeID: "first",
      channelType: "a:b",
      accountId: "c",
      externalProjectId: "project-first",
    })
    const second = managed({
      scopeID: "second",
      channelType: "a",
      accountId: "b:c",
      externalProjectId: "project-second",
    })

    const projection = partitionScopeNavigation([first, second])

    expect(projection.channelAccounts).toHaveLength(2)
    expect(projection.channelAccounts.map(({ channelType, accountId }) => [channelType, accountId])).toEqual([
      ["a", "b:c"],
      ["a:b", "c"],
    ])
  })
})
