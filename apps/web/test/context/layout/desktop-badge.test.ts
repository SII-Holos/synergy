import { describe, expect, test } from "bun:test"
import { createDesktopBadgeSync } from "../../../src/context/layout/desktop-badge"

describe("desktop badge sync", () => {
  test("waits for an authoritative count and de-duplicates acknowledged values", async () => {
    const states: Array<{ count: number }> = []
    const sync = createDesktopBadgeSync(async (state) => {
      states.push(state)
    })

    await sync(undefined)
    await sync(3)
    await sync(3)
    await sync(0)

    expect(states).toEqual([{ count: 3 }, { count: 0 }])
  })

  test("de-duplicates an in-flight count", async () => {
    let resolve: (() => void) | undefined
    const states: Array<{ count: number }> = []
    const sync = createDesktopBadgeSync(
      (state) =>
        new Promise<void>((done) => {
          states.push(state)
          resolve = done
        }),
    )

    const first = sync(2)
    await sync(2)
    resolve?.()
    await first

    expect(states).toEqual([{ count: 2 }])
  })

  test("coalesces in-flight changes to the latest count", async () => {
    let releaseFirst: (() => void) | undefined
    let callCount = 0
    const states: Array<{ count: number }> = []
    const sync = createDesktopBadgeSync((state) => {
      states.push(state)
      callCount += 1
      if (callCount !== 1) return Promise.resolve()
      return new Promise<void>((done) => {
        releaseFirst = done
      })
    })

    const first = sync(1)
    void sync(2)
    void sync(5)
    releaseFirst?.()
    await first

    expect(states).toEqual([{ count: 1 }, { count: 5 }])
  })

  test("retries the same count after a failed bridge call", async () => {
    let attempts = 0
    const sync = createDesktopBadgeSync(async () => {
      attempts += 1
      if (attempts === 1) throw new Error("bridge unavailable")
    })

    await sync(4)
    await sync(4)

    expect(attempts).toBe(2)
  })
})
