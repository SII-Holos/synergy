import { afterAll, expect, mock, spyOn, test } from "bun:test"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { SessionSendTool } from "../../src/tools/session-send"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const baseContext = {
  sessionID: "ses_source",
  messageID: "msg_source",
  callID: "call_source",
  agent: "fixture",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

test("default user delivery admits a durable task, preserves source metadata and does not wait for a busy target", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const target = await Session.create({ workspace: null })
        const lease = SessionManager.acquire(target.id)!
        const ask = mock(async () => {})
        try {
          const tool = await SessionSendTool.init()
          const result = await tool.execute(
            tool.parameters.parse({ target: target.id, content: "please continue", sourceName: "Source agent" }),
            { ...baseContext, ask },
          )
          expect(ask).toHaveBeenCalledTimes(1)
          const items = await SessionInbox.list(target.id)
          expect(items).toHaveLength(1)
          expect(items[0]).toMatchObject({ mode: "task", message: { role: "user" } })
          expect(items[0]?.message?.metadata).toEqual({
            source: "session_send",
            sourceSessionID: "ses_source",
            sourceName: "Source agent",
          })
          expect(result.metadata).toMatchObject({
            mode: "task",
            role: "user",
            itemID: items[0]?.id,
            messageID: items[0]?.messageID,
          })
          expect(result.title).toBe(`Queued for ${target.id}`)
          expect(result.output).toContain("queued as a new task")
          expect(result.output).toContain("Reading is not yet confirmed.")
          expect(await Session.messages({ sessionID: target.id })).toEqual([])

          await SessionInbox.materializeItem(await SessionInbox.getStored(target.id, items[0]!.id))
          const [message] = await Session.messages({ sessionID: target.id })
          const userInfo = message?.info.role === "user" ? message.info : undefined
          expect(userInfo?.origin).toEqual({ type: "agent", sessionID: "ses_source", label: "Source agent" })
          const systemParts = message?.parts.filter((part) => part.type === "text" && MessageV2.isSystemPart(part))
          const userParts = message?.parts.filter((part) => part.type === "text" && !MessageV2.isSystemPart(part))
          expect(systemParts).toHaveLength(1)
          expect(systemParts?.[0]).toMatchObject({ origin: "system" })
          expect(systemParts?.[0]?.type === "text" && systemParts[0].text).toContain('"sourceSessionID":"ses_source"')
          expect(userParts?.map((part) => (part.type === "text" ? part.text : ""))).toEqual(["please continue"])
          const projected = await MessageV2.projectModelMessages([message!])
          expect(JSON.stringify(projected.messages)).toContain("please continue")
          expect(JSON.stringify(projected.messages)).toContain("Source agent")
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
          await Session.remove(target.id)
        }
      },
    }),
  ))

test("assistant role is rejected before permission or delivery", () =>
  runtime.run(async () => {
    const ask = mock(async () => {})
    using deliver = spyOn(SessionManager, "deliver")
    const tool = await SessionSendTool.init()
    const parsed = tool.parameters.safeParse({ target: "ses_target", content: "context update", role: "assistant" })
    expect(parsed.error?.issues[0]?.message).toBe(
      'session_send only supports role "user". Retry the call with role: "user".',
    )
    await expect(
      tool.execute({ target: "ses_target", content: "context update", role: "assistant" } as never, {
        ...baseContext,
        ask,
      }),
    ).rejects.toThrow('session_send only supports role "user"')
    expect(ask).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  }))

test("permission denial leaves the target inbox unchanged", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const target = await Session.create({ workspace: null })
        try {
          const tool = await SessionSendTool.init()
          await expect(
            tool.execute(
              { target: target.id, content: "not authorized", role: "user" },
              {
                ...baseContext,
                ask: async () => {
                  throw new Error("Permission denied")
                },
              },
            ),
          ).rejects.toThrow("Permission denied")
          expect(await SessionInbox.list(target.id)).toEqual([])
        } finally {
          await Session.remove(target.id)
        }
      },
    }),
  ))

for (const scenario of [
  "other-parent",
  "ordinary-child",
  "primary-task",
  "queued",
  "completed",
  "cancelled",
  "stale-running",
  "starting",
  "missing-root",
  "stopping",
  "paused",
  "rollback",
] as const) {
  test(`parent follow-up keeps task delivery for ${scenario}`, () =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const parent = await Session.create({ workspace: null })
          const other = await Session.create({ workspace: null })
          const task = await Cortex.prepare({
            description: "Delivery boundary",
            prompt: "Perform the original task.",
            agent: "developer",
            executionRole: scenario === "primary-task" ? "primary" : "delegated_subagent",
            parentSessionID: parent.id,
            parentMessageID: "msg_delivery_boundary",
            notifyParentOnComplete: false,
          })
          const root = await SessionInbox.enqueueUser({
            sessionID: task.sessionID,
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "Original task" }],
          })
          await SessionInbox.materializeItem(await SessionInbox.getStored(task.sessionID, root.id))
          await Session.update(task.sessionID, (draft) => {
            if (draft.cortex) {
              draft.cortex.status =
                scenario === "queued" || scenario === "completed" || scenario === "cancelled" ? scenario : "running"
              if (scenario === "ordinary-child") draft.cortex = undefined
            }
            if (scenario === "paused") draft.paused = { reason: "aborted", since: Date.now() }
            if (scenario === "rollback")
              draft.history = {
                rollback: {
                  id: Identifier.ascending("history"),
                  numTurns: 1,
                  created: Date.now(),
                  droppedMessageIDs: [],
                  droppedUserMessageIDs: [],
                  files: [],
                  patchPartIDs: [],
                  canUnrollback: true,
                },
              }
          })
          const lease =
            scenario === "stale-running" || scenario === "completed"
              ? undefined
              : SessionManager.acquire(task.sessionID)
          if (lease && scenario !== "starting") SessionManager.activate(lease)
          if (lease && scenario !== "missing-root") SessionManager.bindRootTask(lease, root.messageID)
          if (scenario === "stopping") SessionManager.signalAbort(task.sessionID)
          const before = await Session.get(task.sessionID)
          if (!lease) SessionManager.closeAdmission()
          try {
            const tool = await SessionSendTool.init()
            const result = await tool.execute(
              { target: task.sessionID, content: "A new follow-up", role: "user" },
              {
                ...baseContext,
                sessionID: scenario === "other-parent" ? other.id : parent.id,
                ask: async () => {},
              },
            )
            const items = await SessionInbox.list(task.sessionID)
            expect(items).toHaveLength(1)
            expect(items[0]?.mode).toBe("task")
            expect(result.metadata.mode).toBe("task")
            expect(result.output).toContain("queued as a new task")
            expect((await Session.get(task.sessionID)).paused).toEqual(before.paused)
            if (scenario === "stopping") expect(lease?.signal.aborted).toBe(true)
            if (!lease) expect(SessionManager.isRunning(task.sessionID)).toBe(false)
          } finally {
            SessionManager.openAdmission()
            if (lease) await SessionManager.release(lease, { requestNextWork: false })
            await Session.remove(task.sessionID)
            await Session.remove(parent.id)
            await Session.remove(other.id)
          }
        },
      }),
    ))
}

test("admission uses the current runtime owner after a child runtime is replaced while waiting for control", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const parent = await Session.create({ workspace: null })
        const task = await Cortex.prepare({
          description: "Runtime replacement",
          prompt: "Perform the original task.",
          agent: "developer",
          executionRole: "delegated_subagent",
          parentSessionID: parent.id,
          parentMessageID: "msg_runtime_replacement",
          notifyParentOnComplete: false,
        })
        const root = await SessionInbox.enqueueUser({
          sessionID: task.sessionID,
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "Original task" }],
        })
        await SessionInbox.materializeItem(await SessionInbox.getStored(task.sessionID, root.id))
        await Session.update(task.sessionID, (draft) => {
          if (draft.cortex) draft.cortex.status = "running"
        })
        const previous = SessionManager.acquire(task.sessionID)!
        SessionManager.activate(previous)
        SessionManager.bindRootTask(previous, root.messageID)
        const oldRuntime = SessionManager.getRuntime(task.sessionID)
        let current: typeof previous | undefined
        let control: Disposable | undefined = await Lock.write(`session-control:${task.sessionID}`)
        const waiting = Promise.withResolvers<void>()
        const lock = Lock.write
        using blocked = spyOn(Lock, "write").mockImplementation((key) => {
          if (key === `session-control:${task.sessionID}`) waiting.resolve()
          return lock(key)
        })
        try {
          const tool = await SessionSendTool.init()
          const pending = tool.execute(
            { target: task.sessionID, content: "Amend the active task.", role: "user" },
            { ...baseContext, sessionID: parent.id, ask: async () => {} },
          )
          await waiting.promise
          await SessionManager.finish(previous, { requestNextWork: false })
          current = SessionManager.acquire(task.sessionID)!
          SessionManager.activate(current)
          SessionManager.bindRootTask(current, root.messageID)
          expect(SessionManager.getRuntime(task.sessionID)).not.toBe(oldRuntime)
          control[Symbol.dispose]()
          control = undefined
          const result = await pending
          expect(result.metadata.mode).toBe("steer")
          expect((await SessionInbox.list(task.sessionID))[0]?.mode).toBe("steer")
        } finally {
          control?.[Symbol.dispose]()
          if (current) await SessionManager.finish(current, { requestNextWork: false })
          await Session.remove(task.sessionID)
          await Session.remove(parent.id)
        }
      },
    }),
  ))

afterAll(() => runtime.close())
