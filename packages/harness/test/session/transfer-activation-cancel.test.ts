import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { Lock } from "../../src/util/lock"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

const binding = {
  sessionID: "ses_cancelled_activation",
  scopeID: "home",
  handoffID: "queued-activation",
  sourceID: "A",
  targetID: "B",
  fromEpoch: 1,
  toEpoch: 2,
}

test("activation cancellation settles before a held epoch lock is released without entering publication", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Epochs.reserve(binding, "a".repeat(64))
    const held = await Lock.write("session-transfer-epoch:" + binding.sessionID)
    const signal = new AbortController()
    const reason = new Error("Stop waiting for the target epoch")
    let publications = 0
    const pending = Epochs.activateMany({
      bindings: [binding],
      manifestHash: "a".repeat(64),
      signal: signal.signal,
      async publish() {
        publications++
        signal.signal.throwIfAborted()
      },
    })
    const outcome = pending.then(
      () => "completed",
      (error: unknown) => error,
    )
    signal.abort(reason)
    const observed = await Promise.race([outcome, Bun.sleep(100).then(() => "still queued")])
    held[Symbol.dispose]()
    await outcome
    expect(observed).toBe(reason)
    expect(publications).toBe(0)
    expect((await Epochs.inspect(binding)).phase).toBe("prepared")
  })
})

test("cancellation during the final epoch pointer write rolls back the entire paused publication", async () => {
  const signal = new AbortController()
  const reason = new Error("Target connection ended before commit")
  let armed = false
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("activation-abort-at-pointer", async (_tx, keys) => {
        if (armed && keys.some((key) => key[0] === "session_transfer_epoch_current")) signal.abort(reason)
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Epochs.reserve(binding, "a".repeat(64))
        armed = true
        const outcome = await Epochs.activateMany({
          bindings: [binding],
          manifestHash: "a".repeat(64),
          signal: signal.signal,
          async publish() {
            await Session.create({ id: binding.sessionID, workspaceID: null, environmentID: null })
            await SessionLifecycle.pause({ sessionID: binding.sessionID, reason: "interrupted" })
          },
        }).then(
          () => "published",
          (error: unknown) => error,
        )
        expect(outcome).toBe(reason)
        expect((await Epochs.inspect(binding)).phase).toBe("prepared")
        await expect(Session.get(binding.sessionID)).rejects.toThrow()
      },
    }),
  )
})

test("queued activation keeps its validated manifest and publication callback", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Epochs.reserve(binding, "a".repeat(64))
        const held = await Lock.write("session-transfer-epoch:" + binding.sessionID)
        let original = 0
        let replacement = 0
        const input = {
          bindings: [binding],
          manifestHash: "a".repeat(64),
          async publish() {
            original++
            await Session.create({ id: binding.sessionID, workspaceID: null, environmentID: null })
            await SessionLifecycle.pause({ sessionID: binding.sessionID, reason: "interrupted" })
          },
        }
        const pending = Epochs.activateMany(input)
        void pending.catch(() => {})
        input.manifestHash = "b".repeat(64)
        input.publish = async () => {
          replacement++
        }
        held[Symbol.dispose]()
        await pending
        expect(original).toBe(1)
        expect(replacement).toBe(0)
        expect((await Epochs.inspect(binding)).phase).toBe("activated")
      },
    }),
  )
})

test("replacing a queued activation signal cannot discard the original cancellation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Epochs.reserve(binding, "a".repeat(64))
    const held = await Lock.write("session-transfer-epoch:" + binding.sessionID)
    const signal = new AbortController()
    const reason = new Error("Original activation observer closed")
    let publications = 0
    const input = {
      bindings: [binding],
      manifestHash: "a".repeat(64),
      signal: signal.signal,
      async publish() {
        publications++
      },
    }
    const outcome = Epochs.activateMany(input).then(
      () => "completed",
      (error: unknown) => error,
    )
    input.signal = new AbortController().signal
    signal.abort(reason)
    const observed = await Promise.race([outcome, Bun.sleep(100).then(() => "still queued")])
    held[Symbol.dispose]()
    await outcome
    expect(observed).toBe(reason)
    expect(publications).toBe(0)
    expect((await Epochs.inspect(binding)).phase).toBe("prepared")
  })
})
