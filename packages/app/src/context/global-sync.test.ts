import { describe, expect, test } from "bun:test"
import { resolveWorkspaceTransition } from "./workspace-transition"
import type { Part } from "@ericsanchezok/synergy-sdk/client"

function toolPart(overrides: Record<string, unknown> = {}): Part {
  return {
    id: "part_1",
    sessionID: "ses_a",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "worktree_enter",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "Entered worktree",
      metadata: {
        action: "entered",
        workspace: {
          type: "git_worktree",
          path: "/tmp/worktrees/feature-x",
          scopeID: "abc123",
          worktreeID: "wt_1",
          name: "feature-x",
          branch: "feature/x",
        },
      },
      time: { start: 1, end: 2 },
    },
    ...overrides,
  } as Part
}

describe("resolveWorkspaceTransition", () => {
  test("returns none for non-tool parts", () => {
    const part: Part = {
      id: "part_1",
      sessionID: "ses_a",
      messageID: "msg_1",
      type: "text",
      text: "hello",
    } as Part
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns none for non-completed tool parts", () => {
    const part: Part = {
      id: "part_1",
      sessionID: "ses_a",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "worktree_enter",
      state: {
        status: "running",
        input: {},
        title: "Entering worktree",
        time: { start: 1 },
      },
    } as Part
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns none for unknown tools", () => {
    const part = toolPart({ tool: "bash" })
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns enter with workspace for completed worktree_enter", () => {
    const result = resolveWorkspaceTransition(toolPart())
    expect(result.kind).toBe("enter")
    if (result.kind === "enter") {
      expect(result.workspace.type).toBe("git_worktree")
      expect(result.workspace.name).toBe("feature-x")
    }
  })

  test("returns none for worktree_enter with denied action", () => {
    const part = toolPart({
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Denied",
        metadata: { action: "denied", message: "dirty worktree" },
        time: { start: 1, end: 2 },
      },
    })
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns none for worktree_enter without workspace", () => {
    const part = toolPart({
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Denied",
        metadata: { action: "entered", message: "already there" },
        time: { start: 1, end: 2 },
      },
    })
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns leave with workspace for completed worktree_leave", () => {
    const part = toolPart({
      tool: "worktree_leave",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Left worktree",
        metadata: {
          action: "left",
          previous: { type: "git_worktree", path: "/tmp/worktrees/x", name: "x" },
          restored: { type: "main", path: "/project" },
          cleanup: { performed: true },
        },
        time: { start: 1, end: 2 },
      },
    })
    const result = resolveWorkspaceTransition(part)
    expect(result.kind).toBe("leave")
    if (result.kind === "leave") {
      expect(result.workspace.type).toBe("main")
      expect(result.workspace.path).toBe("/project")
      expect(result.workspace.scopeID).toBe("")
    }
  })

  test("returns leave defaulting to main type when restored has no type", () => {
    const part = toolPart({
      tool: "worktree_leave",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Left worktree",
        metadata: {
          action: "left",
          restored: { path: "/project" },
        },
        time: { start: 1, end: 2 },
      },
    })
    const result = resolveWorkspaceTransition(part)
    expect(result.kind).toBe("leave")
    if (result.kind === "leave") {
      expect(result.workspace.type).toBe("main")
    }
  })

  test("returns none for worktree_leave with missing restored.path", () => {
    const part = toolPart({
      tool: "worktree_leave",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Left worktree",
        metadata: {
          action: "left",
          restored: { type: "main" },
        },
        time: { start: 1, end: 2 },
      },
    })
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns none for worktree_leave with denied action", () => {
    const part = toolPart({
      tool: "worktree_leave",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Denied",
        metadata: { action: "denied", reason: "permission" },
        time: { start: 1, end: 2 },
      },
    })
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })

  test("returns none for worktree_leave with noop action", () => {
    const part = toolPart({
      tool: "worktree_leave",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Already on main",
        metadata: { action: "noop", message: "already on main" },
        time: { start: 1, end: 2 },
      },
    })
    expect(resolveWorkspaceTransition(part).kind).toBe("none")
  })
})
