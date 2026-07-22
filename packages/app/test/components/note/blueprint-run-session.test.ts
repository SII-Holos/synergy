import { describe, expect, test } from "bun:test"
import {
  activeBlueprintLoop,
  blueprintExecutionControlProfile,
  blueprintScopeIDForDirectory,
  blueprintSessionWorkspaceSelection,
  canCreateBlueprintWorktree,
  canRunBlueprintInCurrentSession,
} from "../../../src/components/note/blueprint-run-session"

const scopes = [
  {
    id: "scope-main",
    worktree: "C:/repo/main",
    sandboxes: ["C:/repo/main/.synergy/worktrees/feature-a"],
    vcs: "git",
  },
  {
    id: "scope-docs",
    worktree: "C:/repo/docs",
    sandboxes: [],
  },
]

describe("Blueprint run session helpers", () => {
  test("maps run modes to explicit session workspace selections", () => {
    expect(blueprintSessionWorkspaceSelection("current")).toEqual({ mode: "current" })
    expect(blueprintSessionWorkspaceSelection("new")).toEqual({ mode: "current" })
    expect(blueprintSessionWorkspaceSelection("worktree")).toEqual({ mode: "create" })
  })

  test("floors new Blueprint execution sessions at Autonomous", () => {
    expect(blueprintExecutionControlProfile(undefined)).toBe("autonomous")
    expect(blueprintExecutionControlProfile("guarded")).toBe("autonomous")
    expect(blueprintExecutionControlProfile("autonomous")).toBe("autonomous")
    expect(blueprintExecutionControlProfile("full_access")).toBe("full_access")
  })

  test("matches current sessions by scope instead of raw route directory", () => {
    expect(blueprintScopeIDForDirectory("C:/repo/main/.synergy/worktrees/feature-a", scopes)).toBe("scope-main")
    expect(
      canRunBlueprintInCurrentSession({
        sessionID: "session_123",
        blueprintDirectory: "C:/repo/main",
        routeDirectory: "C:/repo/main/.synergy/worktrees/feature-a",
        scopes,
      }),
    ).toBe(true)
    expect(
      canRunBlueprintInCurrentSession({
        sessionID: "session_123",
        blueprintDirectory: "C:/repo/docs",
        routeDirectory: "C:/repo/main",
        scopes,
      }),
    ).toBe(false)
  })

  test("only enables worktree runs for git project scopes", () => {
    expect(canCreateBlueprintWorktree({ blueprintDirectory: "home", scopes })).toBe(false)
    expect(canCreateBlueprintWorktree({ blueprintDirectory: "C:/repo/docs", scopes })).toBe(false)
    expect(canCreateBlueprintWorktree({ blueprintDirectory: "C:/repo/main", scopes })).toBe(true)
  })

  test("detects active BlueprintLoop state", () => {
    expect(activeBlueprintLoop({ blueprint: { activeLoopID: "loop-armed" } }, [])).toBeUndefined()
    expect(activeBlueprintLoop({}, [{ id: "loop-complete", status: "completed" }])).toBeUndefined()
    expect(activeBlueprintLoop({}, [{ id: "loop-running", status: "running" }])?.id).toBe("loop-running")
    expect(
      activeBlueprintLoop({ blueprint: { activeLoopID: "loop-waiting" } }, [
        { id: "loop-running", status: "running" },
        { id: "loop-waiting", status: "waiting" },
      ])?.id,
    ).toBe("loop-waiting")
  })
})
