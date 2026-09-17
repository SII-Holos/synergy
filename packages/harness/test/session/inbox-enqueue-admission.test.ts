import { describe, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"

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
  test("enqueue opens a lightweight run shell that status polls observe", async () => {
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
  })

  test("materializing a queued task attaches configuration and provenance", async () => {
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
  })

  test("cancelling a queued task terminalizes its run and removes the queued work", async () => {
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
  })

  test("cancelling a queued task whose shell did not land persists a durable cancelled record", async () => {
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
  })

  test("a queued shell terminalized by startup recovery reopens at materialization", async () => {
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
  })

  test("an experiment runtime mismatch is still rejected at enqueue time", async () => {
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
  })
})
