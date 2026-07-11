import { describe, expect, test } from "bun:test"
import { resolveTerminalCwd } from "./cwd"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

function sessionWithWorkspace(type: string, path: string, overrides?: Partial<Session>): Session {
  return {
    id: "ses_test",
    scope: { id: "scope_1", directory: "/project", worktree: "/project/.git" },
    title: "Test Session",
    version: "1",
    time: { created: 1, updated: 1 },
    workspace: { type, path, scopeID: "scope_1" },
    ...overrides,
  }
}

function sessionWithoutWorkspace(overrides?: Partial<Session>): Session {
  return {
    id: "ses_test",
    scope: { id: "scope_1", directory: "/project", worktree: "/project/.git" },
    title: "Test Session",
    version: "1",
    time: { created: 1, updated: 1 },
    ...overrides,
  }
}

describe("resolveTerminalCwd", () => {
  test("returns undefined when session is undefined", () => {
    expect(resolveTerminalCwd(undefined)).toBeUndefined()
  })

  test("returns undefined when session has no workspace", () => {
    const session = sessionWithoutWorkspace()
    expect(resolveTerminalCwd(session)).toBeUndefined()
  })

  test("returns undefined for main workspace type", () => {
    const session = sessionWithWorkspace("main", "/project")
    expect(resolveTerminalCwd(session)).toBeUndefined()
  })

  test("returns worktree path for git_worktree type", () => {
    const session = sessionWithWorkspace("git_worktree", "/project/.synergy/worktrees/my-fix")
    expect(resolveTerminalCwd(session)).toBe("/project/.synergy/worktrees/my-fix")
  })

  test("returns path for any non-main workspace type", () => {
    const session = sessionWithWorkspace("feature_branch", "/project/branches/feature-x")
    expect(resolveTerminalCwd(session)).toBe("/project/branches/feature-x")
  })

  test("returns undefined when workspace has empty path", () => {
    const session = sessionWithWorkspace("git_worktree", "")
    expect(resolveTerminalCwd(session)).toBeUndefined()
  })

  test("returns undefined when workspace has undefined path", () => {
    const session = sessionWithWorkspace("git_worktree", undefined as unknown as string)
    expect(resolveTerminalCwd(session)).toBeUndefined()
  })

  test("returns undefined when workspace type is main with empty path", () => {
    const session = sessionWithWorkspace("main", "")
    expect(resolveTerminalCwd(session)).toBeUndefined()
  })

  test("works with a fully populated Session object", () => {
    const session = sessionWithWorkspace("git_worktree", "/tmp/worktree-abc", {
      id: "ses_123",
      title: "My Worktree Session",
    })
    expect(resolveTerminalCwd(session)).toBe("/tmp/worktree-abc")
  })

  test("returns undefined when workspace only has type but no path key", () => {
    const session: Session = {
      id: "ses_test",
      scope: { id: "scope_1", directory: "/project", worktree: "/project/.git" },
      title: "Test",
      version: "1",
      time: { created: 1, updated: 1 },
      workspace: { type: "git_worktree", path: "", scopeID: "" },
    }
    expect(resolveTerminalCwd(session)).toBeUndefined()
  })
})
