import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createWorkbenchPanelLoader } from "../../../src/components/workspace/workbench-panel-loader"

describe("Workbench panel loader", () => {
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
