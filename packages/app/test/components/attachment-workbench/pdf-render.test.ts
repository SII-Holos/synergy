import { describe, expect, test } from "bun:test"
import { createPdfRenderCoordinator, type PdfRenderTask } from "../../../src/components/attachment-workbench/pdf-render"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function completedTask(): PdfRenderTask {
  return {
    promise: Promise.resolve(),
    cancel() {},
  }
}

describe("PDF render coordination", () => {
  test("allows only the latest page request to draw", async () => {
    const firstPage = deferred<string>()
    const secondPage = deferred<string>()
    const drawn: string[] = []
    const errors: unknown[] = []
    const coordinator = createPdfRenderCoordinator<string>()

    const first = coordinator.render({
      loadPage: () => firstPage.promise,
      drawPage: (page) => {
        drawn.push(page)
        return completedTask()
      },
      onError: (cause) => errors.push(cause),
    })
    const second = coordinator.render({
      loadPage: () => secondPage.promise,
      drawPage: (page) => {
        drawn.push(page)
        return completedTask()
      },
      onError: (cause) => errors.push(cause),
    })

    secondPage.resolve("second")
    await second
    firstPage.resolve("first")
    await first

    expect(drawn).toEqual(["second"])
    expect(errors).toEqual([])
  })

  test("cancels an active render when a newer request starts", async () => {
    const active = deferred<void>()
    const started = deferred<void>()
    let cancelled = 0
    const coordinator = createPdfRenderCoordinator<string>()
    const first = coordinator.render({
      loadPage: async () => "first",
      drawPage: () => {
        started.resolve()
        return {
          promise: active.promise,
          cancel() {
            cancelled++
            active.resolve()
          },
        }
      },
      onError() {},
    })

    await started.promise
    await coordinator.render({
      loadPage: async () => "second",
      drawPage: completedTask,
      onError() {},
    })
    await first

    expect(cancelled).toBe(1)
  })

  test("reports a current page-loading failure", async () => {
    const expected = new Error("Unable to load page")
    const errors: unknown[] = []
    const coordinator = createPdfRenderCoordinator<string>()

    await coordinator.render({
      loadPage: () => Promise.reject(expected),
      drawPage: completedTask,
      onError: (cause) => errors.push(cause),
    })

    expect(errors).toEqual([expected])
  })
})
