import { afterEach, describe, expect, test } from "bun:test"
import { Presence } from "../../src/holos/presence"

afterEach(() => {
  Presence.clear()
  Presence.setClock(() => Date.now())
})

describe("Holos presence cache", () => {
  test("expires cached entries within five minutes", () => {
    let now = 1_000_000
    Presence.setClock(() => now)
    Presence.markOnline("agent_a")

    now += 4 * 60 * 1000
    expect(Presence.get("agent_a")).toBe("online")

    now += 2 * 60 * 1000
    expect(Presence.get("agent_a")).toBe("unknown")
  })

  test("tracks offline and unknown state through the clock seam", () => {
    let now = 1_000_000
    Presence.setClock(() => now)
    Presence.markOffline("agent_b")

    expect(Presence.get("agent_b")).toBe("offline")
    expect(Presence.get("agent_c")).toBe("unknown")

    now += 6 * 60 * 1000
    expect(Presence.get("agent_b")).toBe("unknown")
  })

  test("clear and prune remove entries", () => {
    let now = 1_000_000
    Presence.setClock(() => now)
    Presence.markOnline("agent_d")
    Presence.markOffline("agent_e")

    expect(Presence.all().size).toBe(2)
    Presence.prune()
    expect(Presence.all().size).toBe(2)

    now += 6 * 60 * 1000
    Presence.prune()
    expect(Presence.all().size).toBe(0)
    expect(Presence.get("agent_d")).toBe("unknown")

    Presence.markOnline("agent_f")
    Presence.clear()
    expect(Presence.all().size).toBe(0)
  })
})
