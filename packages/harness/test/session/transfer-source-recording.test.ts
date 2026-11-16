import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LoopJob } from "../../src/session/loop-job"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"

for (const concurrentSettlement of [false, true]) {
  test(`source retains a detached recording failure across retry${concurrentSettlement ? " and concurrent ordinary settlement" : ""}`, async () => {
    await using runtime = await testRuntime({ register: Core.register })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        async fn() {
          const root = await Session.create({ workspaceID: null, environmentID: null })
          const started = Promise.withResolvers<void>()
          const finish = Promise.withResolvers<void>()
          const error = new RolloutRecordingError({ message: "The original detached evidence was not recorded" })
          const type = "source-failed-recording"
          LoopJob.register({
            type,
            phase: "post",
            blocking: false,
            detached: true,
            collect: () => [],
            capture: (_context, instance) => instance,
            async execute() {
              started.resolve()
              await finish.promise
              throw error
            },
          })
          expect(LoopJob.scheduleDetached({ type, sessionID: root.id, rootID: "original-root" })).toBe(true)
          await started.promise
          const binding = {
            sessionID: root.id,
            scopeID: root.scope.id,
            handoffID: "failed-recording",
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
          }
          let barriers = 0
          let exported = 0
          const store = {
            async put() {
              exported++
            },
            async get(): Promise<Uint8Array> {
              throw new Error("Source must not read an unprepared package")
            },
          }
          const prepare = () =>
            Source.prepare({
              binding,
              store,
              signal: new AbortController().signal,
              async verify() {
                if (++barriers !== 2) return
                finish.resolve()
                if (concurrentSettlement) await LoopJob.settleDetached(root.id).catch(() => {})
              },
            })
          try {
            await expect(prepare()).rejects.toBe(error)
            await LoopJob.settleDetached(root.id).catch(() => {})
            await expect(prepare()).rejects.toBe(error)
            expect(exported).toBe(0)
            expect(await Source.status(binding)).toBeUndefined()
            expect((await Epochs.inspect(binding)).phase).toBe("draining")
            expect((await Session.get(root.id)).paused).toBeDefined()
          } finally {
            finish.resolve()
            await LoopJob.drainAll().catch(() => {})
          }
        },
      }),
    )
  }, 15000)
}

test("source retains an undiscovered child's recording failure without retaining an unrelated root's failure", async () => {
  let rootID = ""
  let childID = ""
  let otherID = ""
  let reached = false
  const finish = Promise.withResolvers<void>()
  const childError = new RolloutRecordingError({ message: "Undiscovered child evidence failed" })
  const otherError = new RolloutRecordingError({ message: "Unrelated evidence failed" })
  await using runtime = await testRuntime({
    register() {
      Core.register()
      Owners.register("discovery-barrier", {
        version: 1,
        reads: [1],
        async applies(session) {
          if (session.id === rootID && !reached) {
            reached = true
            finish.resolve()
            await expect(LoopJob.settleDetached(childID)).rejects.toBe(childError)
            await expect(LoopJob.settleDetached(otherID)).rejects.toBe(otherError)
            await expect(LoopJob.settleDetached(otherID)).resolves.toBeUndefined()
          }
          return false
        },
        async inspect() {
          return { requirements: [], children: (async function* () {})() }
        },
        async freeze() {},
        async *export() {},
        async validate() {},
        async publish() {},
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        rootID = root.id
        childID = (await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })).id
        otherID = (await Session.create({ workspaceID: null, environmentID: null })).id
        const type = "source-discovery-recording"
        LoopJob.register({
          type,
          phase: "post",
          blocking: false,
          detached: true,
          collect: () => [],
          capture: (_context, instance) => instance,
          async execute(payload) {
            await finish.promise
            throw payload.sessionID === childID ? childError : otherError
          },
        })
        for (const sessionID of [childID, otherID])
          expect(LoopJob.scheduleDetached({ type, sessionID, rootID: "original-root", payload: { sessionID } })).toBe(
            true,
          )
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "failed-child-recording",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const store = {
          async put() {},
          async get(): Promise<Uint8Array> {
            throw new Error("Source must not read an unprepared package")
          },
        }
        const prepare = () =>
          Source.prepare({ binding, store, signal: new AbortController().signal, async verify() {} })
        try {
          await expect(prepare()).rejects.toBe(childError)
          await expect(prepare()).rejects.toBe(childError)
          expect(reached).toBe(true)
          expect(await Source.status(binding)).toBeUndefined()
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
        } finally {
          finish.resolve()
          await LoopJob.drainAll().catch(() => {})
        }
      },
    }),
  )
}, 15000)

test("cancelling source drainage stops waiting without cancelling its native recording tail", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const started = Promise.withResolvers<void>()
        const finish = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        let executions = 0
        let cancelled = false
        const type = "source-cancelled-recording-wait"
        LoopJob.register({
          type,
          phase: "post",
          blocking: false,
          detached: true,
          collect: () => [],
          capture: (_context, instance) => instance,
          async execute(_payload, signal) {
            executions++
            started.resolve()
            await finish.promise
            cancelled = signal.aborted
            await Session.update(root.id, (draft) => {
              draft.title = "Original tail saved"
            })
            return "pass"
          },
        })
        expect(LoopJob.scheduleDetached({ type, sessionID: root.id, rootID: "original-root" })).toBe(true)
        await started.promise
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "cancelled-recording-wait",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const store = {
          async put() {},
          async get(): Promise<Uint8Array> {
            throw new Error("Source must not read an unprepared package")
          },
        }
        let barriers = 0
        const controller = new AbortController()
        const reason = new Error("Stop waiting for source recording")
        const outcome = Promise.withResolvers<{ kind: "settled"; error: unknown } | { kind: "waiting" }>()
        const work = Source.prepare({
          binding,
          store,
          signal: controller.signal,
          async verify() {
            if (++barriers === 2) waiting.resolve()
          },
        }).then(
          () => {
            outcome.resolve({ kind: "settled", error: undefined })
          },
          (error) => {
            outcome.resolve({ kind: "settled", error })
          },
        )
        await waiting.promise
        const rescue = setTimeout(() => outcome.resolve({ kind: "waiting" }), 1000)
        try {
          controller.abort(reason)
          const observed = await outcome.promise
          expect(observed.kind).toBe("settled")
          if (observed.kind !== "settled") throw new Error("Source did not stop waiting for recording")
          expect(observed.error).toBe(reason)
          expect(LoopJob.activeBackgroundCount(root.id)).toBe(1)
          expect(await Source.status(binding)).toBeUndefined()
          expect((await Epochs.inspect(binding)).phase).toBe("draining")
        } finally {
          clearTimeout(rescue)
          finish.resolve()
          await work
          await LoopJob.settleDetached(root.id)
        }
        const prepared = await Source.prepare({
          binding,
          store,
          signal: new AbortController().signal,
          async verify() {},
        })
        expect(prepared.members).toBe(1)
        expect(executions).toBe(1)
        expect(cancelled).toBe(false)
        expect((await Session.get(root.id)).title).toBe("Original tail saved")
      },
    }),
  )
}, 15000)
