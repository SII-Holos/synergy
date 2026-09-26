import { expect, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

test("cancelled Cortex output waits settle without cancelling the delegated task", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        const task = await Cortex.prepare({
          description: "Queued child",
          prompt: "Wait",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_wait_cancel",
        })
        const controller = new AbortController()
        const waiting = Cortex.waitFor(task.id, 300, controller.signal)
        controller.abort(new Error("output wait cancelled"))
        await expect(waiting).rejects.toThrow("output wait cancelled")
        expect(Cortex.get(task.id)?.status).toBe("queued")
        await Cortex.cancel(task.id)
      },
    })
  })
})
