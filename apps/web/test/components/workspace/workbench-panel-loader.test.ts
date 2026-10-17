import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createWorkbenchPanelLoader } from "../../../src/components/workspace/workbench-panel-loader"

describe("Workbench panel loader", () => {
  test("a new registration cannot reuse a preceding plugin generation", async () => {
    let calls = 0
    const load = async () => ({ default: ++calls })
    const generation = {}
    const first = createWorkbenchPanelLoader(load, null, generation)
    await first.load()
    expect(createWorkbenchPanelLoader(load, null, generation).component()).toBe(1)
    const replacement = createWorkbenchPanelLoader(load, null, {})
    expect(replacement.loading()).toBe(true)
    await replacement.load()
    expect(replacement.component()).toBe(2)
  })
  test("shares an in-flight module and presents a warm module synchronously", async () => {
    let calls = 0
    let complete!: (value: { default: () => null }) => void
    const component = () => null
    const load = () => {
      calls++
      return new Promise<{ default: () => null }>((resolve) => {
        complete = resolve
      })
    }
    const first = createWorkbenchPanelLoader(load)
    const second = createWorkbenchPanelLoader(load)
    const pending = [first.load(), second.load()]
    expect(calls).toBe(1)
    complete({ default: component })
    await Promise.all(pending)
    expect(second.component()).toBe(component)
    const warm = createWorkbenchPanelLoader(load)
    expect(warm.loading()).toBe(false)
    expect(warm.component()).toBe(component)
    await warm.load()
    expect(calls).toBe(1)
  })

  test("retains a lazy-load failure and can retry the panel implementation", async () => {
    let attempts = 0
    const component = () => null

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const loader = createWorkbenchPanelLoader(async () => {
          attempts++
          if (attempts === 1) throw new Error("stale panel chunk")
          return { default: component }
        })

        void (async () => {
          try {
            await loader.load()
            expect(loader.loading()).toBe(false)
            expect(loader.component()).toBeNull()
            expect(loader.error()).toBeInstanceOf(Error)

            await loader.load()
            expect(loader.loading()).toBe(false)
            expect(loader.component()).toBe(component)
            expect(loader.error()).toBeNull()
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            dispose()
          }
        })()
      })
    })
  })
})
