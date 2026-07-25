import { describe, expect, test } from "bun:test"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"
import {
  activeBlueprintLoop,
  blueprintExecutionAgentOptions,
  blueprintExecutionAgentPatch,
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

const agents: Agent[] = [
  {
    name: "synergy-max",
    mode: "primary",
    permission: [],
    options: {},
  },
  {
    name: "implementation-engineer",
    mode: "subagent",
    permission: [],
    options: {},
  },
  {
    name: "internal-reviewer",
    mode: "subagent",
    hidden: true,
    permission: [],
    options: {},
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

  test("offers user-visible execution agents and preserves an unavailable stored selection", () => {
    expect(blueprintExecutionAgentOptions(agents)).toEqual([
      { name: "synergy-max", description: undefined, available: true },
      { name: "implementation-engineer", description: undefined, available: true },
    ])
    expect(blueprintExecutionAgentOptions(agents, "legacy-agent")).toEqual([
      { name: "legacy-agent", description: undefined, available: false },
      { name: "synergy-max", description: undefined, available: true },
      { name: "implementation-engineer", description: undefined, available: true },
    ])
    expect(blueprintExecutionAgentOptions(agents, "internal-reviewer")[0]).toEqual({
      name: "internal-reviewer",
      description: undefined,
      available: false,
    })
  })

  test("builds a version-locked patch for a user-selected Blueprint execution agent", () => {
    expect(blueprintExecutionAgentPatch({ version: 7 }, "implementation-engineer")).toEqual({
      expectedVersion: 7,
      blueprint: { defaultAgent: "implementation-engineer" },
    })
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
