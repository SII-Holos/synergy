import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { tmpdir } from "../fixture/fixture"

function reset() {
  Cortex.reset()
  CortexConcurrency.reset()
}

describe("Cortex non-blocking cancel", () => {
  beforeEach(reset)
  afterEach(reset)

  test.each([
    { operation: "cancel", count: 1 },
    { operation: "cancelAll", count: 2 },
  ] as const)(
    "$operation returns while descendant processors remain pending",
    async ({ operation, count }) => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const started = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const invocations: Promise<never>[] = []
          let settled = 0
          const invoke = spyOn(SessionInvoke, "invokeInternal").mockImplementation(() => {
            const pending = (async () => {
              await release.promise
              settled++
              throw new DOMException("Task stopped", "AbortError")
            })()
            invocations.push(pending)
            if (invocations.length === count) started.resolve()
            return pending
          })
          const deadline = Promise.withResolvers<never>()
          let timer: ReturnType<typeof setTimeout> | undefined

          try {
            const parent = await Session.create({ title: "nonblocking cancellation" })
            const tasks: Awaited<ReturnType<typeof Cortex.launch>>[] = []
            let parentSessionID = parent.id
            for (let index = 0; index < count; index++) {
              const task = await Cortex.launch({
                description: `Pending task ${index}`,
                prompt: "Wait until released",
                agent: "developer",
                parentSessionID,
                parentMessageID: `msg_nonblock_cancel_${index}`,
                model: { providerID: "test-provider", modelID: "test-model" },
                notifyParentOnComplete: false,
              })
              tasks.push(task)
              parentSessionID = task.sessionID
            }
            timer = setTimeout(() => deadline.reject(new Error("Cancellation waited for a held processor")), 10_000)
            await Promise.race([started.promise, deadline.promise])
            for (const task of tasks) expect(Cortex.get(task.id)?.status).toBe("running")

            const cancelled = await Promise.race([
              operation === "cancel" ? Cortex.cancel(tasks[0].id) : Cortex.cancelAll(parent.id),
              deadline.promise,
            ])
            if (operation === "cancelAll") expect(cancelled).toBe(count)
            expect(settled).toBe(0)
            let drained = false
            const drainage = Cortex.drain(tasks[0].id).then(() => {
              drained = true
            })
            await new Promise<void>((resolve) => setImmediate(resolve))
            expect(drained).toBe(false)
            for (const task of tasks) {
              expect(Cortex.get(task.id)?.status).toBe("cancelled")
              expect((await Session.get(task.sessionID)).cortex?.status).toBe("cancelled")
            }
            expect(CortexConcurrency.status().developer?.running).toBe(0)
            release.resolve()
            await drainage
            expect(drained).toBe(true)
            expect(settled).toBe(count)
          } finally {
            clearTimeout(timer)
            release.resolve()
            await Promise.allSettled(invocations)
            await new Promise<void>((resolve) => setImmediate(resolve))
            invoke.mockRestore()
          }
        },
      })
    },
    20_000,
  )
})
