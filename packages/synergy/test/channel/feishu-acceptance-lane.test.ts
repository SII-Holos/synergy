import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { ChannelConversationAcceptance } from "../../src/channel/conversation-acceptance"
import { ChannelBusyHandoff } from "../../src/channel/busy-handoff"

/**
 * The provider-lane acceptance contract: a same-scope lane awaits only durable
 * acceptance of each inbound message, not the full generation. The first idle
 * execution stays pending in the background while a second same-key arrival
 * resolves acceptance by durably queuing into the SessionInbox. Different keys
 * overlap. Background execution rejections are always observed.
 *
 * This exercises the same generic acceptance helper the Feishu provider lane
 * calls, without requiring a live provider connection or LLM.
 */
describe("Channel conversation acceptance lane", () => {
  test("first acceptance resolves while its execution remains pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const execution = Promise.withResolvers<void>()
        const acceptance = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_first",
          parts: [{ type: "text", text: "first" }],
          metadata: { channelReply: true },
          execute: () => execution.promise,
        })

        expect(acceptance.accepted).toBe(true)
        if (!acceptance.accepted) throw new Error("expected acceptance")
        // The execution is separate and still pending.
        expect(await Promise.race([acceptance.execution.then(() => "done"), Promise.resolve("pending")])).toBe(
          "pending",
        )
        const accepted = await SessionInbox.list(session.id)
        expect(accepted).toHaveLength(1)
        expect(accepted[0]?.deliveryKey).toBe("channel:feishu:acct:msg_first")

        let replayExecuted = false
        const replay = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_first",
          parts: [{ type: "text", text: "first" }],
          metadata: { channelReply: true },
          execute: async () => {
            replayExecuted = true
          },
        })
        expect(replay.accepted).toBe(true)
        expect(replayExecuted).toBe(false)
        expect(await SessionInbox.list(session.id)).toHaveLength(1)

        execution.resolve()
        await acceptance.execution
      },
    })
  })

  test("busy session acceptance durably queues one inbox task without running the handler", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        if (!lease) throw new Error("expected lease")

        try {
          let executed = false
          const acceptance = await ChannelConversationAcceptance.accept({
            sessionID: session.id,
            deliveryKey: "channel:feishu:acct:msg_busy",
            parts: [{ type: "text", text: "busy" }],
            metadata: { channelReply: true },
            execute: async () => {
              executed = true
            },
          })
          expect(acceptance.accepted).toBe(true)
          if (!acceptance.accepted) throw new Error("expected acceptance")
          expect(executed).toBe(false)

          const items = await SessionInbox.list(session.id)
          expect(items).toHaveLength(1)
          expect(items[0]?.deliveryKey).toBe("channel:feishu:acct:msg_busy")
          await acceptance.execution
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  })

  test("same-session second acceptance is durably queued while the first execution remains pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const gate = Promise.withResolvers<void>()
        const first = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_a",
          parts: [{ type: "text", text: "a" }],
          metadata: { channelReply: true },
          execute: () => gate.promise,
        })
        expect(first.accepted).toBe(true)
        expect(SessionManager.isRunning(session.id)).toBe(true)

        let secondExecuted = false
        const second = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_b",
          parts: [{ type: "text", text: "b" }],
          metadata: { channelReply: true },
          execute: async () => {
            secondExecuted = true
          },
        })
        expect(second.accepted).toBe(true)
        expect(secondExecuted).toBe(false)

        const items = await SessionInbox.list(session.id)
        expect(items.map((item) => item.deliveryKey)).toEqual([
          "channel:feishu:acct:msg_a",
          "channel:feishu:acct:msg_b",
        ])

        gate.resolve()
        if (first.accepted) await first.execution
      },
    })
  })

  test("does not run a newer direct execution ahead of an existing queued task", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_queued_first",
          mode: "task",
          message: {
            role: "user",
            parts: [{ type: "text", text: "queued first" }],
          },
        })

        let executed = false
        const acceptance = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_newer",
          parts: [{ type: "text", text: "newer" }],
          metadata: { channelReply: true },
          execute: async () => {
            executed = true
          },
        })

        expect(acceptance.accepted).toBe(true)
        expect(executed).toBe(false)
        expect((await SessionInbox.list(session.id)).map((item) => item.deliveryKey)).toEqual([
          "channel:feishu:acct:msg_queued_first",
          "channel:feishu:acct:msg_newer",
        ])
      },
    })
  })

  test("replaying a materialized direct delivery does not execute again", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const deliveryKey = "channel:feishu:acct:msg_direct_replay"
        await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey,
          mode: "task",
          message: {
            role: "user",
            parts: [{ type: "text", text: "already handled" }],
          },
        })
        const item = (await SessionInbox.list(session.id))[0]
        await SessionInbox.materializeItem(item)
        await SessionInbox.commitReady(session.id, [item.id])

        let executed = false
        const replay = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey,
          parts: [{ type: "text", text: "already handled" }],
          metadata: { channelReply: true },
          execute: async () => {
            executed = true
          },
        })

        expect(replay.accepted).toBe(true)
        expect(executed).toBe(false)
        expect(SessionManager.isRunning(session.id)).toBe(false)
        expect(await SessionInbox.list(session.id)).toHaveLength(0)
      },
    })
  })

  test("replaying the same delivery key does not create a duplicate inbox item", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        if (!lease) throw new Error("expected lease")

        try {
          const first = await ChannelConversationAcceptance.accept({
            sessionID: session.id,
            deliveryKey: "channel:feishu:acct:msg_same",
            parts: [{ type: "text", text: "same" }],
            metadata: { channelReply: true },
            execute: async () => {},
          })
          expect(first.accepted).toBe(true)

          const replay = await ChannelConversationAcceptance.accept({
            sessionID: session.id,
            deliveryKey: "channel:feishu:acct:msg_same",
            parts: [{ type: "text", text: "same" }],
            metadata: { channelReply: true },
            execute: async () => {},
          })
          expect(replay.accepted).toBe(true)
          expect(await SessionInbox.list(session.id)).toHaveLength(1)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  })

  test("different keys accept in parallel", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const first = await Session.create({})
        const second = await Session.create({})
        const gate = Promise.withResolvers<void>()

        const firstAcceptance = ChannelConversationAcceptance.accept({
          sessionID: first.id,
          deliveryKey: "channel:feishu:acct:msg_1",
          parts: [{ type: "text", text: "one" }],
          metadata: { channelReply: true },
          execute: () => gate.promise,
        })
        const secondAcceptance = ChannelConversationAcceptance.accept({
          sessionID: second.id,
          deliveryKey: "channel:feishu:acct:msg_2",
          parts: [{ type: "text", text: "two" }],
          metadata: { channelReply: true },
          execute: async () => {},
        })

        // Both acceptances resolve independently; neither waits for the other's execution.
        const [a, b] = await Promise.all([firstAcceptance, secondAcceptance])
        expect(a.accepted).toBe(true)
        expect(b.accepted).toBe(true)

        gate.resolve()
        if (a.accepted) await a.execution
        if (b.accepted) await b.execution
      },
    })
  })

  test("execution rejection is observed, not unhandled", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const failure = new Error("execution boom")
        const gate = Promise.withResolvers<void>()
        const acceptance = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_reject",
          parts: [{ type: "text", text: "reject" }],
          metadata: { channelReply: true },
          execute: () => gate.promise,
        })
        expect(acceptance.accepted).toBe(true)
        if (!acceptance.accepted) throw new Error("expected acceptance")
        // A later rejection of the tracked execution surfaces to its observer.
        gate.reject(failure)
        await expect(acceptance.execution).rejects.toBe(failure)
      },
    })
  })

  test("pre-invoke execution failure is reported by the accepted execution", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const failure = new Error("streaming unavailable")
        const acceptance = await ChannelConversationAcceptance.accept({
          sessionID: session.id,
          deliveryKey: "channel:feishu:acct:msg_sync_fail",
          parts: [{ type: "text", text: "sync fail" }],
          metadata: { channelReply: true },
          execute: async () => {
            throw failure
          },
        })
        expect(acceptance.accepted).toBe(true)
        if (!acceptance.accepted) throw new Error("expected acceptance")
        await expect(acceptance.execution).rejects.toBe(failure)
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })

  test("delivery key is stable and unique across messages", async () => {
    const a = ChannelBusyHandoff.deliveryKeyForMessage({
      channelType: "feishu",
      accountId: "acct",
      messageId: "m1",
    })
    const b = ChannelBusyHandoff.deliveryKeyForMessage({
      channelType: "feishu",
      accountId: "acct",
      messageId: "m2",
    })
    expect(a).toBe("channel:feishu:acct:m1")
    expect(b).toBe("channel:feishu:acct:m2")
    expect(a).not.toBe(b)
  })
})
