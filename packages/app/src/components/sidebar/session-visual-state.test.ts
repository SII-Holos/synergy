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
      getSemanticIcon("channels.main"),
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

  test("shows blueprint state for idle sessions bound to BlueprintLoop", () => {
    const visual = resolveSessionVisualState(
      store({ session: [{ id: "ses_test", blueprint: { loopID: "bll_test" } }] }),
      entry(),
    )

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(visual.label).toBe("Blueprint session")
    expect(visual.tone).toBe("blueprint")
    expect(visual.pulse).toBeUndefined()
  })

  test("shows blueprint running state instead of generic running state", () => {
    const visual = resolveSessionVisualState(
      store({
        session_status: { ses_test: { type: "busy" } },
        session: [{ id: "ses_test", blueprint: { loopID: "bll_test", loopRole: "execution" } }],
      }),
      entry(),
    )

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(visual.label).toBe("Running Blueprint")
    expect(visual.tone).toBe("blueprint-running")
    expect(visual.pulse).toBe(true)
  })

  test("shows blueprint running state when a blueprint session has running child tasks", () => {
    const visual = resolveSessionVisualState(
      store({
        cortex: [{ parentSessionID: "ses_test", status: "running" }],
        session: [{ id: "ses_test", blueprint: { loopID: "bll_test", loopRole: "execution" } }],
      }),
      entry(),
    )

    expect(visual.icon).toBe("scan-eye")
    expect(visual.label).toBe("Auditing Blueprint")
    expect(visual.tone).toBe("blueprint-audit")
  })

  test("combines waiting state with blueprint identity", () => {
    const visual = resolveSessionVisualState(
      store({
        permission: { ses_test: [{}] },
        session: [{ id: "ses_test", blueprint: { loopID: "bll_test" } }],
      }),
      entry(),
    )

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(visual.label).toBe("Blueprint waiting for you")
    expect(visual.tone).toBe("blueprint-waiting")
    expect(visual.pulse).toBe(true)
  })

  test("distinguishes blueprint audit sessions", () => {
    const visual = resolveSessionVisualState(
      store({ session: [{ id: "ses_test", blueprint: { loopID: "bll_test", loopRole: "audit" } }] }),
      entry(),
    )

    expect(visual.icon).toBe("scan-eye")
    expect(visual.label).toBe("Auditing Blueprint")
    expect(visual.tone).toBe("blueprint-audit")
  })

  test("pulses blueprint audit sessions while their child tasks are running", () => {
    const visual = resolveSessionVisualState(
      store({
        cortex: [{ parentSessionID: "ses_test", status: "running" }],
        session: [{ id: "ses_test", blueprint: { loopID: "bll_test", loopRole: "audit" } }],
      }),
      entry(),
    )

    expect(visual.icon).toBe("scan-eye")
    expect(visual.label).toBe("Auditing Blueprint")
    expect(visual.tone).toBe("blueprint-audit")
    expect(visual.pulse).toBe(true)
  })

  test("keeps worktree state for non-blueprint worktree sessions", () => {
    const visual = resolveSessionVisualState(
      store({ session: [{ id: "ses_test", workspace: { type: "git_worktree" } }] }),
      entry(),
    )

    expect(visual.icon).toBe(getSemanticIcon("workspace.worktree"))
    expect(visual.tone).toBe("worktree")
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
