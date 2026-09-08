import { describe, expect, test } from "bun:test"
import type { Worktree } from "@ericsanchezok/synergy-sdk/client"
import {
  canDeleteWorktree,
  gitProjectScopes,
  groupWorktreesByDirectory,
  loadWorktreesByDirectory,
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

  test("groups worktrees by scope directory", () => {
    const items: Worktree[] = [
      {
        id: "wt_1",
        name: "feature",
        path: "/repo/.synergy/worktrees/feature",
        scopeID: "scope_1",
      },
    ]
    const grouped = groupWorktreesByDirectory(
      [
        { worktree: "/repo", name: "Synergy" },
        { worktree: "/other", name: "Other" },
      ],
      new Map([["/repo", items]]),
      (directory, name) => name ?? directory,
    )
    expect(grouped).toEqual([
      { scopeLabel: "Synergy", directory: "/repo", worktrees: items },
      { scopeLabel: "Other", directory: "/other", worktrees: [] },
    ])
  })

  test("selects only git project scopes", () => {
    expect(
      gitProjectScopes(
        [
          { type: "home", vcs: "git", worktree: "/home" },
          { type: "project", vcs: "git", worktree: "/git" },
          { type: "project", worktree: "/plain" },
        ],
        "/home",
      ),
    ).toEqual([{ type: "project", vcs: "git", worktree: "/git" }])
  })

  test("keeps successful scope results when another scope fails", async () => {
    const item: Worktree = {
      id: "wt_1",
      name: "feature",
      path: "/repo/.synergy/worktrees/feature",
      scopeID: "scope_1",
    }
    const result = await loadWorktreesByDirectory(
      [{ worktree: "/repo" }, { worktree: "/missing" }],
      async (directory) => {
        if (directory === "/missing") throw { data: { message: "Repository moved" } }
        return [item]
      },
      1,
    )

    expect(result.worktrees.get("/repo")).toEqual([item])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.directory).toBe("/missing")
  })
})
