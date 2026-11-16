import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { LoopJob } from "../../src/session/loop-job"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferSource as Source } from "../../src/session/transfer-source"

test("source physical preparation follows every native tail outside SQL and precedes every final epoch freeze", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const root = await Session.create({ workspaceID: null, environmentID: null })
        const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
        const finish = Promise.withResolvers<void>()
        const entered = new Set<string>()
        LoopJob.register({
          type: "physical-source-tail",
          phase: "post",
          blocking: false,
          detached: true,
          collect: () => [],
          capture: (_ctx, value) => value,
          async execute(value) {
            const sessionID = String(value.sessionID)
            entered.add(sessionID)
            await finish.promise
            await Session.update(sessionID, (draft) => {
              draft.title = "Native tail retained"
            })
            return "pass"
          },
        })
        expect(
          LoopJob.scheduleDetached({
            type: "physical-source-tail",
            sessionID: root.id,
            rootID: "root-input",
            payload: { sessionID: root.id },
          }),
        ).toBe(true)
        expect(
          LoopJob.scheduleDetached({
            type: "physical-source-tail",
            sessionID: child.id,
            rootID: "child-input",
            payload: { sessionID: child.id },
          }),
        ).toBe(true)
        const binding = {
          sessionID: root.id,
          scopeID: root.scope.id,
          handoffID: "physical-source-order",
          sourceID: "runtime-a",
          targetID: "runtime-b",
          fromEpoch: 1,
          toEpoch: 2,
        }
        const values = new Map<string, Uint8Array>()
        const store = {
          async put(hash: string, bytes: Uint8Array) {
            values.set(hash, bytes.slice())
          },
          async get(hash: string) {
            const bytes = values.get(hash)
            if (!bytes) throw new Error("Missing test object")
            return bytes.slice()
          },
        }
        let barriers = 0
        let physicalCalls = 0
        const failure = new Error("Physical claim owner has not proved release")
        const prepare = (fail: boolean) =>
          Source.prepare({
            binding,
            store,
            signal: new AbortController().signal,
            async verify() {
              if (++barriers === 2) finish.resolve()
            },
            async beforeFreeze() {
              physicalCalls++
              expect(Storage.inWriteTransaction()).toBe(false)
              expect(entered.size).toBe(2)
              for (const session of [root, child]) {
                expect(LoopJob.activeBackgroundCount(session.id)).toBe(0)
                expect((await Session.get(session.id)).title).toBe("Native tail retained")
                expect(
                  (
                    await Epochs.inspect({
                      ...binding,
                      sessionID: session.id,
                      ...(session.id !== root.id ? { rootSessionID: root.id } : {}),
                    })
                  ).phase,
                ).toBe("draining")
              }
              if (fail) throw failure
              await Session.update(root.id, (draft) => {
                draft.title = "Final physical capture retained"
              })
            },
          })
        try {
          await expect(prepare(true)).rejects.toBe(failure)
          expect(physicalCalls).toBe(1)
          expect(values.size).toBe(0)
          expect(await Source.status(binding)).toBeUndefined()
          for (const session of [root, child])
            expect(
              (
                await Epochs.inspect({
                  ...binding,
                  sessionID: session.id,
                  ...(session.id !== root.id ? { rootSessionID: root.id } : {}),
                })
              ).phase,
            ).toBe("draining")
          const prepared = await prepare(false)
          expect(physicalCalls).toBe(2)
          expect(prepared.members).toBe(2)
          await Epochs.assertFrozen(root.id, binding.handoffID)
          await Epochs.assertFrozen(child.id, binding.handoffID)
          expect((await Session.get(root.id)).title).toBe("Final physical capture retained")
        } finally {
          finish.resolve()
          await LoopJob.drainAll()
        }
      },
    }),
  )
}, 15000)
