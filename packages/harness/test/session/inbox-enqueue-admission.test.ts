import { describe, expect, spyOn, test } from "bun:test"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Config } from "../../src/config/config"
import { StorageBusyError } from "../../src/storage/errors"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

/** enqueueUser resolves the run configuration from session history; a root
 *  message with an explicit test model keeps provider resolution out of the
 *  way so each test exercises inbox behavior only. */
async function seedRoot(sessionID: string) {
  return SessionInbox.enqueueUser({
    sessionID,
    model: { providerID: "test", modelID: "test" },
    noReply: true,
    parts: [{ type: "text", text: "root request" }],
  })
}

function enqueueTask(sessionID: string) {
  return SessionInbox.enqueueUser({
    sessionID,
    model: { providerID: "test", modelID: "test" },
    parts: [{ type: "text", text: "queued request" }],
  })
}

describe("session inbox enqueue admission", () => {
  for (const restored of [false, true])
    test(`a historical input without a revision remains materializable after restoration=${restored}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            if (restored) {
              await enqueueTask(session.id)
              await SessionInbox.materializeNextTask(session.id)
            }
            const item = await enqueueTask(session.id)
            const { revision, ...historical } = await SessionInbox.getStored(session.id, item.id)
            expect(revision).toBeGreaterThan(0)
            if (restored) {
              await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
              await Storage.update<{ item: Partial<SessionInbox.StoredItem> }>(
                StoragePath.sessionInboxRemovedItem(
                  Identifier.asScopeID(session.scope.id),
                  Identifier.asSessionID(session.id),
                  item.id,
                ),
                (draft) => {
                  delete draft.item.revision
                },
              )
              await SessionInbox.restore({ sessionID: session.id, itemID: item.id })
              expect((await SessionInbox.getStored(session.id, item.id)).revision).toBe(1)
            } else
              await Storage.write(
                StoragePath.sessionInboxItem(
                  Identifier.asScopeID(session.scope.id),
                  Identifier.asSessionID(session.id),
                  item.id,
                ),
                historical,
              )
            expect(await SessionInbox.materializeNextTask(session.id)).toMatchObject({
              status: "materialized",
              messageID: item.messageID,
            })
          },
        })
      }))

  test("queued references use the target Session workspace instead of the caller's Scope", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const session = await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Session.create({}) })
      expect(session.workspace).not.toBeNull()
      await using caller = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await caller.scope(),
        fn: async () => {
          const queued = await SessionInbox.enqueueUser({
            sessionID: session.id,
            parts: [{ type: "text", text: "See src/app.ts" }],
          })
          expect(queued.message?.referenceContext).toEqual(ResourceReference.capture(session.workspace))
          const delivered = await SessionInbox.deliver({
            sessionID: session.id,
            mode: "steer",
            message: { role: "user", parts: [{ type: "text", text: "Another reference" }] },
          })
          expect((await SessionInbox.get(session.id, delivered.itemID)).message?.referenceContext).toEqual(
            ResourceReference.capture(session.workspace),
          )
        },
      })
    }))
  test("passive inputs remain discoverable for recovery without requesting a model reply", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await SessionInbox.enqueueUser(
            { sessionID: session.id, noReply: true, parts: [{ type: "text", text: "save without replying" }] },
            { mode: "steer", admission: "idle_no_reply" },
          )
          expect(await SessionInbox.hasRunnableItem(session.id)).toBe(true)
          expect(await SessionInbox.hasRunnableItem(session.id, { allowPassive: false })).toBe(false)
          await enqueueTask(session.id)
          expect(await SessionInbox.hasRunnableItem(session.id, { allowPassive: false })).toBe(true)
        },
      })
    }))

  test("accepted inbox notifications already observe their committed navigation activity", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(
            session.id,
            (draft) => {
              draft.time.updated = 1
            },
            { preserveActivityAt: true },
          )
          let observed: number | undefined
          const release = Bus.subscribe(SessionInbox.Event.Updated, async (event) => {
            if (event.properties.sessionID !== session.id || !event.properties.items.length) return
            observed = (await Session.get(session.id)).time.updated
          })
          try {
            await enqueueTask(session.id)
            expect(observed).toBeGreaterThan(1)
          } finally {
            release()
          }
        },
      })
    }))

  test("retrying a cancelled input never resurrects its queued work", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const input = {
            sessionID: session.id,
            messageID: "msg_cancelled_retry",
            parts: [{ type: "text" as const, text: "send once" }],
          }
          const item = await SessionInbox.enqueueUser(input)
          await RolloutLifecycle.cancel(session.id, item.messageID)
          expect((await SessionInbox.enqueueUser(input)).id).toBe(item.id)
          expect(await SessionInbox.list(session.id)).toHaveLength(0)
          expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).status).toBe("cancelled")
        },
      })
    }))

  test("concurrent retries retain the supplied message identity and one inbox item", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const input = {
            sessionID: session.id,
            messageID: "msg_retry_identity",
            model: { providerID: "test", modelID: "test" },
            parts: [{ type: "text" as const, text: "send once" }],
          }
          const [first, retry] = await Promise.all([SessionInbox.enqueueUser(input), SessionInbox.enqueueUser(input)])
          expect(first.messageID).toBe(input.messageID)
          expect(retry.id).toBe(first.id)
          expect(await SessionInbox.list(session.id)).toHaveLength(1)
          await SessionInbox.materializeNextTask(session.id)
          expect((await SessionInbox.enqueueUser(input)).id).toBe(first.id)
          expect(await SessionInbox.list(session.id)).toHaveLength(0)
        },
      })
    }))

  test("queued input stays durable without opening an execution", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await seedRoot(session.id)
          const item = await enqueueTask(session.id)
          expect(item.id).toBeString()
          const owner = RolloutLifecycle.owner(await Session.get(session.id))
          await expect(RolloutLedger.getRun(owner, item.messageID)).rejects.toBeInstanceOf(Storage.NotFoundError)
          expect((await SessionInbox.get(session.id, item.id)).messageID).toBe(item.messageID)
        },
      })
    }))

  test("materializing a queued task attaches configuration and provenance", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const item = await enqueueTask(session.id)
          const result = await SessionInbox.materializeNextTask(session.id)
          expect(result).toEqual({ status: "materialized", itemID: item.id, messageID: item.messageID })

          const owner = RolloutLifecycle.owner(await Session.get(session.id))
          const run = await RolloutLedger.getRun(owner, item.messageID)
          expect(run.status).toBe("running")
          expect(run.configuration).toBeDefined()
          expect(run.provenance).toBeDefined()
        },
      })
    }))

  test("cancelling a queued task terminalizes its run and removes the queued work", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const item = await enqueueTask(session.id)
          const record = await RolloutLifecycle.cancel(session.id, item.messageID)
          expect(record.status).toBe("cancelled")
          expect(record.cancelRequestedAt).toBeNumber()
          const owner = RolloutLifecycle.owner(await Session.get(session.id))
          expect((await RolloutLedger.getRun(owner, item.messageID)).status).toBe("cancelled")
          expect((await SessionInbox.list(session.id)).find((entry) => entry.id === item.id)).toBeUndefined()
          expect(await SessionInbox.hasRunnableItem(session.id)).toBeFalse()
        },
      })
    }))

  test("cancelling a queued task whose shell did not land persists a durable cancelled record", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const owner = RolloutLifecycle.owner(await Session.get(session.id))
          const item = await enqueueTask(session.id)
          await expect(RolloutLedger.getRun(owner, item.messageID)).rejects.toBeInstanceOf(Storage.NotFoundError)

          const record = await RolloutLifecycle.cancel(session.id, item.messageID)
          expect(record.status).toBe("cancelled")
          expect((await RolloutLedger.getRun(owner, item.messageID)).status).toBe("cancelled")
          expect(await SessionInbox.hasRunnableItem(session.id)).toBeFalse()
        },
      })
    }))

  test("a queued shell terminalized by startup recovery reopens at materialization", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const owner = RolloutLifecycle.owner(await Session.get(session.id))
          const item = await enqueueTask(session.id)
          await RolloutLedger.beginRun(owner, item.messageID)
          // Startup recovery terminalizes runs that were running at shutdown.
          await RolloutLedger.finishRun(owner, item.messageID, "interrupted")

          const result = await SessionInbox.materializeNextTask(session.id)
          expect(result).toEqual({ status: "materialized", itemID: item.id, messageID: item.messageID })
          const run = await RolloutLedger.getRun(owner, item.messageID)
          expect(run.status).toBe("running")
          expect(run.configuration).toBeDefined()
        },
      })
    }))

  test("an experiment runtime mismatch is still rejected at enqueue time", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await expect(
            SessionInbox.enqueueUser({
              sessionID: session.id,
              parts: [{ type: "text", text: "experiment task" }],
              experiment: {
                version: 1,
                label: "mismatched",
                overrides: {},
                runtime: { cortex: { maxConcurrentTasks: 3 } },
              },
            }),
          ).rejects.toThrow()
          expect(await SessionInbox.hasRunnableItem(session.id)).toBeFalse()
        },
      })
    }))

  test("cancellation settles a shell that appears after the initial run lookup", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const owner = RolloutLifecycle.owner(session)
          const cancelStarted = Promise.withResolvers<void>()
          const releaseCancel = Promise.withResolvers<void>()
          const cancelUnopenedRun = RolloutLedger.cancelUnopenedRun
          using cancellation = spyOn(RolloutLedger, "cancelUnopenedRun").mockImplementation(async (...args) => {
            cancelStarted.resolve()
            await releaseCancel.promise
            return cancelUnopenedRun(...args)
          })
          const item = await enqueueTask(session.id)
          const runID = item.messageID
          const cancel = RolloutLifecycle.cancel(session.id, runID)
          try {
            await cancelStarted.promise
            await RolloutLedger.beginRun(owner, runID)
            releaseCancel.resolve()
            expect((await cancel).status).toBe("cancelled")
            const run = await RolloutLedger.getRun(owner, runID)
            expect(run.status).toBe("cancelled")
            expect(run.ended).toBeNumber()
            expect(await SessionInbox.hasRunnableItem(session.id)).toBeFalse()
          } finally {
            releaseCancel.resolve()
            await Promise.allSettled([cancel])
          }
        },
      })
    }))

  test("non-cancellation DOM exceptions remain visible to the caller", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const item = await enqueueTask(session.id)
          const error = new DOMException("Configuration timed out", "TimeoutError")
          using resolution = spyOn(Config, "resolveExecutionDetails").mockRejectedValueOnce(error)
          await expect(SessionInbox.materializeNextTask(session.id)).rejects.toBe(error)
          await expect(RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).rejects.toBeInstanceOf(
            Storage.NotFoundError,
          )
        },
      })
    }))

  test("transient configuration storage pressure leaves the queued run retryable", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const item = await enqueueTask(session.id)
          const error = new StorageBusyError("Storage queue is full")
          using resolution = spyOn(Config, "resolveExecutionDetails").mockRejectedValueOnce(error)
          await expect(SessionInbox.materializeNextTask(session.id)).rejects.toBe(error)
          await expect(RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).rejects.toBeInstanceOf(
            Storage.NotFoundError,
          )
          expect(await SessionInbox.materializeNextTask(session.id)).toEqual({
            status: "materialized",
            itemID: item.id,
            messageID: item.messageID,
          })
        },
      })
    }))

  test("configuration failure parks its task and retry reopens the run", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const item = await enqueueTask(session.id)
          const next = await enqueueTask(session.id)
          using resolution = spyOn(Config, "resolveExecutionDetails").mockRejectedValueOnce(new Error("Invalid config"))
          expect(await SessionInbox.materializeNextTask(session.id)).toMatchObject({
            status: "failed",
            itemID: item.id,
          })
          await expect(RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).rejects.toBeInstanceOf(
            Storage.NotFoundError,
          )
          expect(await SessionInbox.materializeNextTask(session.id)).toMatchObject({
            status: "materialized",
            itemID: next.id,
          })
          await SessionInbox.rearm({ sessionID: session.id, itemID: item.id })
          expect(await SessionInbox.materializeNextTask(session.id)).toMatchObject({
            status: "materialized",
            itemID: item.id,
          })
        },
      })
    }))

  test("configuration failure racing cancellation cannot restore the removed task", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const item = await enqueueTask(session.id)
          const resolving = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          using resolution = spyOn(Config, "resolveExecutionDetails").mockImplementationOnce(async () => {
            resolving.resolve()
            await release.promise
            throw new Error("Invalid config")
          })
          const materializing = SessionInbox.materializeNextTask(session.id)
          try {
            await resolving.promise
            expect((await RolloutLifecycle.cancel(session.id, item.messageID)).status).toBe("cancelled")
            release.resolve()
            expect(await materializing).toEqual({ status: "empty" })
            expect(await SessionInbox.list(session.id)).toEqual([])
            expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).status).toBe(
              "cancelled",
            )
          } finally {
            release.resolve()
            await materializing
          }
        },
      })
    }))
})

for (const action of ["guide", "guide-again", "remove", "cancel"] as const) {
  test(`materialization cannot commit an input changed by ${action}`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await enqueueTask(session.id)
          await SessionInbox.materializeNextTask(session.id)
          const item = await enqueueTask(session.id)
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const resolve = Config.resolveExecutionDetails
          using resolution = spyOn(Config, "resolveExecutionDetails").mockImplementationOnce(async () => {
            const configuration = await resolve()
            entered.resolve()
            await release.promise
            return configuration
          })
          const materializing = SessionInbox.materializeNextTask(session.id)
          try {
            await entered.promise
            if (action.startsWith("guide")) {
              await SessionInbox.guide({ sessionID: session.id, itemID: item.id })
              if (action === "guide-again") await SessionInbox.guide({ sessionID: session.id, itemID: item.id })
            } else if (action === "remove")
              await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
            else await RolloutLifecycle.cancel(session.id, item.messageID)
            release.resolve()
            expect(await materializing).toEqual({ status: "empty" })
            const { MessageV2 } = await import("../../src/session/message-v2")
            await expect(MessageV2.get({ sessionID: session.id, messageID: item.messageID })).rejects.toBeInstanceOf(
              Storage.NotFoundError,
            )
            if (action === "remove") {
              const { SessionInputStatus } = await import("../../src/session/input-status")
              expect((await SessionInputStatus.get({ sessionID: session.id, messageID: item.messageID })).state).toBe(
                "removed",
              )
              const first = await SessionInbox.restore({ sessionID: session.id, itemID: item.id })
              const second = await SessionInbox.restore({ sessionID: session.id, itemID: item.id })
              expect(first.restored).toBe(true)
              expect(second.restored).toBe(false)
              expect(await SessionInbox.materializeNextTask(session.id)).toMatchObject({
                status: "materialized",
                messageID: item.messageID,
              })
            }
          } finally {
            release.resolve()
            await materializing
          }
        },
      })
    }))
}

afterRuntimeTests(() => runtime.close())
