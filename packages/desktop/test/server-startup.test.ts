import { describe, expect, test } from "bun:test"
import { DesktopServerStartup } from "../src/server-startup.js"

const line = (value: unknown) => `SYNERGY_STARTUP_V1 ${JSON.stringify(value)}\n`

describe("managed startup progress", () => {
  test("keeps progressing upgrades alive beyond the ordinary startup deadline", () => {
    let now = 0
    const startup = new DesktopServerStartup({ now: () => now })
    expect(startup.remainingMs()).toBe(30_000)
    startup.receive(line({ phase: "migration", step: 1, current: 0, total: 0 }))
    now = 29_000
    startup.receive(line({ phase: "migration", step: 1, current: 358, total: 8494 }))
    now = 60_000
    expect(startup.remainingMs()).toBe(269_000)
    expect(startup.status()).toMatchObject({ progress: { current: 358, total: 8494 } })
    now = 328_000
    startup.receive(line({ phase: "migration", step: 1, current: 400, total: 8494 }))
    expect(startup.remainingMs()).toBe(300_000)
  })

  test("does not let repeated counts, stale steps or ordinary logs hide a stalled migration", () => {
    let now = 0
    const startup = new DesktopServerStartup({ now: () => now })
    const progress = line({ phase: "migration", step: 2, current: 3, total: 10 })
    startup.receive(progress)
    now = 300_000
    startup.receive(progress)
    startup.receive(line({ phase: "migration", step: 1, current: 10, total: 10 }))
    startup.receive("connected\n".repeat(100))
    expect(startup.remainingMs()).toBe(0)
    expect(startup.timeoutError().message).toContain("no progress for 300000ms")
    expect(startup.timeoutError().message).toContain("3/10")
  })

  test("restores a bounded health wait after migrations, without reopening completed migration work", () => {
    let now = 0
    const startup = new DesktopServerStartup({ now: () => now })
    startup.receive(line({ phase: "migration", step: 1, current: 0, total: 0 }))
    now = 100_000
    startup.receive(line({ phase: "starting" }))
    expect(startup.remainingMs()).toBe(30_000)
    expect(startup.status().progress).toBeUndefined()
    now = 130_000
    startup.receive(line({ phase: "starting" }))
    startup.receive(line({ phase: "migration", step: 2, current: 0, total: 0 }))
    expect(startup.remainingMs()).toBe(0)
  })

  test("decodes split records and ignores invalid or oversized output", () => {
    const statuses: unknown[] = []
    const startup = new DesktopServerStartup({ onStatus: (status) => statuses.push(status) })
    const progress = line({ phase: "migration", step: 1, current: 1, total: 10 })
    startup.receive(progress.slice(0, 15))
    expect(statuses).toHaveLength(0)
    startup.receive(progress.slice(15))
    expect(statuses).toHaveLength(1)
    startup.receive(line({ phase: "migration", step: 1, current: 11, total: 10 }))
    startup.receive("SYNERGY_STARTUP_V1 {broken}\n")
    startup.receive("x".repeat(100_000))
    startup.receive(progress)
    expect(statuses).toHaveLength(1)
    startup.receive(line({ phase: "migration", step: 2, current: 0, total: 0 }))
    expect(statuses).toHaveLength(2)
  })
})
