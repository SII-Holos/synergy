import { describe, expect, test } from "bun:test"
import type { NavEntry, NavListState, ScopeNavEntry } from "../../../src/context/layout/index"
import {
  applySessionToNavList,
  githubNavQuery,
  managedProjectLocalScope,
  managedProjectScopesByWorktree,
  partitionScopeNavigation,
  mergeNavListByID,
  navUpdateFromSession,
  orderNavEntries,
  removeScopeFromIndex,
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

describe("githubNavQuery", () => {
  test("requests GitHub sessions across parent and child scopes with cursor pagination", () => {
    expect(githubNavQuery(25, { lastActivityAt: 123, id: "ses_cursor" })).toEqual({
      category: "github",
      parentOnly: false,
      limit: 25,
      cursorLastActivityAt: 123,
      cursorId: "ses_cursor",
    })
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
