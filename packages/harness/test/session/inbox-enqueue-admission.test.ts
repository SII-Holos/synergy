import { describe, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Config } from "../../src/config/config"
import { StorageBusyError } from "../../src/storage/errors"
import { Storage } from "../../src/storage/storage"
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
  test("enqueue opens a lightweight run shell that status polls observe", () =>
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
          const run = await RolloutLedger.getRun(owner, item.messageID)
          expect(run.status).toBe("running")
          expect(run.configuration).toBeUndefined()
          expect(run.provenance).toBeUndefined()
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
          // The enqueue shell is best-effort; simulate its write failing.
          using shell = spyOn(RolloutLedger, "beginRun").mockRejectedValueOnce(new Error("shell write failed"))
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
          const shellStarted = Promise.withResolvers<string>()
          const releaseShell = Promise.withResolvers<void>()
          const cancelStarted = Promise.withResolvers<void>()
          const releaseCancel = Promise.withResolvers<void>()
          const beginRun = RolloutLedger.beginRun
          const cancelUnopenedRun = RolloutLedger.cancelUnopenedRun
          using shell = spyOn(RolloutLedger, "beginRun").mockImplementation(async (identity, runID) => {
            shellStarted.resolve(runID)
            await releaseShell.promise
            return beginRun(identity, runID)
          })
          using cancellation = spyOn(RolloutLedger, "cancelUnopenedRun").mockImplementation(async (...args) => {
            cancelStarted.resolve()
            await releaseCancel.promise
            return cancelUnopenedRun(...args)
          })
          const enqueue = enqueueTask(session.id)
          const runID = await shellStarted.promise
          const cancel = RolloutLifecycle.cancel(session.id, runID)
          try {
            await cancelStarted.promise
            releaseShell.resolve()
            await enqueue
            releaseCancel.resolve()
            expect((await cancel).status).toBe("cancelled")
            const run = await RolloutLedger.getRun(owner, runID)
            expect(run.status).toBe("cancelled")
            expect(run.ended).toBeNumber()
            expect(await SessionInbox.hasRunnableItem(session.id)).toBeFalse()
          } finally {
            releaseShell.resolve()
            releaseCancel.resolve()
            await Promise.allSettled([enqueue, cancel])
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
          expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).status).toBe("running")
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
          expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).status).toBe("running")
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
          expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), item.messageID)).status).toBe("failed")
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

afterRuntimeTests(() => runtime.close())
