import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Session, SessionChildrenPage } from "@ericsanchezok/synergy-sdk/client"
import { createSubsessionController } from "./subsession-controller"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function child(id: string): Session {
  return { id } as Session
}

function page(total: number, ids: string[] = []): SessionChildrenPage {
  return {
    items: ids.map(child),
    nextCursor: null,
    total,
  }
}

function withController<T>(
  loadChildren: Parameters<typeof createSubsessionController>[0]["loadChildren"],
  run: (
    controller: ReturnType<typeof createSubsessionController>,
    setSessionID: (sessionID: string) => void,
  ) => T | Promise<T>,
) {
  return createRoot((dispose) => {
    const [sessionID, setSessionID] = createSignal("parent-a")
    const controller = createSubsessionController({ sessionID, loadChildren })
    return Promise.resolve(run(controller, setSessionID)).finally(dispose)
  })
}

describe("status bar subsession controller", () => {
  test("keeps loaded children visible while refreshing the same session", async () => {
    const refresh = deferred<SessionChildrenPage>()
    let request = 0

    await withController(
      async () => {
        request += 1
        return request === 1 ? page(2, ["child-a", "child-b"]) : refresh.promise
      },
      async (controller) => {
        await controller.loadPage({ pageIndex: 0, cursor: null })
        expect(controller.total()).toBe(2)
        expect(controller.items().map((item) => item.id)).toEqual(["child-a", "child-b"])

        const pending = controller.loadPage({ pageIndex: 0, cursor: null })
        expect(controller.loading()).toBe(true)
        expect(controller.total()).toBe(2)
        expect(controller.items().map((item) => item.id)).toEqual(["child-a", "child-b"])

        refresh.resolve(page(3, ["child-a", "child-b", "child-c"]))
        await pending
        expect(controller.total()).toBe(3)
        expect(controller.items().map((item) => item.id)).toEqual(["child-a", "child-b", "child-c"])
      },
    )
  })

  test("retries the latest failed root request instead of the displayed page cursor", async () => {
    const previousCursor = { lastActivityAt: 42, id: "child-a" }
    const requests: Parameters<typeof createSubsessionController>[0]["loadChildren"] extends (
      request: infer Request,
    ) => Promise<SessionChildrenPage>
      ? Request[]
      : never = []
    let request = 0

    await withController(
      async (input) => {
        requests.push(input)
        request += 1
        if (request === 1) return page(16, ["child-i"])
        if (request === 2) throw new Error("search failed")
        return page(1, ["child-match"])
      },
      async (controller) => {
        await controller.loadPage({
          pageIndex: 1,
          cursor: previousCursor,
          startCursors: [null, previousCursor],
        })
        await controller.loadPage({ pageIndex: 0, cursor: null, startCursors: [null], query: "match" })
        expect(controller.error()).toBe(true)

        await controller.retry()
        expect(requests[2]).toEqual({
          sessionID: "parent-a",
          limit: 8,
          search: "match",
          cursor: null,
        })
        expect(controller.pageIndex()).toBe(0)
        expect(controller.startCursors()).toEqual([null])
      },
    )
  })

  test("clears the previous session and ignores its stale response", async () => {
    const stale = deferred<SessionChildrenPage>()
    let request = 0

    await withController(
      async () => {
        request += 1
        if (request === 1) return page(1, ["child-a"])
        return stale.promise
      },
      async (controller, setSessionID) => {
        await controller.loadPage({ pageIndex: 0, cursor: null })
        const pending = controller.loadPage({ pageIndex: 0, cursor: null })

        setSessionID("parent-b")
        controller.reset()
        expect(controller.total()).toBeUndefined()
        expect(controller.items()).toEqual([])
        expect(controller.loading()).toBe(false)

        stale.resolve(page(2, ["stale-a", "stale-b"]))
        await pending
        expect(controller.total()).toBeUndefined()
        expect(controller.items()).toEqual([])
      },
    )
  })
})
