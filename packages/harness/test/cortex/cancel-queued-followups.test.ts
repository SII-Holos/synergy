import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
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
})
