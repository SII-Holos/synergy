import { describe, expect, test } from "bun:test"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { resolveSessionVisualState, scopeKeyForNavEntry, type SessionVisualStore } from "./session-visual-state"

function entry(input: Partial<NavEntry> = {}): NavEntry {
  return {
    id: "ses_test",
    scopeID: "home",
    scopeType: "home",
    title: "Test",
    category: "home",
    lastActivityAt: 1,
    pinned: 0,
    archived: false,
    completionNotice: { unread: false },
    ...input,
  }
}

function store(input: Partial<SessionVisualStore> = {}): SessionVisualStore {
  return {
    session_status: {},
    permission: {},
    question: {},
    cortex: [],
    session: [{ id: "ses_test" }],
    ...input,
  }
}

describe("resolveSessionVisualState", () => {
  test("shows running state for busy Home sessions", () => {
    const visual = resolveSessionVisualState(store({ session_status: { ses_test: { type: "busy" } } }), entry())

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
    expect(visual.pulse).toBe(true)
  })

  test("shows running state for retrying Home sessions", () => {
    const visual = resolveSessionVisualState(store({ session_status: { ses_test: { type: "retry" } } }), entry())

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
    expect(visual.pulse).toBe(true)
  })

  test("prioritizes waiting over running for Home sessions", () => {
    const visual = resolveSessionVisualState(
      store({
        session_status: { ses_test: { type: "busy" } },
        permission: { ses_test: [{}] },
      }),
      entry(),
    )

    expect(visual.icon).toBe(getSemanticIcon("session.waiting"))
    expect(visual.tone).toBe("waiting")
    expect(visual.pulse).toBe(true)
  })

  test("uses Home icon only for idle Home sessions", () => {
    const visual = resolveSessionVisualState(store(), entry())

    expect(visual.icon).toBe("home")
    expect(visual.tone).toBe("default")
    expect(visual.pulse).toBeUndefined()
  })

  test("marks idle unread sessions as response ready", () => {
    const visual = resolveSessionVisualState(store(), entry({ completionNotice: { unread: true } }))

    expect(visual.icon).toBe("home")
    expect(visual.completionUnread).toBe(true)
    expect(visual.label).toBe("Home session; response ready")
  })

  test("suppresses completion unread while running", () => {
    const visual = resolveSessionVisualState(
      store({ session_status: { ses_test: { type: "busy" } } }),
      entry({ completionNotice: { unread: true } }),
    )

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.completionUnread).toBeUndefined()
  })

  test("suppresses completion unread while waiting", () => {
    const visual = resolveSessionVisualState(
      store({ permission: { ses_test: [{}] } }),
      entry({ completionNotice: { unread: true } }),
    )

    expect(visual.icon).toBe(getSemanticIcon("session.waiting"))
    expect(visual.completionUnread).toBeUndefined()
  })

  test("preserves worktree and child icons for unread sessions", () => {
    const worktree = resolveSessionVisualState(
      store({ session: [{ id: "ses_test", workspace: { type: "git_worktree" } }] }),
      entry({ completionNotice: { unread: true } }),
    )
    const child = resolveSessionVisualState(
      store(),
      entry({ parentID: "ses_parent", completionNotice: { unread: true } }),
    )

    expect(worktree.icon).toBe(getSemanticIcon("workspace.worktree"))
    expect(worktree.completionUnread).toBe(true)
    expect(child.icon).toBe(getSemanticIcon("session.child"))
    expect(child.completionUnread).toBe(true)
  })

  test("keeps project running behavior", () => {
    const visual = resolveSessionVisualState(
      store({ session_status: { ses_test: { type: "busy" } } }),
      entry({ scopeID: "scp_project", scopeType: "project", category: "project" }),
    )

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
  })

  test("keeps category icons as the idle fallback", () => {
    expect(resolveSessionVisualState(store(), entry({ category: "channel" })).icon).toBe(
      getSemanticIcon("session.channel"),
    )
    expect(resolveSessionVisualState(store(), entry({ category: "background" })).icon).toBe(
      getSemanticIcon("session.background"),
    )
    expect(resolveSessionVisualState(store(), entry({ category: "project" })).icon).toBe(
      getSemanticIcon("session.default"),
    )
  })

  test("uses child task activity as running state", () => {
    const visual = resolveSessionVisualState(
      store({ cortex: [{ parentSessionID: "ses_test", status: "running" }] }),
      entry(),
    )

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
  })
})

describe("scopeKeyForNavEntry", () => {
  test("maps Home entries to the canonical Home scope key", () => {
    expect(scopeKeyForNavEntry(entry(), [])).toBe("home")
  })

  test("maps project entries through scope metadata", () => {
    expect(
      scopeKeyForNavEntry(entry({ scopeID: "scp_project", scopeType: "project" }), [
        { id: "scp_project", worktree: "/repo" },
      ]),
    ).toBe("/repo")
  })
})
