import { describe, expect, test } from "bun:test"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { resolveSessionVisualState, scopeKeyForNavEntry } from "../../../src/components/sidebar/session-visual-state"

const UNREAD: NavEntry["completionNotice"] = { unread: true, unreadCount: 1 }

function msg(d: { message?: string }): string {
  return d.message ?? ""
}

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
    completionNotice: { unread: false, unreadCount: 0 },
    ...input,
  }
}

function projectEntry(input: Partial<NavEntry> = {}): NavEntry {
  return entry({ scopeID: "scp_project", scopeType: "project", category: "project", ...input })
}

function blueprintEntry(input: Partial<NonNullable<NavEntry["blueprint"]>> = {}): NavEntry {
  return entry({ blueprint: { loopID: "bll_test", ...input } })
}

function loopEntry(active: boolean = true): NavEntry {
  return entry({ workflow: { kind: "lightloop", active } })
}

describe("resolveSessionVisualState", () => {
  test("shows running state for busy sessions", () => {
    const visual = resolveSessionVisualState({ entry: entry(), status: { type: "busy" } })

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
    expect(visual.pulse).toBe(true)
  })

  test("shows running state for busy project sessions", () => {
    const visual = resolveSessionVisualState({ entry: projectEntry(), status: { type: "busy" } })

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
  })

  test("shows the retry glyph for retrying sessions", () => {
    const visual = resolveSessionVisualState({
      entry: entry(),
      status: { type: "retry", attempt: 2, message: "upstream unavailable", next: 1_000 },
    })

    expect(visual.icon).toBe(getSemanticIcon("session.retry"))
    expect(visual.tone).toBe("retry")
    expect(visual.pulse).toBe(true)
  })

  test("renders a paused session as paused rather than working", () => {
    const visual = resolveSessionVisualState({
      entry: entry(),
      status: { type: "paused", reason: "interrupted", since: 1 },
    })

    expect(visual.tone).toBe("paused")
    // A stopped session carries no pulse: nothing is making progress.
    expect(visual.pulse).toBeUndefined()
    expect(msg(visual.label)).toBe("Session paused")
  })

  test("leaves sessions with no status at the category fallback", () => {
    const visual = resolveSessionVisualState({ entry: projectEntry() })

    expect(visual.icon).toBe(getSemanticIcon("session.default"))
    expect(visual.tone).toBe("default")
    expect(visual.pulse).toBeUndefined()
  })

  test("leaves idle sessions at the category fallback", () => {
    const visual = resolveSessionVisualState({ entry: entry(), status: { type: "idle" } })

    expect(visual.icon).toBe(getSemanticIcon("navigation.home"))
    expect(visual.tone).toBe("default")
    expect(visual.pulse).toBeUndefined()
  })

  test("prioritizes waiting over busy sessions", () => {
    const visual = resolveSessionVisualState({ entry: entry(), status: { type: "busy" }, waiting: true })

    expect(visual.icon).toBe(getSemanticIcon("session.waiting"))
    expect(visual.tone).toBe("waiting")
    expect(visual.pulse).toBe(true)
  })

  test("prioritizes waiting over a paused session", () => {
    const visual = resolveSessionVisualState({
      entry: entry(),
      status: { type: "paused", reason: "interrupted", since: 1 },
      waiting: true,
    })

    expect(visual.icon).toBe(getSemanticIcon("session.waiting"))
    expect(visual.tone).toBe("waiting")
    expect(visual.pulse).toBe(true)
  })

  test("keeps Blueprint identity when no runtime context is available", () => {
    const visual = resolveSessionVisualState({ entry: blueprintEntry({ loopRole: "execution", phase: "running" }) })

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(visual.tone).toBe("blueprint")
    expect(msg(visual.label)).toBe("Blueprint session")
  })

  test("keeps worktree identity when no runtime context is available", () => {
    const visual = resolveSessionVisualState({ entry: entry({ workspaceType: "git_worktree" }) })

    expect(visual.icon).toBe(getSemanticIcon("workspace.worktree"))
    expect(visual.tone).toBe("worktree")
    expect(msg(visual.label)).toBe("Worktree session")
  })

  test("keeps child identity when no runtime context is available", () => {
    const visual = resolveSessionVisualState({ entry: entry({ parentID: "ses_parent" }) })

    expect(visual.icon).toBe(getSemanticIcon("session.child"))
    expect(visual.tone).toBe("muted")
    expect(msg(visual.label)).toBe("Child session")
  })

  test("combines waiting state with blueprint identity", () => {
    const visual = resolveSessionVisualState({ entry: blueprintEntry(), waiting: true })

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(msg(visual.label)).toBe("Blueprint waiting for you")
    expect(visual.tone).toBe("blueprint-waiting")
    expect(visual.pulse).toBe(true)
  })

  test("distinguishes blueprint audit sessions by role", () => {
    const visual = resolveSessionVisualState({ entry: blueprintEntry({ loopRole: "audit" }) })

    expect(visual.icon).toBe(getSemanticIcon("command.review"))
    expect(msg(visual.label)).toBe("Auditing Blueprint")
    expect(visual.tone).toBe("blueprint-audit")
  })

  test("treats an auditing blueprint phase as the audit state", () => {
    const visual = resolveSessionVisualState({
      entry: blueprintEntry({ loopRole: "execution", phase: "auditing" }),
    })

    expect(visual.icon).toBe(getSemanticIcon("command.review"))
    expect(msg(visual.label)).toBe("Auditing Blueprint")
    expect(visual.tone).toBe("blueprint-audit")
    expect(visual.pulse).toBeUndefined()
  })

  test("shows blueprint running state instead of generic running state", () => {
    const visual = resolveSessionVisualState({
      entry: blueprintEntry({ loopRole: "execution" }),
      status: { type: "busy" },
    })

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(msg(visual.label)).toBe("Running Blueprint")
    expect(visual.tone).toBe("blueprint-running")
    expect(visual.pulse).toBe(true)
  })

  test("shows Running Blueprint when a blueprint session delegates to ordinary subagents", () => {
    const visual = resolveSessionVisualState({
      entry: blueprintEntry({ loopRole: "execution" }),
      runningChildTasks: true,
    })

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(msg(visual.label)).toBe("Running Blueprint")
    expect(visual.tone).toBe("blueprint-running")
    expect(visual.pulse).toBe(true)
  })

  test("pulses blueprint audit sessions while their child tasks are running", () => {
    const visual = resolveSessionVisualState({
      entry: blueprintEntry({ loopRole: "audit" }),
      runningChildTasks: true,
    })

    expect(visual.icon).toBe(getSemanticIcon("command.review"))
    expect(msg(visual.label)).toBe("Auditing Blueprint")
    expect(visual.tone).toBe("blueprint-audit")
    expect(visual.pulse).toBe(true)
  })

  test("shows resting blueprint state for idle blueprint sessions", () => {
    const visual = resolveSessionVisualState({ entry: blueprintEntry() })

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(msg(visual.label)).toBe("Blueprint session")
    expect(visual.tone).toBe("blueprint")
    expect(visual.pulse).toBeUndefined()
  })

  test("shows the Light Loop glyph for a running active loop", () => {
    const visual = resolveSessionVisualState({ entry: loopEntry(), status: { type: "busy" } })

    expect(visual.icon).toBe(getSemanticIcon("prompt.lightLoop"))
    expect(msg(visual.label)).toBe("Running Light Loop")
    expect(visual.tone).toBe("loop")
    expect(visual.pulse).toBe(true)
  })

  test("shows the Light Loop glyph while the loop waits for the user", () => {
    const visual = resolveSessionVisualState({ entry: loopEntry(), waiting: true })

    expect(visual.icon).toBe(getSemanticIcon("prompt.lightLoop"))
    expect(msg(visual.label)).toBe("Light Loop waiting for you")
    expect(visual.tone).toBe("waiting")
    expect(visual.pulse).toBe(true)
  })

  test("shows the rested Light Loop glyph without runtime context", () => {
    const visual = resolveSessionVisualState({ entry: loopEntry() })

    expect(visual.icon).toBe(getSemanticIcon("prompt.lightLoop"))
    expect(msg(visual.label)).toBe("Light Loop session")
    expect(visual.tone).toBe("loop")
    expect(visual.pulse).toBeUndefined()
  })

  test("treats a terminated Light Loop as an ordinary session", () => {
    const visual = resolveSessionVisualState({ entry: loopEntry(false) })

    expect(visual.icon).toBe(getSemanticIcon("navigation.home"))
    expect(msg(visual.label)).toBe("Home session")
    expect(visual.tone).toBe("default")
    expect(visual.pulse).toBeUndefined()
  })

  test("treats a terminated Light Loop with running status as an ordinary running session", () => {
    const visual = resolveSessionVisualState({ entry: loopEntry(false), status: { type: "busy" } })

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
  })

  test("keeps Light Loop unread completion on the loop branch", () => {
    const visual = resolveSessionVisualState({
      entry: entry({ workflow: { kind: "lightloop", active: true }, completionNotice: UNREAD }),
    })

    expect(visual.icon).toBe(getSemanticIcon("prompt.lightLoop"))
    expect(visual.tone).toBe("loop")
    expect(visual.completionUnread).toBe(true)
    expect(msg(visual.label)).toBe("Light Loop session; response ready")
  })

  test("uses child task activity as running state", () => {
    const visual = resolveSessionVisualState({ entry: entry(), runningChildTasks: true })

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.tone).toBe("active")
  })

  test("preserves worktree and child icons for unread sessions", () => {
    const worktree = resolveSessionVisualState({
      entry: entry({ workspaceType: "git_worktree", completionNotice: UNREAD }),
    })
    const child = resolveSessionVisualState({ entry: entry({ parentID: "ses_parent", completionNotice: UNREAD }) })

    expect(worktree.icon).toBe(getSemanticIcon("workspace.worktree"))
    expect(worktree.tone).toBe("worktree")
    expect(worktree.completionUnread).toBe(true)
    expect(msg(worktree.label)).toBe("Worktree session; response ready")
    expect(child.icon).toBe(getSemanticIcon("session.child"))
    expect(child.tone).toBe("muted")
    expect(child.completionUnread).toBe(true)
    expect(msg(child.label)).toBe("Child session; response ready")
  })

  test("keeps blueprint unread completion on the resting blueprint branch", () => {
    const visual = resolveSessionVisualState({
      entry: entry({ blueprint: { loopID: "bll_test" }, completionNotice: UNREAD }),
    })

    expect(visual.icon).toBe(getSemanticIcon("blueprint.main"))
    expect(visual.tone).toBe("blueprint")
    expect(visual.completionUnread).toBe(true)
    expect(msg(visual.label)).toBe("Blueprint session")
  })

  test("suppresses completion unread while running", () => {
    const visual = resolveSessionVisualState({
      entry: entry({ completionNotice: UNREAD }),
      status: { type: "busy" },
    })

    expect(visual.icon).toBe(getSemanticIcon("session.running"))
    expect(visual.completionUnread).toBeUndefined()
  })

  test("suppresses completion unread while waiting", () => {
    const visual = resolveSessionVisualState({
      entry: entry({ completionNotice: UNREAD }),
      waiting: true,
    })

    expect(visual.icon).toBe(getSemanticIcon("session.waiting"))
    expect(visual.completionUnread).toBeUndefined()
  })

  test("keeps category icons as the idle fallback", () => {
    expect(resolveSessionVisualState({ entry: entry({ category: "channel" }) }).icon).toBe(
      getSemanticIcon("channels.main"),
    )
    expect(resolveSessionVisualState({ entry: entry({ category: "channel", channelType: "github" }) }).icon).toBe(
      getSemanticIcon("github.main"),
    )
    expect(resolveSessionVisualState({ entry: entry({ category: "background" }) }).icon).toBe(
      getSemanticIcon("session.background"),
    )
    expect(resolveSessionVisualState({ entry: projectEntry() }).icon).toBe(getSemanticIcon("session.default"))
  })

  test("uses the GitHub icon for idle GitHub sessions", () => {
    const visual = resolveSessionVisualState({ entry: entry({ category: "github" }) })

    expect(visual.icon).toBe(getSemanticIcon("github.main"))
    expect(visual.tone).toBe("muted")
    expect(msg(visual.label)).toBe("GitHub session")
  })

  test("marks unread category sessions as response ready", () => {
    const home = resolveSessionVisualState({ entry: entry({ completionNotice: UNREAD }) })
    const background = resolveSessionVisualState({
      entry: entry({ category: "background", completionNotice: UNREAD }),
    })
    const channel = resolveSessionVisualState({ entry: entry({ category: "channel", completionNotice: UNREAD }) })

    expect(home.icon).toBe(getSemanticIcon("navigation.home"))
    expect(home.completionUnread).toBe(true)
    expect(msg(home.label)).toBe("Home session; response ready")
    expect(background.icon).toBe(getSemanticIcon("session.background"))
    expect(background.completionUnread).toBe(true)
    expect(msg(background.label)).toBe("Background session; response ready")
    expect(channel.icon).toBe(getSemanticIcon("channels.main"))
    expect(channel.completionUnread).toBe(true)
    expect(msg(channel.label)).toBe("Channel session; response ready")
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
