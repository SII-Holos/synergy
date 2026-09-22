import { describe, expect, test } from "bun:test"
import type { Worktree } from "@ericsanchezok/synergy-sdk/client"
import {
  canDeleteWorktree,
  gitProjectScopes,
  groupWorktreesByScope,
  loadWorktreesByScope,
  worktreeLifecycleLabel,
} from "../../../../src/components/settings/panels/worktrees-panel-model"

describe("worktrees panel model", () => {
  test("only managed non-main worktrees are deleteable", () => {
    expect(canDeleteWorktree({ managed: true, isMain: false })).toBe(true)
    expect(canDeleteWorktree({ managed: true, isMain: true })).toBe(false)
    expect(canDeleteWorktree({ managed: false, isMain: false })).toBe(false)
  })

  test("labels known lifecycle values", () => {
    expect(worktreeLifecycleLabel("active")).toBe("Active")
    expect(worktreeLifecycleLabel("gc_candidate")).toBe("GC candidate")
    expect(worktreeLifecycleLabel("detached")).toBe("detached")
    expect(worktreeLifecycleLabel(undefined)).toBeNull()
  })

  test("groups worktrees by Scope ID", () => {
    const items: Worktree[] = [
      {
        id: "wt_1",
        name: "feature",
        path: "/repo/.synergy/worktrees/feature",
        scopeID: "scope_1",
      },
    ]
    const grouped = groupWorktreesByScope(
      [
        { id: "scope_1", name: "Synergy", local: { worktree: "/repo" } },
        { id: "scope_2", name: "Other", local: { worktree: "/other" } },
      ],
      new Map([["scope_1", items]]),
      (directory, name) => name ?? directory,
    )
    expect(grouped).toEqual([
      { scopeLabel: "Synergy", scopeID: "scope_1", worktrees: items },
      { scopeLabel: "Other", scopeID: "scope_2", worktrees: [] },
    ])
  })

  test("selects only project Scopes with a local Git binding", () => {
    const git = { id: "git", type: "project", local: { directory: "/git", worktree: "/git", vcs: "git" as const } }
    expect(
      gitProjectScopes([
        { id: "home", type: "home", local: null },
        git,
        { id: "archived", type: "project", local: null },
        { id: "plain", type: "project", local: { worktree: "/plain" } },
      ]),
    ).toEqual([git])
  })

  test("keeps successful scope results when another scope fails", async () => {
    const item: Worktree = {
      id: "wt_1",
      name: "feature",
      path: "/repo/.synergy/worktrees/feature",
      scopeID: "scope_1",
    }
    const result = await loadWorktreesByScope(
      [{ id: "scope_1" }, { id: "scope_2" }],
      async (directory) => {
        if (directory === "scope_2") throw { data: { message: "Repository moved" } }
        return [item]
      },
      1,
    )

    expect(result.worktrees.get("scope_1")).toEqual([item])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.scopeID).toBe("scope_2")
  })
})
