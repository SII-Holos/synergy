import { describe, expect, test } from "bun:test"
import type { NavEntry, NavListState, ScopeNavEntry } from "../../../src/context/layout/index"
import {
  applySessionToNavList,
  channelNavQuery,
  channelGithubNavQuery,
  mergeChannelNavPages,
  rootNavRequest,
  rootNavSectionsForSessionUpdate,
  loadNavListToDepth,
  managedProjectLocalScope,
  managedProjectScopesByWorktree,
  partitionScopeNavigation,
  mergeNavListByID,
  navUpdateFromSession,
  orderNavEntries,
  removeScopeFromIndex,
  removeScopeFromLoadedNavigation,
  sameScopeIndex,
} from "../../../src/context/layout/nav"

function entry(input: Partial<NavEntry> & Pick<NavEntry, "id">): NavEntry {
  return {
    id: input.id,
    scopeID: input.scopeID ?? "scope",
    scopeType: input.scopeType ?? "project",
    title: input.title ?? input.id,
    category: input.category ?? "project",
    lastActivityAt: input.lastActivityAt ?? 0,
    pinned: input.pinned ?? 0,
    archived: input.archived ?? false,
    completionNotice: input.completionNotice ?? { unread: false, unreadCount: 0 },
  }
}

function list(items: NavEntry[]): NavListState {
  return { items, nextCursor: null, total: items.length }
}

function scopeEntry(input: Partial<ScopeNavEntry> & Pick<ScopeNavEntry, "scopeID" | "directory">): ScopeNavEntry {
  return {
    scopeID: input.scopeID,
    scopeType: input.scopeType ?? "project",
    directory: input.directory,
    latestActivityAt: input.latestActivityAt ?? 0,
    sessionCount: input.sessionCount ?? 0,
    name: input.name,
    icon: input.icon,
  }
}

describe("managedProjectLocalScope", () => {
  test("projects a managed navigation entry into the standard Sidebar Project scope shape", () => {
    const managed = scopeEntry({
      scopeID: "managed-scope",
      directory: "/managed/project",
      name: "Managed Project",
      icon: { color: "purple" },
    })

    expect(managedProjectLocalScope(managed, { time: { created: 10, updated: 20 } }, true)).toEqual({
      id: "managed-scope",
      worktree: "/managed/project",
      name: "Managed Project",
      icon: { color: "purple" },
      time: { created: 10, updated: 20 },
      expanded: true,
    })
  })
})

describe("managed Project scope projection", () => {
  test("builds the standard Sidebar Project scope map from Channel navigation", () => {
    const managed: ScopeNavEntry = {
      ...scopeEntry({
        scopeID: "managed-scope",
        directory: "/managed/project",
        name: "Managed Project",
        icon: { color: "purple" },
      }),
      managedProject: {
        channelType: "clarus",
        accountId: "agent-1",
        externalProjectId: "project-1",
        remoteState: "active",
      },
    }
    const generic = scopeEntry({ scopeID: "generic-scope", directory: "/generic/project" })
    const projection = partitionScopeNavigation([managed, generic])

    const scopes = managedProjectScopesByWorktree(
      projection.channelAccounts,
      new Map([["managed-scope", { time: { created: 10, updated: 20 } }]]),
      new Set(["/managed/project"]),
    )

    expect(projection.genericProjects.map((entry) => entry.scopeID)).toEqual(["generic-scope"])
    expect([...scopes.keys()]).toEqual(["/managed/project"])
    expect(scopes.get("/managed/project")).toEqual({
      id: "managed-scope",
      worktree: "/managed/project",
      name: "Managed Project",
      icon: { color: "purple" },
      time: { created: 10, updated: 20 },
      expanded: true,
    })
  })
})

describe("channelNavQuery", () => {
  test("requests Channel sessions across Home and project scopes with cursor pagination", () => {
    expect(channelNavQuery(100, { lastActivityAt: 456, id: "ses_channel" })).toEqual({
      category: "channel",
      channelType: "feishu",
      parentOnly: true,
      includeArchived: true,
      limit: 100,
      cursorLastActivityAt: 456,
      cursorId: "ses_channel",
    })
  })
})

describe("rootNavRequest", () => {
  test("routes Channel through global navigation while Home stays scope-qualified", () => {
    expect(rootNavRequest("channel", 100)).toEqual({
      source: "global",
      query: {
        category: "channel",
        channelType: "feishu",
        parentOnly: true,
        includeArchived: true,
        limit: 100,
      },
    })
    expect(rootNavRequest("home", 100)).toEqual({
      source: "scope",
      query: {
        scopeID: "home",
        category: "home",
        parentOnly: "true",
        limit: 100,
      },
    })
  })
})

test("includes child entries for the Background section only when boss mode is enabled", () => {
  expect(rootNavRequest("background", 100, undefined, { includeBackgroundChildren: true })).toEqual({
    source: "scope",
    query: {
      scopeID: "home",
      category: "background",
      parentOnly: "false",
      limit: 100,
    },
  })
})

test("keeps background parent-only when boss mode is disabled (pre-boss behavior)", () => {
  expect(rootNavRequest("background", 100)).toEqual({
    source: "scope",
    query: {
      scopeID: "home",
      category: "background",
      parentOnly: "true",
      limit: 100,
    },
  })
  expect(rootNavRequest("background", 100, undefined, { includeBackgroundChildren: false })).toEqual({
    source: "scope",
    query: {
      scopeID: "home",
      category: "background",
      parentOnly: "true",
      limit: 100,
    },
  })
})

describe("loadNavListToDepth", () => {
  test("refreshes loaded depth through requests bounded by the API page limit", async () => {
    const source = Array.from({ length: 350 }, (_, index) =>
      entry({ id: `session-${String(index).padStart(3, "0")}`, lastActivityAt: 350 - index }),
    )
    const requests: Array<{ limit: number; cursor?: { lastActivityAt: number; id: string } }> = []

    const result = await loadNavListToDepth({
      depth: 300,
      pageLimit: 200,
      fetchPage: async (limit, cursor) => {
        requests.push({ limit, cursor })
        const start = cursor
          ? source.findIndex(
              (item) =>
                item.lastActivityAt < cursor.lastActivityAt ||
                (item.lastActivityAt === cursor.lastActivityAt && item.id < cursor.id),
            )
          : 0
        const items = source.slice(start, start + limit)
        const last = items.at(-1)
        const nextCursor =
          start + items.length < source.length && last ? { lastActivityAt: last.lastActivityAt, id: last.id } : null
        return { items, nextCursor, total: source.length }
      },
    })

    expect(requests.map((request) => request.limit)).toEqual([200, 100])
    expect(requests[1]?.cursor).toEqual({ lastActivityAt: 151, id: "session-199" })
    expect(result?.items).toHaveLength(300)
    expect(result?.nextCursor).toEqual({ lastActivityAt: 51, id: "session-299" })
    expect(result?.total).toBe(350)
  })
})

describe("rootNavSectionsForSessionUpdate", () => {
  test("refreshes Channel for project-scoped Channel updates", () => {
    expect(
      rootNavSectionsForSessionUpdate({
        scopeID: "project-scope",
        navCategory: "channel",
        channelType: "feishu",
        channelApplied: false,
      }),
    ).toEqual(["channel"])
  })

  test("keeps Home updates authoritative for every Home root section", () => {
    expect(
      rootNavSectionsForSessionUpdate({
        scopeID: "home",
        navCategory: "home",
        channelApplied: false,
      }),
    ).toEqual(["home", "channel", "background"])
  })

  test("ignores unrelated project-scoped updates", () => {
    expect(
      rootNavSectionsForSessionUpdate({
        scopeID: "project-scope",
        navCategory: "project",
        channelApplied: false,
      }),
    ).toEqual([])
  })

  test("ignores managed Task updates from other Channel providers", () => {
    expect(
      rootNavSectionsForSessionUpdate({
        scopeID: "project-scope",
        navCategory: "channel",
        channelType: "clarus",
        channelApplied: false,
      }),
    ).toEqual([])
  })
})

describe("channelGithubNavQuery", () => {
  test("requests GitHub Channel sessions with cursor pagination", () => {
    expect(channelGithubNavQuery(25, { lastActivityAt: 123, id: "ses_cursor" })).toEqual({
      category: "channel",
      channelType: "github",
      parentOnly: true,
      includeArchived: true,
      limit: 25,
      cursorLastActivityAt: 123,
      cursorId: "ses_cursor",
    })
  })
})

describe("mergeChannelNavPages", () => {
  test("merges feishu and github pages into one sorted list", () => {
    const merged = mergeChannelNavPages(undefined, [
      {
        channelType: "feishu",
        items: [entry({ id: "feishu-1", lastActivityAt: 100 })],
        nextCursor: null,
        total: 1,
      },
      {
        channelType: "github",
        items: [entry({ id: "github-1", lastActivityAt: 200 })],
        nextCursor: null,
        total: 1,
      },
    ])
    expect(merged.items.map((item) => item.id)).toEqual(["github-1", "feishu-1"])
    expect(merged.total).toBe(2)
    expect(merged.channelCursors).toEqual({ feishu: null, github: null })
  })

  test("tracks per-type cursors and reports hasMore when either type has a next page", () => {
    const merged = mergeChannelNavPages(undefined, [
      {
        channelType: "feishu",
        items: [entry({ id: "feishu-1", lastActivityAt: 100 })],
        nextCursor: { lastActivityAt: 100, id: "feishu-1" },
        total: 10,
      },
      {
        channelType: "github",
        items: [entry({ id: "github-1", lastActivityAt: 200 })],
        nextCursor: null,
        total: 1,
      },
    ])
    expect(merged.channelCursors?.feishu).toEqual({ lastActivityAt: 100, id: "feishu-1" })
    expect(merged.channelCursors?.github).toBeNull()
    expect(merged.nextCursor).not.toBeNull()
  })

  test("appends next pages without duplicating loaded entries", () => {
    const first = mergeChannelNavPages(undefined, [
      {
        channelType: "feishu",
        items: [entry({ id: "feishu-1", lastActivityAt: 200 })],
        nextCursor: { lastActivityAt: 200, id: "feishu-1" },
        total: 10,
      },
    ])
    const second = mergeChannelNavPages(
      first,
      [
        {
          channelType: "feishu",
          items: [entry({ id: "feishu-2", lastActivityAt: 100 })],
          nextCursor: null,
          total: 10,
        },
      ],
      "append",
    )
    expect(second.items.map((item) => item.id)).toEqual(["feishu-1", "feishu-2"])
    expect(second.total).toBe(2)
  })
})

describe("orderNavEntries", () => {
  test("orders pinned entries first, then by activity and id", () => {
    const pinnedEarly = entry({ id: "pinned-early", pinned: 10, lastActivityAt: 1 })
    const pinnedLate = entry({ id: "pinned-late", pinned: 20, lastActivityAt: 1 })
    const activeA = entry({ id: "a", lastActivityAt: 10 })
    const activeB = entry({ id: "b", lastActivityAt: 10 })
    const stale = entry({ id: "stale", lastActivityAt: 1 })

    expect(orderNavEntries([stale, activeA, pinnedEarly, activeB, pinnedLate]).map((item) => item.id)).toEqual([
      "pinned-late",
      "pinned-early",
      "b",
      "a",
      "stale",
    ])
  })
})

describe("mergeNavListByID", () => {
  test("updates existing nav rows by id while applying refreshed fields", () => {
    const previous = entry({
      id: "session",
      title: "Old title",
      completionNotice: { unread: true, unreadCount: 2 },
      lastActivityAt: 1,
    })
    const next = entry({ id: "session", title: "New title", lastActivityAt: 20 })

    const merged = mergeNavListByID(list([previous]), list([next]))

    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]).toEqual({ ...previous, ...next })
    expect(merged.items[0].title).toBe("New title")
    expect(merged.items[0].completionNotice.unread).toBe(false)
  })

  test("keeps the server-provided order and removes missing entries", () => {
    const previousA = entry({ id: "a" })
    const previousB = entry({ id: "b" })
    const nextB = entry({ id: "b", lastActivityAt: 5 })
    const nextC = entry({ id: "c", lastActivityAt: 4 })

    const merged = mergeNavListByID(list([previousA, previousB]), list([nextB, nextC]))

    expect(merged.items.map((item) => item.id)).toEqual(["b", "c"])
    expect(merged.total).toBe(2)
  })
})

describe("navUpdateFromSession", () => {
  test("projects nav-relevant fields from a session info", () => {
    const u = navUpdateFromSession({
      id: "s1",
      title: "Hello",
      pinned: 3,
      parentID: "p1",
      time: { updated: 1234, archived: 0 },
      completionNotice: { unread: true, unreadCount: 2 },
    })
    expect(u).toEqual({
      id: "s1",
      title: "Hello",
      pinned: 3,
      lastActivityAt: 1234,
      archived: false,
      parentID: "p1",
      completionNoticeUnread: true,
      completionNoticeUnreadCount: 2,
    })
  })

  test("uses the authoritative nav entry activity when provided", () => {
    const u = navUpdateFromSession(
      {
        id: "s1",
        title: "Running update",
        time: { updated: 9999 },
      },
      entry({ id: "s1", lastActivityAt: 1234 }),
    )

    expect(u.lastActivityAt).toBe(1234)
    expect(u.title).toBe("Running update")
  })

  test("falls back to time.updated for new session events without navEntry", () => {
    expect(navUpdateFromSession({ id: "new", time: { updated: 9999 } }).lastActivityAt).toBe(9999)
  })

  test("marks archived when time.archived is set", () => {
    expect(navUpdateFromSession({ id: "s1", time: { archived: 999 } }).archived).toBe(true)
  })
})

describe("applySessionToNavList", () => {
  test("returns applied=false when the session is not in the list", () => {
    const l = list([entry({ id: "a" })])
    const r = applySessionToNavList(l, navUpdateFromSession({ id: "missing", time: { updated: 5 } }))
    expect(r.applied).toBe(false)
    expect(r.list).toBe(l)
  })

  test("updates title/pin/activity in place for an existing entry", () => {
    const l = list([entry({ id: "a", title: "old", lastActivityAt: 1 }), entry({ id: "b" })])
    const r = applySessionToNavList(
      l,
      navUpdateFromSession({ id: "a", title: "new", pinned: 7, time: { updated: 99 } }),
    )
    expect(r.applied).toBe(true)
    const updated = r.list.items.find((e) => e.id === "a")!
    expect(updated.title).toBe("new")
    expect(updated.pinned).toBe(7)
    expect(updated.lastActivityAt).toBe(99)
    expect(orderNavEntries(r.list.items).map((e) => e.id)).toEqual(["a", "b"])
  })

  test("keeps running session order when authoritative nav activity is stable", () => {
    const l = list([
      entry({ id: "running", title: "old", lastActivityAt: 1 }),
      entry({ id: "other", lastActivityAt: 5 }),
    ])
    const r = applySessionToNavList(
      l,
      navUpdateFromSession(
        { id: "running", title: "still running", time: { updated: 99 } },
        entry({ id: "running", lastActivityAt: 1 }),
      ),
    )

    expect(r.applied).toBe(true)
    const updated = r.list.items.find((e) => e.id === "running")!
    expect(updated.title).toBe("still running")
    expect(updated.lastActivityAt).toBe(1)
    expect(orderNavEntries(r.list.items).map((e) => e.id)).toEqual(["other", "running"])
  })

  test("removes an archived entry and decrements total", () => {
    const l = list([entry({ id: "a" }), entry({ id: "b" })])
    const r = applySessionToNavList(l, navUpdateFromSession({ id: "a", time: { archived: 1 } }))
    expect(r.applied).toBe(true)
    expect(r.list.items.map((e) => e.id)).toEqual(["b"])
    expect(r.list.total).toBe(1)
  })

  test("preserves prior fields when the update omits them", () => {
    const l = list([entry({ id: "a", title: "keep", pinned: 2, completionNotice: { unread: true, unreadCount: 2 } })])
    const r = applySessionToNavList(l, { id: "a", archived: false, lastActivityAt: 50 })
    const updated = r.list.items[0]
    expect(updated.title).toBe("keep")
    expect(updated.pinned).toBe(2)
    expect(updated.completionNotice.unread).toBe(true)
    expect(updated.completionNotice.unreadCount).toBe(2)
    expect(updated.lastActivityAt).toBe(50)
  })
})

describe("removeScopeFromIndex", () => {
  test("removes the archived scope and returns its directory", () => {
    const result = removeScopeFromIndex(
      [
        scopeEntry({ scopeID: "home", scopeType: "home", directory: "home" }),
        scopeEntry({ scopeID: "scope-a", directory: "/repo/a" }),
        scopeEntry({ scopeID: "scope-b", directory: "/repo/b" }),
      ],
      "scope-a",
    )

    expect(result.removed).toBe(true)
    expect(result.directory).toBe("/repo/a")
    expect(result.entries.map((entry) => entry.scopeID)).toEqual(["home", "scope-b"])
  })

  test("reports missing scope without changing the index contents", () => {
    const entries = [scopeEntry({ scopeID: "scope-a", directory: "/repo/a" })]
    const result = removeScopeFromIndex(entries, "scope-missing")

    expect(result.removed).toBe(false)
    expect(result.directory).toBeUndefined()
    expect(result.entries).toEqual(entries)
  })

  test("returns the event directory when the scope is missing from the index", () => {
    const entries = [scopeEntry({ scopeID: "scope-a", directory: "/repo/a" })]
    const result = removeScopeFromIndex(entries, "scope-missing", "/repo/missing")

    expect(result.removed).toBe(false)
    expect(result.directory).toBe("/repo/missing")
    expect(result.entries).toEqual(entries)
  })
})

describe("removeScopeFromLoadedNavigation", () => {
  test("scope removal immediately evicts every loaded global navigation projection", () => {
    const archivedChannel = entry({ id: "archived-channel", scopeID: "archived", category: "channel" })
    const activeChannel = entry({ id: "active-channel", scopeID: "active", category: "channel" })
    const home = list([entry({ id: "home", scopeID: "home", scopeType: "home", category: "home" })])

    const result = removeScopeFromLoadedNavigation(
      {
        recent: list([archivedChannel, activeChannel]),
        root: {
          home,
          channel: list([archivedChannel, activeChannel]),
          background: list([entry({ id: "archived-background", scopeID: "archived", category: "background" })]),
        },
      },
      "archived",
    )

    expect(result.recent.items.map((item) => item.id)).toEqual(["active-channel"])
    expect(result.root.channel.items.map((item) => item.id)).toEqual(["active-channel"])
    expect(result.root.background.items).toEqual([])
    expect(result.root.home).toBe(home)
    expect(result.affected).toEqual({ recent: true, root: ["channel", "background"] })
  })
})
describe("sameScopeIndex", () => {
  test("treats equal entries as unchanged", () => {
    const a = [scopeEntry({ scopeID: "a", directory: "/repo/a" }), scopeEntry({ scopeID: "b", directory: "/repo/b" })]
    const b = [scopeEntry({ scopeID: "a", directory: "/repo/a" }), scopeEntry({ scopeID: "b", directory: "/repo/b" })]
    expect(sameScopeIndex(a, b)).toBe(true)
  })

  test("detects reordering, field changes, and managed project differences", () => {
    const a = [scopeEntry({ scopeID: "a", directory: "/repo/a" }), scopeEntry({ scopeID: "b", directory: "/repo/b" })]
    expect(sameScopeIndex(a, [a[1], a[0]])).toBe(false)
    expect(
      sameScopeIndex(a, [
        scopeEntry({ scopeID: "a", directory: "/repo/a" }),
        scopeEntry({ scopeID: "b", directory: "/repo/b", sessionCount: 1 }),
      ]),
    ).toBe(false)

    const managed = (remoteState: "active" | "paused"): ScopeNavEntry[] => [
      {
        ...scopeEntry({ scopeID: "m", directory: "/managed" }),
        managedProject: { channelType: "clarus", accountId: "agent-1", externalProjectId: "p1", remoteState },
      },
    ]
    expect(sameScopeIndex(managed("active"), managed("active"))).toBe(true)
    expect(sameScopeIndex(managed("active"), managed("paused"))).toBe(false)
  })

  test("distinguishes index length differences", () => {
    const a = [scopeEntry({ scopeID: "a", directory: "/repo/a" })]
    const b = [scopeEntry({ scopeID: "a", directory: "/repo/a" }), scopeEntry({ scopeID: "b", directory: "/repo/b" })]
    expect(sameScopeIndex(a, b)).toBe(false)
  })
})
