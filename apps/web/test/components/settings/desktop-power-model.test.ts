import { describe, expect, test } from "bun:test"
import { createDesktopPowerController } from "../../../src/components/settings/desktop-power-model"
import type { DesktopPowerBridge, DesktopPowerSnapshot } from "../../../src/context/platform"

function bridge(overrides: Partial<DesktopPowerBridge> = {}) {
  const calls = { set: [] as boolean[], get: 0 }
  let live: DesktopPowerSnapshot = { keepAwakeWhileRunning: false, active: false }
  return {
    set: async (update: { keepAwakeWhileRunning: boolean }) => {
      calls.set.push(update.keepAwakeWhileRunning)
      live = { keepAwakeWhileRunning: update.keepAwakeWhileRunning, active: update.keepAwakeWhileRunning }
      return live
    },
    get: async () => {
      calls.get += 1
      return live
    },
    activityChanged: async () => {},
    calls,
    ...overrides,
  }
}

type Bridge = ReturnType<typeof bridge> & DesktopPowerBridge

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("desktop power controller", () => {
  test("applies the requested state and reports the applied snapshot", async () => {
    const b = bridge() as Bridge
    const applied: DesktopPowerSnapshot[] = []
    const controller = createDesktopPowerController({
      bridge: b,
      onApplied: (snapshot) => applied.push(snapshot),
      onFailure: () => {},
    })

    controller.apply(true)
    await flush()

    expect(b.calls.set).toEqual([true])
    expect(applied).toEqual([{ keepAwakeWhileRunning: true, active: true }])
  })

  test("re-syncs to the live state and notifies once when set fails", async () => {
    const failures: unknown[] = []
    const applied: DesktopPowerSnapshot[] = []
    const b = bridge({
      set: async () => {
        throw new Error("bridge down")
      },
    }) as Bridge
    const controller = createDesktopPowerController({
      bridge: b,
      onApplied: (snapshot) => applied.push(snapshot),
      onFailure: (error) => failures.push(error),
    })

    controller.apply(true)
    controller.apply(true)
    controller.apply(false)
    await flush()

    // The toggle must reflect what the shell is actually enforcing, and the
    // user sees exactly one failure toast for the whole episode.
    expect(applied).toEqual([
      { keepAwakeWhileRunning: false, active: false },
      { keepAwakeWhileRunning: false, active: false },
      { keepAwakeWhileRunning: false, active: false },
    ])
    expect(failures).toHaveLength(1)
  })

  test("notifies again after a successful apply", async () => {
    const failures: unknown[] = []
    const b = bridge() as Bridge
    let fail = true
    b.set = async (update) => {
      if (fail) throw new Error("bridge down")
      return { keepAwakeWhileRunning: update.keepAwakeWhileRunning, active: update.keepAwakeWhileRunning }
    }
    const controller = createDesktopPowerController({
      bridge: b,
      onApplied: () => {},
      onFailure: (error) => failures.push(error),
    })

    controller.apply(true)
    await flush()
    fail = false
    controller.apply(true)
    await flush()
    fail = true
    controller.apply(false)
    await flush()

    expect(failures).toHaveLength(2)
  })

  test("restore reads the live snapshot from the bridge", async () => {
    const applied: DesktopPowerSnapshot[] = []
    const b = bridge({ get: async () => ({ keepAwakeWhileRunning: true, active: false }) }) as Bridge
    const controller = createDesktopPowerController({
      bridge: b,
      onApplied: (snapshot) => applied.push(snapshot),
      onFailure: () => {},
    })

    await controller.restore()

    expect(applied).toEqual([{ keepAwakeWhileRunning: true, active: false }])
  })

  test("is a no-op without a bridge", async () => {
    const applied: DesktopPowerSnapshot[] = []
    const controller = createDesktopPowerController({
      bridge: undefined,
      onApplied: (snapshot) => applied.push(snapshot),
      onFailure: () => {},
    })

    controller.apply(true)
    await controller.restore()

    expect(applied).toEqual([])
  })

  test("restore swallows a failing read", async () => {
    const applied: DesktopPowerSnapshot[] = []
    const b = bridge({
      get: async () => {
        throw new Error("bridge down")
      },
    }) as Bridge
    const controller = createDesktopPowerController({
      bridge: b,
      onApplied: (snapshot) => applied.push(snapshot),
      onFailure: () => {},
    })

    await controller.restore()

    expect(applied).toEqual([])
  })
})
