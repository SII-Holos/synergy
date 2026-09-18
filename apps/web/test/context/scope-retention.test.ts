import { describe, expect, test } from "bun:test"
import { createScopeRetention } from "../../src/context/scope-retention"

describe("Scope retention", () => {
  test("keeps shared Scope state when the last overlapping page leaves", () => {
    const released: string[] = []
    const scopes = createScopeRetention((key) => released.push(key), 2)
    const leaveOld = scopes.retain("shared")
    const leaveNew = scopes.retain("shared")
    leaveOld()
    expect(released).toEqual([])
    leaveOld()
    expect(released).toEqual([])
    leaveNew()
    expect(released).toEqual([])
    const leaveReopened = scopes.retain("shared")
    leaveNew()
    expect(released).toEqual([])
    leaveReopened()
    expect(released).toEqual([])
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
    expect(released).toEqual(["recent", "old"])
    scopes.touch("last")
    expect(released).toEqual(["recent", "old", "next"])
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
    expect(released).toEqual(["background", "another"])
  })
})

test("revisiting a released Scope preserves it and evicts the least recently used Scope", () => {
  const evicted: string[] = []
  const scopes = createScopeRetention((key) => evicted.push(key), 2)
  scopes.retain("first")()
  scopes.retain("second")()
  scopes.retain("first")()
  scopes.retain("third")()
  expect(evicted).toEqual(["second"])
})
