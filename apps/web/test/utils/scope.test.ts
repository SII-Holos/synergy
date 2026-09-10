import { describe, expect, test } from "bun:test"
import { getScopeLabel, resolveProjectScope } from "../../src/utils/scope"

describe("getScopeLabel", () => {
  test("prefers the custom project name over the directory basename", () => {
    expect(getScopeLabel({ worktree: "/repo/a", name: "Custom" })).toBe("Custom")
  })

  test("falls back to the directory basename without a custom name", () => {
    expect(getScopeLabel({ worktree: "/repo/cloud-auth" })).toBe("cloud-auth")
  })

  test("falls back to the scope key when no scope metadata is available", () => {
    expect(getScopeLabel(undefined, "/repo/synergy")).toBe("synergy")
  })

  test("labels the home scope as Home", () => {
    expect(getScopeLabel({ worktree: "home" })).toBe("Home")
  })
})

describe("resolveProjectScope", () => {
  test("returns undefined for the home scope", () => {
    expect(resolveProjectScope("home", undefined, [])).toBeUndefined()
  })

  test("returns undefined without a directory", () => {
    expect(resolveProjectScope(undefined, undefined, [])).toBeUndefined()
  })

  test("prefers the active scope when it carries a worktree", () => {
    const active = { worktree: "/repo/a", name: "Custom" }
    expect(resolveProjectScope("/repo/a", active, [])).toBe(active)
  })

  test("resolves the scope by worktree when the active scope is not ready", () => {
    const scopes = [{ worktree: "/repo/a" }]
    expect(resolveProjectScope("/repo/a", undefined, scopes)).toBe(scopes[0])
  })

  test("resolves a sandbox subdirectory to its parent project scope", () => {
    const scopes = [{ worktree: "/repo/a", sandboxes: ["/repo/a/apps/web"] }]
    expect(resolveProjectScope("/repo/a/apps/web", undefined, scopes)).toBe(scopes[0])
  })

  test("prefers a sandbox parent over a divergent active scope", () => {
    const active = { worktree: "/repo/a/apps/web", name: "app" }
    const scopes = [{ worktree: "/repo/a", name: "Parent", sandboxes: ["/repo/a/apps/web"] }]
    expect(resolveProjectScope("/repo/a/apps/web", active, scopes)).toBe(scopes[0])
  })

  test("does not trust an active scope that does not cover the route directory", () => {
    const active = { worktree: "/repo/other", name: "Other" }
    const scopes = [{ worktree: "/repo/a", name: "Parent", sandboxes: ["/repo/a/apps/web"] }]
    expect(resolveProjectScope("/repo/a/apps/web", active, scopes)).toBe(scopes[0])
  })

  test("returns undefined when nothing matches", () => {
    expect(resolveProjectScope("/repo/unknown", undefined, [{ worktree: "/repo/a" }])).toBeUndefined()
  })

  test("resolves exact worktree ownership over a sandbox claim from another scope", () => {
    const claimant = { worktree: "/repo/des", sandboxes: ["/repo/synergy"] }
    const owner = { worktree: "/repo/synergy", name: "synergy" }
    expect(resolveProjectScope("/repo/synergy", undefined, [claimant, owner])).toBe(owner)
  })

  test("trusts the active scope's sandbox mapping when the list has no match", () => {
    const active = { worktree: "/repo/other", sandboxes: ["/repo/other/apps/web"] }
    expect(resolveProjectScope("/repo/other/apps/web", active, [])).toBe(active)
  })

  test("normalizes separators, case, and trailing slashes when matching", () => {
    const owner = { worktree: "C:/repo/synergy" }
    expect(resolveProjectScope("C:\\repo\\synergy\\", undefined, [owner])).toBe(owner)
    const sub = { worktree: "/repo/a", sandboxes: ["/repo/a/apps/web"] }
    expect(resolveProjectScope("/Repo/A/Apps/Web/", undefined, [sub])).toBe(sub)
  })
})
