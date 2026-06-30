import { describe, expect, test } from "bun:test"

const sidebar = await Bun.file(new URL("./sidebar.tsx", import.meta.url)).text()

describe("Sidebar project deletion", () => {
  test("button label says Archive not Delete", () => {
    // The action is actually an archive — match label to reality.
    expect(sidebar).toContain('title="Archive project"')
    expect(sidebar).toContain('confirmLabel="Archive"')
    expect(sidebar).toContain(">Archive</span>")
    expect(sidebar).not.toContain('title="Delete project"')
    expect(sidebar).not.toContain('confirmLabel="Delete"')
    expect(sidebar).not.toContain(">Delete</span>")
  })

  test("guards scope.id before showing delete dialog", () => {
    // handleProjectDelete must return early when scope.id is undefined,
    // preventing the old fallback that sent a directory path as scopeID.
    expect(sidebar).toContain("if (!scopeID) return")
  })

  test("calls scopes.close after server delete", () => {
    // After the server API call succeeds, the local scope store must be
    // updated so the deleted project disappears immediately (not on refresh).
    expect(sidebar).toContain("layout.scopes.close(worktree)")
  })

  test("no longer falls back to worktree path as scopeID", () => {
    // The old fallback sent scope.worktree as path_scopeID — a directory path
    // that never matches a stored scope ID, causing a 404.
    expect(sidebar).not.toContain("scope.id) await globalSDK.client.scope.remove")
    expect(sidebar).not.toContain("await globalSDK.client.scope.remove({ path_scopeID: scope.worktree })")
  })
})
