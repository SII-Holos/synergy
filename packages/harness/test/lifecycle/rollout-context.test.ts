import { expect, test } from "bun:test"
import { RuntimeContext } from "../../src/lifecycle/context"
import { RolloutContext } from "../../src/session/rollout/context"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { RolloutTool } from "../../src/session/rollout/tool"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { testRuntime } from "../support/runtime"

test("rollout identity cannot follow a nested call into another Runtime or an exited callback", async () => {
  await using a = await testRuntime()
  await using b = await testRuntime()
  const identity: RolloutContext.Identity = {
    owner: { kind: "operation", scopeID: "test", operationID: "operation" },
    runID: "run",
  }
  a.run(() =>
    RolloutContext.provide(identity, () => {
      expect(b.run(() => RolloutContext.current())).toBeUndefined()
      expect(RuntimeContext.exit(() => RolloutContext.current())).toBeUndefined()
      expect(RolloutContext.current()).toEqual(identity)
    }),
  )
})

test("a nested Runtime fetch cannot write into the caller's rollout transport sink", async () => {
  await using a = await testRuntime()
  await using b = await testRuntime()
  const events: RolloutTransport.Event[] = []
  const fetch = () => RolloutTransport.fetch(async () => new Response(null, { status: 204 }), "https://fixture.test")
  await a.run(() =>
    RolloutTransport.provide(
      async (event) => {
        events.push(event)
      },
      async () => {
        await b.run(fetch)
        await RuntimeContext.exit(fetch)
        expect(events).toEqual([])
        await fetch()
        expect(events.at(-1)).toMatchObject({ type: "attempt-end", status: "completed" })
      },
    ),
  )
})

test("tool completion callbacks remain owned by their execution Runtime", async () => {
  await using a = await testRuntime()
  await using b = await testRuntime()
  await a.run(async () => {
    const input = {
      owner: { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() },
      runID: crypto.randomUUID(),
      messageID: "message",
      toolCallID: "tool-call",
      tool: "test",
      args: {},
    }
    await RolloutLedger.beginRun(input.owner, input.runID)
    let completed = false
    await RolloutTool.execute(input, async () => {
      expect(() => b.run(() => RolloutTool.afterCommit(() => {}))).toThrow("no execution owner")
      expect(() => RuntimeContext.exit(() => RolloutTool.afterCommit(() => {}))).toThrow("no execution owner")
      RolloutTool.afterCommit(() => {
        completed = true
      })
      return "done"
    })
    expect(completed).toBe(true)
    await RolloutLedger.finishRun(input.owner, input.runID, "completed")
  })
})
