import { describe, expect, test } from "bun:test"
import { createSettingsComponentLoader } from "../../../src/components/settings/settings-component-loader"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("settings component loader", () => {
  test("keeps the current generation after a stale loader fails", async () => {
    const stale = deferred<{ default: () => null }>()
    const currentComponent = () => null
    const state = createSettingsComponentLoader<() => null>()

    const staleLoad = state.load({ loader: () => stale.promise })
    await state.load({ loader: async () => ({ default: currentComponent }) })
    stale.reject(new Error("stale plugin generation"))
    await staleLoad

    expect(state.loading()).toBe(false)
    expect(state.component()).toBe(currentComponent)
  })

  test("does not let a stale success replace the current generation", async () => {
    const stale = deferred<{ default: () => null }>()
    const staleComponent = () => null
    const currentComponent = () => null
    const state = createSettingsComponentLoader<() => null>()

    const staleLoad = state.load({ loader: () => stale.promise })
    await state.load({ loader: async () => ({ default: currentComponent }) })
    stale.resolve({ default: staleComponent })
    await staleLoad

    expect(state.loading()).toBe(false)
    expect(state.component()).toBe(currentComponent)
  })
})
