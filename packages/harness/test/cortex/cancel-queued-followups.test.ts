import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"

function reset() {
  Cortex.reset()
  CortexConcurrency.reset()
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000, message = "timed out") {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message)
    await Bun.sleep(5)
  }
}

function followUpMail(sessionID: string, sourceSessionID: string, text: string) {
  return {
    type: "user" as const,
    parts: [
      {
        id: `part_${Math.random().toString(36).slice(2)}`,
        sessionID,
        messageID: `msg_${Math.random().toString(36).slice(2)}`,
        type: "text" as const,
        text,
      },
    ],
    metadata: { source: "session_send", sourceSessionID },
  }
}

describe("Cortex cancellation fences queued follow-ups", () => {
  test("cancellation discards mail queued in the same clock millisecond", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ title: "same millisecond cancellation" })
        const task = await Cortex.prepare({
          description: "queued task",
          prompt: "work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_same_tick",
          notifyParentOnComplete: false,
        })
        const now = Date.now()
        using clock = spyOn(Date, "now").mockReturnValue(now)
        await SessionInbox.enqueueMail({
          sessionID: task.sessionID,
          mail: followUpMail(task.sessionID, parent.id, "before cancellation"),
        })
        await Cortex.cancel(task.id)
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(false)
        await SessionInbox.enqueueMail({
          sessionID: task.sessionID,
          mail: followUpMail(task.sessionID, parent.id, "after cancellation"),
        })
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(true)
      },
    })
  })

  test("cancellation waits for an inbox write already in flight before purging", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ title: "inflight inbox cancellation" })
        const task = await Cortex.prepare({
          description: "queued task",
          prompt: "work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_inflight_inbox",
          notifyParentOnComplete: false,
        })
        const held = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const realWrite = Storage.write
        using write = spyOn(Storage, "write").mockImplementation(async (key, value, options) => {
          if (key.includes(task.sessionID) && key.some((part) => part.startsWith("inb_"))) {
            held.resolve()
            await release.promise
          }
          return realWrite(key, value, options)
        })
        const delivery = SessionInbox.enqueueMail({
          sessionID: task.sessionID,
          mail: followUpMail(task.sessionID, parent.id, "inflight before cancellation"),
        })
        await held.promise
        const cancellation = Cortex.cancel(task.id)
        try {
          await new Promise<void>((resolve) => setImmediate(resolve))
        } finally {
          release.resolve()
        }
        await Promise.all([delivery, cancellation])
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(false)
      },
    })
  })

  test("cancelAll reports a failed child while still cancelling the other children", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ title: "partial cancellation" })
        const first = await Cortex.prepare({
          description: "first",
          prompt: "work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_partial_first",
          notifyParentOnComplete: false,
        })
        const second = await Cortex.prepare({
          description: "second",
          prompt: "work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_partial_second",
          notifyParentOnComplete: false,
        })
        const remove = SessionInbox.fenceQueuedWork
        using failure = spyOn(SessionInbox, "fenceQueuedWork").mockImplementation((sessionID, ...args) => {
          if (sessionID === first.sessionID) throw new Error("inbox unavailable")
          return remove(sessionID, ...args)
        })
        await expect(Cortex.cancelAll(parent.id)).rejects.toThrow("1 of 2")
        expect(Cortex.get(first.id)?.status).toBe("queued")
        expect(Cortex.get(second.id)?.status).toBe("cancelled")
      },
    })
  })

  beforeEach(reset)
  afterEach(() => {
    reset()
    mock.restore()
  })

  test("cancelling a running task discards its queued follow-up instead of restarting it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        spyOn(SessionInvoke, "invokeInternal").mockImplementation(() => {
          started.resolve()
          return (async () => {
            await release.promise
            throw new DOMException("Task stopped", "AbortError")
          })() as Promise<never>
        })
        const loop = spyOn(SessionInvoke, "loop").mockResolvedValue({} as never)
        spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)

        const parent = await Session.create({ title: "cancel fence" })
        const task = await Cortex.launch({
          description: "Pending task",
          prompt: "Do the work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_cancel_fence_1",
          model: { providerID: "test-provider", modelID: "test-model" },
          notifyParentOnComplete: false,
        })
        await started.promise
        expect(Cortex.get(task.id)?.status).toBe("running")

        await SessionManager.deliver({
          target: task.sessionID,
          mail: followUpMail(task.sessionID, parent.id, "Stop expanding; run the focused tests."),
        })
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(true)

        await Cortex.cancel(task.id)

        // Let any wake chain queued before cancellation settle before measuring.
        await Bun.sleep(20)
        const loopCallsBeforeRelease = loop.mock.calls.length

        expect(Cortex.get(task.id)?.status).toBe("cancelled")
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("cancelled")
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(false)

        release.resolve()
        await Cortex.drain(task.id)
        await Bun.sleep(100)

        expect(loop.mock.calls.length).toBe(loopCallsBeforeRelease)
        const messages = await Session.messages({ sessionID: task.sessionID })
        const roots = messages.filter((m) => m.info.role === "user" && (m.info as MessageV2.User).isRoot === true)
        expect(roots).toHaveLength(0)

        await SessionManager.deliver({
          target: task.sessionID,
          mail: followUpMail(task.sessionID, parent.id, "New explicit work after cancellation."),
        })
        await waitFor(() => loop.mock.calls.length >= 1, 2_000, "post-cancel mail was not driven")
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(true)
      },
    })
  })

  test("runtime timeout fences queued follow-ups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const started = Promise.withResolvers<void>()
        spyOn(SessionInvoke, "invokeInternal").mockImplementation(() => {
          started.resolve()
          return new Promise<never>(() => {})
        })
        spyOn(SessionInvoke, "loop").mockResolvedValue({} as never)

        const parent = await Session.create({ title: "timeout fence" })
        const task = await Cortex.launch({
          description: "Stuck task",
          prompt: "Do the work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_timeout_fence_1",
          model: { providerID: "test-provider", modelID: "test-model" },
          notifyParentOnComplete: false,
          timeoutMs: 50,
        })
        await started.promise

        await SessionManager.deliver({
          target: task.sessionID,
          mail: followUpMail(task.sessionID, parent.id, "Queued corrective follow-up."),
        })
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(true)

        await waitFor(() => Cortex.get(task.id)?.status === "error", 2_000, "task did not hit its runtime limit")
        expect(await SessionInbox.hasRunnableItem(task.sessionID)).toBe(false)
        await waitFor(
          async () => ((await Session.get(task.sessionID)).cortex?.settledAt ?? 0) > 0,
          2_000,
          "timeout settlement did not complete",
        )
      },
    })
  })

  test("fence cutoff discards only follow-ups queued before cancellation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ title: "fence cutoff" })
        const firstItem = await SessionInbox.enqueueMail({
          sessionID: parent.id,
          mail: followUpMail(parent.id, parent.id, "queued before cancellation"),
        })
        // Advance past the first item's created millisecond so the cutoff is
        // strictly newer than it even under timer coalescing.
        while (Date.now() <= firstItem.time.created) await Bun.sleep(1)
        const cutoff = Date.now()
        await Bun.sleep(5)
        await SessionInbox.enqueueMail({
          sessionID: parent.id,
          mail: followUpMail(parent.id, parent.id, "explicit new work after cancellation"),
        })

        expect(await SessionInbox.hasRunnableItem(parent.id)).toBe(true)
        const removed = await SessionInbox.removeByModes(parent.id, ["task", "steer", "context"], cutoff)
        expect(removed).toBe(1)

        const remaining = await SessionInbox.list(parent.id)
        expect(remaining).toHaveLength(1)
        const keptText = remaining[0]?.message?.parts.find((part) => part.type === "text")
        expect(keptText?.type === "text" ? keptText.text : "").toContain("after cancellation")

        expect(await SessionInbox.hasRunnableItem(parent.id, { createdAfter: cutoff })).toBe(true)
        expect(await SessionInbox.hasRunnableItem(parent.id, { createdAfter: Date.now() + 5_000 })).toBe(false)
      },
    })
  })

  test("cancellation surfaces cleanup failure instead of acknowledging", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        spyOn(SessionInvoke, "invokeInternal").mockImplementation(() => {
          started.resolve()
          return (async () => {
            await release.promise
            throw new DOMException("Task stopped", "AbortError")
          })() as Promise<never>
        })
        spyOn(SessionInvoke, "loop").mockResolvedValue({} as never)
        spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)

        const parent = await Session.create({ title: "cancel cleanup failure" })
        const task = await Cortex.launch({
          description: "Stuck task",
          prompt: "Do the work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_cancel_cleanup_failure",
          model: { providerID: "test-provider", modelID: "test-model" },
          notifyParentOnComplete: false,
        })
        await started.promise
        await waitFor(async () => (await Session.get(task.sessionID)).cortex?.status === "running")

        spyOn(SessionInbox, "fenceQueuedWork").mockRejectedValue(new Error("storage unavailable"))
        await expect(Cortex.cancel(task.id)).rejects.toThrow("queued follow-ups")
        expect(Cortex.get(task.id)?.status).toBe("running")
        expect((await Session.get(task.sessionID)).cortex?.status).toBe("running")

        release.resolve()
        await Cortex.drain(task.id)
      },
    })
  })

  test("timeout with failing cleanup still surfaces the runtime-limit error and a cleanup warning", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const started = Promise.withResolvers<void>()
        spyOn(SessionInvoke, "invokeInternal").mockImplementation(() => {
          started.resolve()
          return new Promise<never>(() => {})
        })
        spyOn(SessionInvoke, "loop").mockResolvedValue({} as never)
        spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
        spyOn(SessionInbox, "fenceQueuedWork").mockRejectedValue(new Error("storage unavailable"))

        const parent = await Session.create({ title: "timeout cleanup failure" })
        const task = await Cortex.launch({
          description: "Stuck task",
          prompt: "Do the work",
          agent: "developer",
          parentSessionID: parent.id,
          parentMessageID: "msg_timeout_cleanup_failure",
          model: { providerID: "test-provider", modelID: "test-model" },
          notifyParentOnComplete: false,
          timeoutMs: 50,
        })
        await started.promise

        await waitFor(() => Cortex.get(task.id)?.status === "error", 2_000, "task did not hit its runtime limit")
        const error = Cortex.get(task.id)?.error ?? ""
        expect(error).toContain("runtime limit")
        expect(error).toContain("cleanup failed")
        await waitFor(
          async () => ((await Session.get(task.sessionID)).cortex?.settledAt ?? 0) > 0,
          2_000,
          "timeout settlement did not complete",
        )
      },
    })
  })
})
