import { describe, expect, test } from "bun:test"
import { createScopeRetention } from "../../src/context/scope-retention"

describe("Scope retention", () => {
  test("keeps shared Scope state until the last overlapping page leaves", () => {
    const released: string[] = []
    const scopes = createScopeRetention((key) => released.push(key), 2)
    const leaveOld = scopes.retain("shared")
    const leaveNew = scopes.retain("shared")
    leaveOld()
    expect(released).toEqual([])
    leaveOld()
    expect(released).toEqual([])
    leaveNew()
    expect(released).toEqual(["shared"])
    const leaveReopened = scopes.retain("shared")
    leaveNew()
    expect(released).toEqual(["shared"])
    leaveReopened()
    expect(released).toEqual(["shared", "shared"])
  })

  test("bounds never-mounted background Scopes in least-recently-used order", () => {
    const released: string[] = []
    const scopes = createScopeRetention((key) => released.push(key), 2)
    const leave = scopes.retain("viewed")
    scopes.touch("viewed")
    scopes.touch("old")
    scopes.touch("recent")
    scopes.touch("old")
    scopes.touch("next")
    expect(released).toEqual(["recent"])
    leave()
    expect(released).toEqual(["recent", "viewed"])
    scopes.touch("last")
    expect(released).toEqual(["recent", "viewed", "old"])
  })

  test("promotes a background Scope to a protected page lease", () => {
    const released: string[] = []
    const scopes = createScopeRetention((key) => released.push(key), 1)
    scopes.touch("selected")
    const leave = scopes.retain("selected")
    scopes.touch("background")
    scopes.touch("another")
    expect(released).toEqual(["background"])
    leave()
    expect(released).toEqual(["background", "selected"])
  })
})
