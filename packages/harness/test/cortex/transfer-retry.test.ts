import { expect, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { testRuntime } from "../support/runtime"

test("Cortex owner drainage can retry its exact source intent before the aggregate epoch freezes", async () => {
  await using runtime = await testRuntime({ register: registerCortexSessionRuntime })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: root.id,
          parentMessageID: "msg_retry_parent",
          agent: "developer",
          description: "Repeat owner drainage",
          prompt: "Preserve this task",
          maxCost: 2,
        })
        await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
        const binding = {
          sessionID: task.sessionID,
          rootSessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "exact-draining",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        const input = {
          sessionID: task.sessionID,
          rootSessionID: root.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        }
        await Cortex.suspendForTransfer(task.id, input)
        const before = (await Session.get(task.sessionID)).cortex
        await Cortex.suspendForTransfer(task.id, input)
        expect((await Epochs.inspect(binding)).phase).toBe("draining")
        expect((await Session.get(task.sessionID)).cortex).toEqual(before)
        await expect(Cortex.suspendForTransfer(task.id, { ...input, handoffID: "foreign" })).rejects.toThrow()
        await expect(Epochs.beginSource({ ...binding, fromEpoch: 2, toEpoch: 3 })).rejects.toThrow()
        await Epochs.cancel(binding)
        await expect(Cortex.suspendForTransfer(task.id, input)).rejects.toThrow()
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("queued")
      },
    }),
  )
})
