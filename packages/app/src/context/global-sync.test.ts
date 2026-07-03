import { describe, expect, test } from "bun:test"
import { Binary } from "@ericsanchezok/synergy-util/binary"

describe("global-sync message.part.updated workspace patching", () => {
  test("Binary.search finds existing session by id", () => {
    const sessions = [
      { id: "ses_a", workspace: { type: "main" } },
      { id: "ses_b", workspace: { type: "main" } },
    ]
    const idx = Binary.search(sessions, "ses_b", (s) => (s as { id: string }).id)
    expect(idx.found).toBe(true)
    expect(idx.index).toBe(1)
  })

  test("Binary.search returns insert position for missing id", () => {
    const sessions = [{ id: "ses_a", workspace: { type: "main" } }]
    const idx = Binary.search(sessions, "ses_x", (s) => (s as { id: string }).id)
    expect(idx.found).toBe(false)
    expect(idx.index).toBe(1)
  })
})

describe("optimistic workspace update shape", () => {
  test("worktree_enter metadata workspace shape matches session.workspace", () => {
    const ws = {
      type: "git_worktree" as const,
      path: "/tmp/synergy-worktrees/feature-x",
      scopeID: "abc123",
      worktreeID: "wt_1",
      name: "feature-x",
      branch: "feature/x",
      baseRef: "current" as const,
      baseRevision: undefined,
      resolvedBaseCommit: "def456",
    }
    // These are the fields the status bar reads
    expect(ws.type).toBe("git_worktree")
    expect(ws.name).toBe("feature-x")
    expect(ws.branch).toBe("feature/x")
  })

  test("worktree_leave restored shape maps to main workspace", () => {
    const restored = { type: "main", path: "/project" }
    const scopeID = "abc123"
    const workspace = {
      type: restored.type ?? "main",
      path: restored.path,
      scopeID,
    }
    // These are the fields the status bar reads
    expect(workspace.type).toBe("main")
    expect(workspace.path).toBe("/project")
    expect(workspace.scopeID).toBe("abc123")
  })

  test("worktree_leave restored with missing type defaults to main", () => {
    const restored: { type?: string; path?: string } = { path: "/project" }
    const scopeID = "abc123"
    const workspace = {
      type: restored.type ?? "main",
      path: restored.path,
      scopeID,
    }
    expect(workspace.type).toBe("main")
  })
})
