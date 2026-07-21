import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import * as SessionWorking from "../../src/session/working"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"
import { SessionInvoke } from "../../src/session/invoke"
import { Cortex } from "../../src/cortex"
import { SessionInbox } from "../../src/session/inbox"
import { SessionEvent } from "../../src/session/event"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function assertExists<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error("expected defined value")
}

describe("SessionWorking", () => {
  describe("resolve()", () => {
    test("returns undefined for idle session with no messages", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const result = await SessionWorking.resolve(session.id)
          expect(result).toBeUndefined()
        },
      })
    })

    test("returns busy when runtime is active", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const runtime = SessionManager.registerRuntime(session.id)
          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()
          runtime.status = { type: "busy", description: "testing" }

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("busy")
          if (result.status === "busy") expect(result.description).toBe("testing")

          await SessionManager.release(lease!)
          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("returns retry when runtime is retrying", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const runtime = SessionManager.registerRuntime(session.id)
          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()
          const now = Date.now()
          runtime.status = {
            type: "retry",
            attempt: 3,
            message: "API error",
            next: now + 5000,
          }

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("retry")
          if (result.status === "retry") {
            expect(result.attempt).toBe(3)
            expect(result.message).toBe("API error")
            expect(result.next).toBeGreaterThan(now)
          }

          await SessionManager.release(lease!)
          SessionManager.unregisterRuntime(session.id)
        },
      })
    })

    test("ignores stored pendingReply without runtime work", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })

          const result = await SessionWorking.resolve(session.id)
          expect(result).toBeUndefined()
        },
      })
    })

    test("ignores stale stored working metadata without runtime work", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.working = { status: "busy", description: "stale" }
          })

          const resolved = await SessionWorking.resolve(session.id)
          expect(resolved).toBeUndefined()

          const refreshed = await Session.get(session.id)
          expect(refreshed.working).toBeUndefined()
        },
      })
    })

    test("returns recovering when last assistant message lacks time.completed", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("recovering")
        },
      })
    })
    test("uses message creation time to find the latest incomplete assistant", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: 100 },
          })
          const delayedAssistantID = Identifier.ascending("message")
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: 200, completed: 200 },
            finish: "stop",
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await Session.updateMessage({
            id: delayedAssistantID,
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: 300 },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          const result = await SessionWorking.resolve(session.id)
          assertExists(result)
          expect(result.status).toBe("recovering")
        },
      })
    })
  })

  describe("toStatus()", () => {
    test("converts busy WorkingInfo to StatusInfo", () => {
      const result = SessionWorking.toStatus({ status: "busy", description: "cooking" })
      expect(result).toEqual({ type: "busy", description: "cooking" })
    })

    test("converts retry WorkingInfo to StatusInfo", () => {
      const now = Date.now()
      const result = SessionWorking.toStatus({
        status: "retry",
        attempt: 2,
        message: "timeout",
        next: now,
      })
      expect(result).toEqual({ type: "retry", attempt: 2, message: "timeout", next: now })
    })

    test("converts recovering WorkingInfo to StatusInfo", () => {
      const result = SessionWorking.toStatus({ status: "recovering" })
      expect(result).toEqual({ type: "recovering" })
    })
  })

  describe("repairAfterAbort()", () => {
    test("repairs incomplete assistant message so resolve() stops returning recovering", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})

          // Set pendingReply on the session to simulate a stuck session
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })

          // Create an incomplete assistant message (time.committed == null)
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          const assistantID = Identifier.ascending("message")
          await Session.updateMessage({
            id: assistantID,
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          // Before repair: should be recovering
          const before = await SessionWorking.resolve(session.id)
          assertExists(before)
          expect(before.status).toBe("recovering")

          const statuses: Array<{ type: string }> = []
          let idleEvents = 0
          const unsubscribeStatus = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })
          const unsubscribeIdle = Bus.subscribe(SessionEvent.Idle, (event) => {
            if (event.properties.sessionID === session.id) idleEvents++
          })

          const repaired = await SessionInvoke.repairAfterAbort(session.id)
          unsubscribeStatus()
          unsubscribeIdle()

          expect(repaired).toBe(true)
          expect(statuses).toEqual([{ type: "idle" }])
          expect(idleEvents).toBe(0)

          // After repair: should not be recovering
          const after = await SessionWorking.resolve(session.id)
          expect(after).toBeUndefined()

          // pendingReply should be cleared
          const refreshed = await Session.get(session.id)
          expect(refreshed.pendingReply).toBeUndefined()

          // Assistant message should now have time.completed and error
          const msgs = await Session.messages({ sessionID: session.id })
          const assistant = msgs.find((m) => m.info.id === assistantID)
          assertExists(assistant)
          expect(assistant.info.role).toBe("assistant")
          const assistantInfo = assistant.info as import("../../src/session/message-v2").MessageV2.Assistant
          expect(assistantInfo.time.completed).toBeGreaterThan(0)
          expect(assistantInfo.finish).toBe("error")
          expect(assistantInfo.error).toBeDefined()
          expect(assistantInfo.error?.name).toBe("MessageAbortedError")
        },
      })
    })

    test("does not publish idle status while an active runtime is still stopping", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()
          const statuses: Array<{ type: string }> = []
          const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })

          try {
            expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(true)
            expect(statuses).toEqual([])
          } finally {
            unsubscribe()
            await SessionManager.release(lease!)
            SessionManager.unregisterRuntime(session.id)
          }
        },
      })
    })

    test("does not republish idle status when abort repair is repeated", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          const statuses: Array<{ type: string }> = []
          const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })

          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(true)
          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(false)
          unsubscribe()
          expect(statuses).toEqual([{ type: "idle" }])
        },
      })
    })

    test("no-ops when session does not exist", async () => {
      expect(await SessionInvoke.repairAfterAbort("ses_nonexistent")).toBe(false)
    })

    test("no-ops when session has no messages", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(false)
        },
      })
    })

    test("no-ops when latest assistant already has time.completed", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: userMsg.id,
            time: { created: Date.now(), completed: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })

          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(false)

          // Should still be complete (not recovering)
          const result = await SessionWorking.resolve(session.id)
          expect(result).toBeUndefined()
        },
      })
    })

    test("resumePending repairs the latest interrupted turn and publishes idle status", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const completedUserID = Identifier.ascending("message")
          const completedUser = await Session.updateMessage({
            id: completedUserID,
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID: completedUserID,
          })
          const completedAssistantID = Identifier.ascending("message")
          await Session.updateMessage({
            id: completedAssistantID,
            sessionID: session.id,
            role: "assistant",
            parentID: completedUser.id,
            time: { created: Date.now(), completed: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })
          const interruptedUserID = Identifier.ascending("message")
          const interruptedUser = await Session.updateMessage({
            id: interruptedUserID,
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID: interruptedUserID,
          })
          const interruptedAssistantID = Identifier.ascending("message")
          await Session.updateMessage({
            id: interruptedAssistantID,
            sessionID: session.id,
            role: "assistant",
            parentID: interruptedUser.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })

          const statuses: Array<{ type: string }> = []
          let idleEvents = 0
          const unsubscribeStatus = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })
          const unsubscribeIdle = Bus.subscribe(SessionEvent.Idle, (event) => {
            if (event.properties.sessionID === session.id) idleEvents++
          })

          try {
            await SessionInvoke.resumePending({ scopeID: ScopeContext.current.scope.id })
          } finally {
            unsubscribeStatus()
            unsubscribeIdle()
          }

          expect(statuses).toEqual([{ type: "idle" }])
          expect(idleEvents).toBe(0)
          expect((await Session.get(session.id)).pendingReply).toBeUndefined()
          expect(await SessionWorking.resolve(session.id)).toBeUndefined()

          const messages = await Session.messages({ sessionID: session.id })
          const completedAssistant = messages.find((message) => message.info.id === completedAssistantID)?.info as
            | import("../../src/session/message-v2").MessageV2.Assistant
            | undefined
          const interruptedAssistant = messages.find((message) => message.info.id === interruptedAssistantID)?.info as
            | import("../../src/session/message-v2").MessageV2.Assistant
            | undefined
          assertExists(completedAssistant)
          assertExists(interruptedAssistant)
          expect(completedAssistant.time.completed).toBeNumber()
          expect(completedAssistant.finish).toBe("stop")
          expect(completedAssistant.error).toBeUndefined()
          expect(interruptedAssistant.time.completed).toBeNumber()
          expect(interruptedAssistant.finish).toBe("error")
          expect(interruptedAssistant.error?.name).toBe("MessageAbortedError")
        },
      })
    })

    test("resumePending reconciles interrupted Cortex delegation state after restart", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const parentMessageID = Identifier.ascending("message")
          const child = await Session.create({
            parentID: parent.id,
            cortex: {
              taskID: "cortex-interrupted-test",
              parentSessionID: parent.id,
              parentMessageID,
              description: "Interrupted child task",
              agent: "developer",
              startedAt: Date.now(),
              status: "running",
            },
          })

          await Session.update(child.id, (draft) => {
            draft.pendingReply = true
          })

          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: child.id,
            role: "assistant",
            parentID: parentMessageID,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          await SessionInvoke.resumePending({ scopeID: ScopeContext.current.scope.id })

          const refreshed = await Session.get(child.id)
          expect(refreshed.cortex?.status).toBe("interrupted")
          expect(refreshed.cortex?.completedAt).toBeNumber()
          expect(refreshed.cortex?.error).toContain("Server restarted")
          expect(refreshed.pendingReply).toBeUndefined()
          expect(await SessionWorking.resolve(child.id)).toBeUndefined()

          const messages = await Session.messages({ sessionID: child.id })
          const assistant = messages.find((message) => message.info.role === "assistant")?.info as
            | import("../../src/session/message-v2").MessageV2.Assistant
            | undefined
          assertExists(assistant)
          expect(assistant.time.completed).toBeNumber()
          expect(assistant.finish).toBe("error")
        },
      })
    })

    test("resumePending re-drives Light Loop review after marking its reviewer interrupted", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const parentMessageID = Identifier.ascending("message")
          const child = await Session.create({
            parentID: parent.id,
            cortex: {
              taskID: "cortex-interrupted-light-loop-review",
              parentSessionID: parent.id,
              parentMessageID,
              description: "Review LightLoop",
              agent: "lightloop-reviewer",
              startedAt: Date.now(),
              status: "running",
            },
          })
          await Session.update(parent.id, (draft) => {
            draft.workflow = {
              kind: "lightloop",
              instructions: "Finish the task",
              stopRequest: {
                summary: "Task complete",
                requestedAt: Date.now(),
                requesterSessionID: parent.id,
                requesterMessageID: parentMessageID,
                reviewTaskID: child.cortex?.taskID,
                reviewSessionID: child.id,
              },
            }
          })
          await SessionInvoke.resumePending({ scopeID: ScopeContext.current.scope.id })
          const childSession = await Session.get(child.id)
          const parentSession = await Session.get(parent.id)
          const workflow = parentSession.workflow
          expect(childSession.cortex?.status).toBe("interrupted")
          expect(workflow?.kind).toBe("lightloop")
          if (workflow?.kind === "lightloop") {
            expect(workflow.stopRequest?.reviewTaskID).toBeUndefined()
            expect(workflow.stopRequest?.reviewSessionID).toBeUndefined()
          }
        },
      })
    })

    test("resumePending restores an undelivered terminal Cortex notification exactly once", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const completedAt = Date.now()
          const taskID = "cortex-terminal-recovery-test"
          const child = await Session.create({
            parentID: parent.id,
            cortex: {
              taskID,
              parentSessionID: parent.id,
              parentMessageID: Identifier.ascending("message"),
              description: "Completed child task",
              agent: "developer",
              startedAt: completedAt - 1_000,
              completedAt,
              status: "completed",
              notifyParentOnComplete: true,
            },
          })
          Cortex.reset()

          await SessionInvoke.resumePending({ scopeID: ScopeContext.current.scope.id })

          const firstItems = await SessionInbox.list(parent.id)
          expect(firstItems).toHaveLength(1)
          expect(firstItems[0].deliveryKey).toBe(`cortex:taskNotification:${taskID}`)
          expect(firstItems[0].source.type).toBe("cortex")
          const delivered = await Session.get(child.id)
          expect(delivered.cortex?.deliveryNotifiedAt).toBeNumber()
          const deliveredAt = delivered.cortex?.deliveryNotifiedAt

          await SessionInvoke.resumePending({ scopeID: ScopeContext.current.scope.id })

          expect(await SessionInbox.list(parent.id)).toHaveLength(1)
          expect((await Session.get(child.id)).cortex?.deliveryNotifiedAt).toBe(deliveredAt)
        },
      })
    })
  })
})
