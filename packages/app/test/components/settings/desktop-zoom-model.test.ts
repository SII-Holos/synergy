import { describe, expect, test } from "bun:test"
import { createDesktopZoomController } from "../../../src/components/settings/desktop-zoom-model"
import type { DesktopZoomBridge } from "../../../src/context/platform"

function bridge(overrides: Partial<DesktopZoomBridge> = {}) {
  const calls = { set: [] as number[], get: 0 }
  let live = 1
  return {
    set: async (factor: number) => {
      calls.set.push(factor)
      live = factor
      return factor
    },
    get: async () => {
      calls.get += 1
      return live
    },
    calls,
    ...overrides,
  }
}

type Bridge = ReturnType<typeof bridge> & DesktopZoomBridge

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("desktop zoom controller", () => {
  test("applies the requested factor and reports the applied value", async () => {
    const b = bridge() as Bridge
    const applied: number[] = []
    const controller = createDesktopZoomController({
      bridge: b,
      onApplied: (f) => applied.push(f),
      onFailure: () => {},
    })

    controller.apply(1.25)
    await flush()

    expect(b.calls.set).toEqual([1.25])
    expect(applied).toEqual([1.25])
  })

  test("re-syncs to the live factor and notifies once when set fails", async () => {
    const failures: unknown[] = []
    const applied: number[] = []
    const b = bridge({
      set: async () => {
        throw new Error("bridge down")
      },
    }) as Bridge
    const controller = createDesktopZoomController({
      bridge: b,
      onApplied: (f) => applied.push(f),
      onFailure: (e) => failures.push(e),
    })

    controller.apply(1.5)
    controller.apply(1.75)
    controller.apply(2)
    await flush()

    // The slider must reflect the actually applied (unchanged) live factor,
    // and the user sees exactly one failure toast for the whole episode.
    expect(applied).toEqual([1, 1, 1])
    expect(failures).toHaveLength(1)
  })

  test("notifies again after a successful apply", async () => {
    const failures: unknown[] = []
    const b = bridge() as Bridge
    let fail = true
    b.set = async (factor) => {
      if (fail) throw new Error("bridge down")
      return factor
    }
    const controller = createDesktopZoomController({
      bridge: b,
      onApplied: () => {},
      onFailure: (e) => failures.push(e),
    })

    controller.apply(1.5)
    await flush()
    fail = false
    controller.apply(1.5)
    await flush()
    fail = true
    controller.apply(2)
    await flush()

    expect(failures).toHaveLength(2)
  })

  test("restore reads the live factor from the bridge", async () => {
    const applied: number[] = []
    const b = bridge({ get: async () => 1.25 }) as Bridge
    const controller = createDesktopZoomController({
      bridge: b,
      onApplied: (f) => applied.push(f),
      onFailure: () => {},
    })

    await controller.restore()

    expect(applied).toEqual([1.25])
  })

  test("is a no-op without a bridge", async () => {
    const applied: number[] = []
    const controller = createDesktopZoomController({
      bridge: undefined,
      onApplied: (f) => applied.push(f),
      onFailure: () => {},
    })

    controller.apply(1.5)
    await controller.restore()

    expect(applied).toEqual([])
  })
})
