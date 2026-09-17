import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"

describe("session inbox enqueue admission", () => {
  test("enqueueUser returns before any rollout run is opened", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "queued request" }],
        })
        expect(item.id).toBeString()
        const owner = RolloutLifecycle.owner(await Session.get(session.id))
        await expect(RolloutLedger.getRun(owner, item.messageID)).rejects.toBeInstanceOf(Storage.NotFoundError)
      },
    })
  })

  test("materializing a queued task opens the run with configuration and provenance", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "queued request" }],
        })
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

  test("cancelling a queued task that has not opened a run removes it and reports cancellation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "queued request" }],
        })
        const record = await RolloutLifecycle.cancel(session.id, item.messageID)
        expect(record.status).toBe("cancelled")
        expect(record.cancelRequestedAt).toBeNumber()
        const remaining = await SessionInbox.list(session.id)
        expect(remaining.find((entry) => entry.id === item.id)).toBeUndefined()
        expect(await SessionInbox.hasRunnableItem(session.id)).toBeFalse()
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
      },
    })
  })
})
