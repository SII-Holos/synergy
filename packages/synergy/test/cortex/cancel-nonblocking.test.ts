import { beforeEach, describe, expect, test } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("Cortex non-blocking cancel", () => {
  beforeEach(() => {
    Cortex.reset()
    CortexConcurrency.reset()
  })

  test("cancel returns without waiting for task processor settle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({ title: "nonblock-cancel" })
        const task = await Cortex.launch({
          description: "Running cancel test",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_nonblock_cancel",
        })

        expect(["running", "cancelled", "error"]).toContain(task.status)
        if (task.status === "error") return

        const start = performance.now()
        await Cortex.cancel(task.id)
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(200)
        expect(Cortex.get(task.id)?.status).toBe("cancelled")
      },
    })
  })

  test("cancelAll returns without cascading waits across descendants", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({ title: "nonblock-cancel-all" })
        const first = await Cortex.launch({
          description: "First cancellable task",
          prompt: "Do something",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_cancel_all_first",
        })
        const second = await Cortex.launch({
          description: "Second cancellable task",
          prompt: "Do something else",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_cancel_all_second",
        })

        const cancellable = [first, second].filter((task) => !["completed", "error", "cancelled"].includes(task.status))
        if (cancellable.length === 0) return

        const start = performance.now()
        const cancelled = await Cortex.cancelAll(parentSession.id)
        const elapsed = performance.now() - start

        expect(cancelled).toBe(cancellable.length)
        expect(elapsed).toBeLessThan(250)
        for (const task of cancellable) {
          expect(Cortex.get(task.id)?.status).toBe("cancelled")
        }
      },
    })
  })
})
