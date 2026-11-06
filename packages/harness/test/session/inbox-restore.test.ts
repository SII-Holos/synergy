import { afterAll, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("remove and restore preserve the canonical input and mode, including hidden variant", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          noReply: true,
          variant: "high",
          system: "Keep original context",
          tools: { bash: false },
          metadata: { source: "original" },
          parts: [{ type: "text", text: "A queued direction" }],
        })
        const original = await SessionInbox.getStored(session.id, item.id)
        expect(item.message?.variant).toBeUndefined()
        await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
        expect(await SessionInbox.list(session.id)).toEqual([])
        expect((await SessionInbox.listRemoved(session.id)).map((entry) => entry.id)).toEqual([item.id])
        const results = await Promise.all(
          [1, 2].map(() => SessionInbox.restore({ sessionID: session.id, itemID: item.id })),
        )
        expect(results.filter((result) => result.restored)).toHaveLength(1)
        const restored = await SessionInbox.getStored(session.id, item.id)
        expect(restored.input).toEqual(original.input)
        expect(restored.message).toEqual(original.message)
        expect(restored.mode).toBe("steer")
        expect(restored.messageID).toBe(original.messageID)
        expect(await SessionInbox.listRemoved(session.id)).toEqual([])
        await SessionInbox.remove({ sessionID: session.id, itemID: item.id })
        expect((await SessionInbox.restore({ sessionID: session.id, itemID: item.id })).restored).toBe(false)
        expect(await SessionInbox.list(session.id)).toEqual([])
      },
    })
  }))

test("old sessions have an empty removed list and deletion is isolated to the owning session", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const other = await Session.create({})
        expect(await SessionInbox.listRemoved(session.id)).toEqual([])
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Retain" }],
        })
        await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
        await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
        await expect(SessionInbox.restore({ sessionID: other.id, itemID: item.id })).rejects.toThrow()
        expect(await SessionInbox.listRemoved(session.id)).toHaveLength(1)
        await Session.remove(session.id)
        await expect(SessionInbox.listRemoved(session.id)).rejects.toThrow()
      },
    })
  }))

test("the first queued task remains protected when removing for restore", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          parts: [{ type: "text", text: "First task" }],
        })
        await expect(SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })).rejects.toMatchObject({
          name: "SessionInboxFirstTaskLockedError",
        })
        expect(await SessionInbox.list(session.id)).toHaveLength(1)
        expect(await SessionInbox.listRemoved(session.id)).toEqual([])
      },
    })
  }))

test("rollback cannot publish a removed item or a restoration receipt", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          noReply: true,
          parts: [{ type: "text", text: "Keep atomically" }],
        })
        await expect(
          Storage.transaction(async () => {
            await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
            throw new Error("Rollback removal")
          }),
        ).rejects.toThrow("Rollback removal")
        expect(await SessionInbox.list(session.id)).toHaveLength(1)
        expect(await SessionInbox.listRemoved(session.id)).toEqual([])
        await SessionInbox.removeForRestore({ sessionID: session.id, itemID: item.id })
        await expect(
          Storage.transaction(async () => {
            await SessionInbox.restore({ sessionID: session.id, itemID: item.id })
            throw new Error("Rollback restore")
          }),
        ).rejects.toThrow("Rollback restore")
        expect(await SessionInbox.list(session.id)).toEqual([])
        expect(await SessionInbox.listRemoved(session.id)).toHaveLength(1)
        expect((await SessionInbox.restore({ sessionID: session.id, itemID: item.id })).restored).toBe(true)
      },
    })
  }))
