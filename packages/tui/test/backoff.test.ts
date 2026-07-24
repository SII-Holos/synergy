import { describe, expect, test } from "bun:test"
import { createReconnectBackoff } from "../src/backoff"

describe("reconnect backoff", () => {
  test("grows exponentially and caps", () => {
    const backoff = createReconnectBackoff({ initialMs: 1_000, maxMs: 8_000, jitter: 0 })
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ])
  })

  test("resets after a successful connection", () => {
    const backoff = createReconnectBackoff({ initialMs: 500, maxMs: 2_000, jitter: 0 })
    backoff.next()
    backoff.next()
    backoff.reset()
    expect(backoff.next()).toBe(500)
  })

  test("applies bounded jitter from an injected random source", () => {
    const low = createReconnectBackoff({ initialMs: 1_000, maxMs: 10_000, jitter: 0.25, random: () => 0 })
    const high = createReconnectBackoff({ initialMs: 1_000, maxMs: 10_000, jitter: 0.25, random: () => 1 })
    expect(low.next()).toBe(750)
    expect(high.next()).toBe(1_250)
  })
})
