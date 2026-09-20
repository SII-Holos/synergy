import { describe, expect, test } from "bun:test"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"
import {
  activeBlueprintLoop,
  blueprintExecutionAgentOptions,
  blueprintExecutionAgentPatch,
  blueprintExecutionControlProfile,
  blueprintSessionWorkspaceSelection,
  canCreateBlueprintWorktree,
  canRunBlueprintInCurrentSession,
} from "../../../src/components/note/blueprint-run-session"

const scopes = [
  { id: "scope-main", local: { directory: "/repo/main", worktree: "/repo/main", sandboxes: [], vcs: "git" as const } },
  { id: "scope-docs", local: null },
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
    expect(blueprintSessionWorkspaceSelection("current")).toBeUndefined()
    expect(blueprintSessionWorkspaceSelection("new")).toBeUndefined()
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

  test("runs in an existing session only when its Scope owns the Blueprint", () => {
    expect(
      canRunBlueprintInCurrentSession({ sessionID: "s", blueprintScopeID: "scope-main", sessionScopeID: "scope-main" }),
    ).toBe(true)
    expect(
      canRunBlueprintInCurrentSession({ sessionID: "s", blueprintScopeID: "scope-docs", sessionScopeID: "scope-main" }),
    ).toBe(false)
    expect(canRunBlueprintInCurrentSession({ blueprintScopeID: "home", sessionScopeID: "home" })).toBe(false)
  })

  test("only enables worktree runs when the Scope has a Git binding", () => {
    expect(canCreateBlueprintWorktree({ scopeID: "home", scopes })).toBe(false)
    expect(canCreateBlueprintWorktree({ scopeID: "scope-docs", scopes })).toBe(false)
    expect(canCreateBlueprintWorktree({ scopeID: "scope-main", scopes })).toBe(true)
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
