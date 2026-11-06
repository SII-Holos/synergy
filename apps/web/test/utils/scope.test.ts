import { describe, expect, test } from "bun:test"
import { getScopeLabel, resolveProjectScope } from "../../src/utils/scope"

const project = (id: string, directory: string) => ({ id, local: { directory, worktree: directory, sandboxes: [] } })

describe("Scope identity and presentation", () => {
  test("labels metadata without making its filesystem binding an identity", () => {
    expect(getScopeLabel({ ...project("a", "/repo/a"), name: "Custom" })).toBe("Custom")
    expect(getScopeLabel(project("a", "/repo/cloud-auth"))).toBe("cloud-auth")
    expect(getScopeLabel({ id: "a", local: null, name: "Archived project" })).toBe("Archived project")
    expect(getScopeLabel({ id: "home", local: null })).toBe("Home")
  })

  test("resolves the requested ID even when paths coincide, change, or are unavailable", () => {
    const first = project("a", "/repo/shared")
    const second = project("b", "/repo/shared")
    expect(resolveProjectScope("a", second, [first, second])).toBe(first)
    expect(resolveProjectScope("b", first, [first, second])).toBe(second)
    const moved = project("a", "/repo/moved")
    expect(resolveProjectScope("a", first, [moved])).toBe(moved)
    const archived = { id: "a", local: null }
    expect(resolveProjectScope("a", undefined, [archived])).toBe(archived)
    expect(resolveProjectScope("missing", second, [first])).toBeUndefined()
    expect(resolveProjectScope("/repo/shared", second, [first])).toBeUndefined()
    expect(resolveProjectScope("home", second, [first])).toBeUndefined()
  })
})
