import { expect, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { PausedTurnAbort } from "../../src/session/error"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { RuntimeMaintenance } from "../../src/storage/runtime-maintenance"
import { testRuntime } from "../support/runtime"

test("a parent pause without a verified native hold still cancels its ordinary delegated task", async () => {
  await using runtime = await testRuntime({ register: registerCortexSessionRuntime })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_parent_abort",
          agent: "developer",
          description: "Ordinary delegation",
          prompt: "Cancel this ordinary task",
        })
        await Cortex.cancelOnParentAbort(task.id, { parentSessionID: parent.id, reason: new PausedTurnAbort() })
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("cancelled")
      },
    }),
  )
})

test("a native source pause preserves only its exact transfer-owned child and ordinary cancellation errors remain visible", async () => {
  await using runtime = await testRuntime({ register: registerCortexSessionRuntime })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const foreign = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_parent_transfer",
          agent: "developer",
          description: "Retain native delegation",
          prompt: "Keep this task",
        })
        await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
        const binding = {
          scopeID: "home",
          sessionID: task.sessionID,
          rootSessionID: parent.id,
          handoffID: "parent-stop",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await Cortex.suspendForTransfer(task.id, {
          rootSessionID: parent.id,
          handoffID: binding.handoffID,
          signal: new AbortController().signal,
        })
        const held = (await Session.get(task.sessionID)).cortex
        await Cortex.cancelOnParentAbort(task.id, { parentSessionID: parent.id, reason: new PausedTurnAbort() })
        expect((await Session.get(task.sessionID)).cortex).toEqual(held)
        await expect(
          Cortex.cancelOnParentAbort(task.id, { parentSessionID: foreign.id, reason: new PausedTurnAbort() }),
        ).rejects.toThrow("parent")
        await expect(
          Cortex.cancelOnParentAbort(task.id, {
            parentSessionID: parent.id,
            reason: new Error("Ordinary cancellation"),
          }),
        ).rejects.toThrow("transfer")
        expect((await Session.get(task.sessionID)).cortex).toEqual(held)
      },
    }),
  )
})

test("a maintenance parent pause preserves the current native operation without suppressing an ordinary user cancellation", async () => {
  await using runtime = await testRuntime({
    register() {
      registerCortexSessionRuntime()
      RuntimeMaintenance.configure({ required: ["cortex"] })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          parentSessionID: parent.id,
          parentMessageID: "msg_parent_maintenance",
          agent: "developer",
          description: "Retain maintenance task",
          prompt: "Keep this task",
        })
        const requestID = "parent-maintenance"
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID,
          actor: {
            kind: "system",
            subjectID: "operator",
            displayName: "Host operator",
            clientKind: "system",
            requestID,
          },
        })
        await RuntimeMaintenance.drain(lease)
        const held = (await Session.get(task.sessionID)).cortex
        await Cortex.cancelOnParentAbort(task.id, { parentSessionID: parent.id, reason: new PausedTurnAbort() })
        expect((await Session.get(task.sessionID)).cortex).toEqual(held)
        await expect(
          Cortex.cancelOnParentAbort(task.id, {
            parentSessionID: parent.id,
            reason: new Error("Ordinary cancellation"),
          }),
        ).rejects.toThrow("maintenance")
        await RuntimeMaintenance.release(lease)
      },
    }),
  )
})
