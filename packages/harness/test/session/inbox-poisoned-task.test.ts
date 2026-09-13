import { describe, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { createUserMessage } from "../../src/session/input"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../support/fixture"

const POISONED_URL = "data:text/plain;base64,!!!"

/** enqueueUser resolves the run configuration from session history; a root
 *  message with an explicit test model keeps provider resolution out of the
 *  way so each test exercises inbox behavior only. */
async function seedRoot(sessionID: string) {
  return createUserMessage({
    sessionID,
    model: { providerID: "test", modelID: "test" },
    parts: [{ type: "text", text: "root request" }],
  })
}

describe("session inbox poisoned task parking", () => {
  test("a task that cannot materialize is parked as failed without blocking the queue", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = await seedRoot(session.id)
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          parts: [
            { type: "text", text: "poisoned task" },
            { type: "attachment", mime: "text/plain", filename: "broken.txt", url: POISONED_URL },
          ],
        })
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          parts: [{ type: "text", text: "real task" }],
        })

        const poisonedID = (await SessionInbox.peekTask(session.id))!.id
        const first = await SessionInbox.materializeNextTask(session.id)
        expect(first.status).toBe("failed")

        const stored = await SessionInbox.getStored(session.id, poisonedID)
        expect(stored.status).toBe("failed")
        expect(stored.failReason).toBeString()
        const listed = (await SessionInbox.list(session.id)).find((item) => item.id === poisonedID)
        expect(listed?.status).toBe("failed")

        expect(await SessionInbox.hasRunnableItem(session.id)).toBe(true)
        expect((await SessionInbox.peekTask(session.id))!.id).not.toBe(poisonedID)

        const second = await SessionInbox.materializeNextTask(session.id)
        expect(second.status).toBe("materialized")

        const third = await SessionInbox.materializeNextTask(session.id)
        expect(third.status).toBe("empty")

        expect(root.info.id).toBeString()
      },
    })
  })

  test("a session whose only task failed is not runnable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await seedRoot(session.id)
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          parts: [
            { type: "text", text: "poisoned task" },
            { type: "attachment", mime: "text/plain", filename: "broken.txt", url: POISONED_URL },
          ],
        })
        const result = await SessionInbox.materializeNextTask(session.id)
        expect(result.status).toBe("failed")

        expect(await SessionInbox.hasRunnableItem(session.id)).toBe(false)
        expect(await SessionInbox.peekTask(session.id)).toBeUndefined()
      },
    })
  })

  test("rearm clears the failed state so retry can re-drive the item", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await seedRoot(session.id)
        await SessionInbox.enqueueUser({
          sessionID: session.id,
          parts: [
            { type: "text", text: "poisoned task" },
            { type: "attachment", mime: "text/plain", filename: "broken.txt", url: POISONED_URL },
          ],
        })
        const itemID = (await SessionInbox.peekTask(session.id))!.id
        await SessionInbox.materializeNextTask(session.id)
        expect(await SessionInbox.peekTask(session.id)).toBeUndefined()

        await SessionInbox.rearm({ sessionID: session.id, itemID })
        const rearmed = await SessionInbox.peekTask(session.id)
        expect(rearmed?.id).toBe(itemID)
        expect(rearmed?.status).toBeUndefined()
        expect(await SessionInbox.hasRunnableItem(session.id)).toBe(true)
      },
    })
  })
})
