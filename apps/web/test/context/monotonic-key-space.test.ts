import { describe, expect, test } from "bun:test"
import { MonotonicKeySpace } from "../../src/context/monotonic-key-space"

describe("monotonic key space", () => {
  test("get returns the default of 0 for missing keys", () => {
    const space = new MonotonicKeySpace()

    expect(space.get("missing")).toBe(0)
  })

  test("ensure lazily creates a key once and reuses it afterwards", () => {
    const space = new MonotonicKeySpace()

    const first = space.ensure("scope")
    const second = space.ensure("scope")

    expect(first).toBe(1)
    expect(second).toBe(first)
  })

  test("allocate never reuses a number across keys", () => {
    const space = new MonotonicKeySpace()

    const a = space.allocate("a")
    const b = space.allocate("b")
    const c = space.allocate("c")

    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(c).toBe(3)
  })

  test("allocate bumps the counter even when a key is re-allocated", () => {
    const space = new MonotonicKeySpace()

    const first = space.allocate("key")
    const second = space.allocate("key")

    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(space.get("key")).toBe(2)
  })

  test("set stores the supplied value without bumping the counter", () => {
    const space = new MonotonicKeySpace()

    space.set("scope", 7)
    space.set("scope", 8)

    expect(space.get("scope")).toBe(8)
    expect(space.allocate("other")).toBe(1)
  })

  test("delete removes only the exact key", () => {
    const space = new MonotonicKeySpace()
    space.set("scope", 1)
    space.set("scope\nsession", 2)

    space.delete("scope")

    expect(space.get("scope")).toBe(0)
    expect(space.get("scope\nsession")).toBe(2)
  })

  test("deletePrefix removes keys under the raw prefix", () => {
    const space = new MonotonicKeySpace()
    space.set("scope", 1)
    space.set("scope\nsession", 2)
    space.set("scope\nsession\nmessage", 3)

    space.deletePrefix("scope\n")

    expect(space.get("scope")).toBe(1)
    expect(space.get("scope\nsession")).toBe(0)
    expect(space.get("scope\nsession\nmessage")).toBe(0)
  })

  test("deletePrefix does not remove keys that merely start with the same characters", () => {
    const space = new MonotonicKeySpace()
    space.set("scope", 1)
    space.set("scope-other", 2)

    space.deletePrefix("scope\n")

    expect(space.get("scope")).toBe(1)
    expect(space.get("scope-other")).toBe(2)
  })

  test("entries yields the stored key/value pairs", () => {
    const space = new MonotonicKeySpace()
    space.set("a", 1)
    space.set("b", 2)

    expect([...space.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ])
  })
})
