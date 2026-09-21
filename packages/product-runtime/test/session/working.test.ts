import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { describe, expect, mock, test } from "bun:test"
import path from "path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import * as SessionWorking from "@ericsanchezok/synergy-harness/session/working"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import "@ericsanchezok/synergy-product-runtime/product-registration"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function assertExists<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error("expected defined value")
}

async function createTerminalLightLoopSession() {
  const parent = await Session.create({})
  const rootID = Identifier.ascending("message")
  const user = await Session.updateMessage({
    id: rootID,
    sessionID: parent.id,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
    isRoot: true,
    rootID,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: parent.id,
    messageID: user.id,
    type: "text",
    text: "Finish the task",
  })
  const terminal = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: parent.id,
    role: "assistant",
    parentID: user.id,
    rootID: user.id,
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
  await Session.update(parent.id, (draft) => {
    draft.workflow = { kind: "lightloop", instructions: "Finish the task" }
  })
  return { parent, terminalMessageID: terminal.id }
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

    test("does not recover a terminal Light Loop retained for plugin lifecycle delivery", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.workflow = {
              kind: "lightloop",
              instructions: "Plugin-owned task",
              status: "completed",
              pluginOwner: {
                pluginId: "test-plugin",
                pluginGeneration: "generation-one",
                scopeId: tmp.path,
              },
            }
          })

          expect(await SessionWorking.resolve(session.id)).toBeUndefined()
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

    test("ignores persisted workflow state without runtime work", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          // A stored `active` loop is a record of intent, not evidence that a
          // turn is running. Projecting it as work is what let a dead process
          // pin a session in a state no control could clear.
          await Session.update(session.id, (draft) => {
            draft.workflow = { kind: "lightloop", instructions: "Persisted intent" }
          })

          const result = await SessionWorking.resolve(session.id)
          expect(result).toBeUndefined()
        },
      })
    })

    test("resolves paused from the persisted latch, not from message state", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await Session.update(session.id, (draft) => {
            draft.paused = { reason: "interrupted", description: "Runtime restarted", since: 123 }
          })

          // The latch is the whole source: a session with a perfectly finished
          // transcript still reports paused while the user has not continued.
          expect(await SessionWorking.resolve(session.id)).toEqual({
            status: "paused",
            reason: "interrupted",
            description: "Runtime restarted",
            since: 123,
          })
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

    test("does not infer work from an assistant message that never completed", async () => {
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

          // An unfinished turn is evidence for startup reconciliation, which
          // converts it into a latch the user can act on. It is deliberately
          // *not* a runtime status: inferring one here is what a dead process
          // could pin forever, and what no abort control could clear.
          expect(await SessionWorking.resolve(session.id)).toBeUndefined()
        },
      })
    })

    test("does not infer work from an assistant whose finish is non-terminal", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const rootID = Identifier.ascending("message")
          const root = (await Session.updateMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID,
          })) as MessageV2.User
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: root.id,
            rootID: root.id,
            time: { created: Date.now() - 1, completed: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: new MessageV2.APIError({ message: "provider failed", isRetryable: false }).toObject(),
          })

          // A completed message with no terminal `finish` stays resumable, so
          // it must not be projected as an ongoing status either.
          expect(await SessionWorking.resolve(session.id)).toBeUndefined()
        },
      })
    })
    test("reports the latch instead of the newest assistant message", async () => {
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
          // A terminal assistant, followed by a newer non-terminal one. The old
          // resolver picked the newest by creation time to decide it was
          // interrupted; the latch is now the only thing that decides.
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
            id: Identifier.ascending("message"),
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

          expect(await SessionWorking.resolve(session.id)).toBeUndefined()

          // The same transcript with a latch reports paused, which is what
          // makes the two assertions together prove the latch is the source.
          await Session.update(session.id, (draft) => {
            draft.paused = { reason: "aborted", since: 456 }
          })
          expect(await SessionWorking.resolve(session.id)).toEqual({
            status: "paused",
            reason: "aborted",
            since: 456,
          })
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

    test("converts paused WorkingInfo to StatusInfo", () => {
      const result = SessionWorking.toStatus({
        status: "paused",
        reason: "failed",
        description: "provider failed",
        since: 42,
      })
      expect(result).toEqual({ type: "paused", reason: "failed", description: "provider failed", since: 42 })
    })
  })

  describe("repairAfterAbort()", () => {
    test("leaves an interrupted turn resumable and latches the pause", async () => {
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

          const statuses: Array<{ type: string }> = []
          const unsubscribeStatus = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })
          const repaired = await SessionInvoke.repairAfterAbort(session.id)
          unsubscribeStatus()

          // With no orphaned tool part there is nothing to settle, and the
          // report says so rather than claiming a repair that did not happen.
          expect(repaired).toBe(false)

          // The session reports the stop the user can act on, never a work
          // state that nothing can clear.
          expect(statuses).toHaveLength(1)
          expect(statuses[0]).toMatchObject({ type: "paused", reason: "aborted" })

          const latch = await SessionLifecycle.snapshot(session.id)
          expect(latch?.reason).toBe("aborted")

          // The breakpoint survives on purpose: `session.continue` resumes from
          // exactly here, so terminalizing the message would turn Continue into
          // a silent no-op.
          const msgs = await Session.messages({ sessionID: session.id })
          const assistantInfo = msgs.find((m) => m.info.id === assistantID)?.info as MessageV2.Assistant
          assertExists(assistantInfo)
          expect(SessionProgress.isTerminalAssistant(assistantInfo)).toBe(false)
          expect(assistantInfo.time.completed).toBeUndefined()
          expect(assistantInfo.finish).toBeUndefined()
        },
      })
    })

    test("canonicalizes a completed structured error without replacing its durable details", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const rootID = Identifier.ascending("message")
          const root = await Session.updateMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID,
          })
          const assistantID = Identifier.ascending("message")
          const completedAt = Date.now() - 1_000
          const error = new MessageV2.APIError({
            message: "Provider failed after the turn started",
            statusCode: 503,
            isRetryable: false,
            metadata: { requestID: "req_test" },
          }).toObject()
          await Session.updateMessage({
            id: assistantID,
            sessionID: session.id,
            role: "assistant",
            parentID: root.id,
            rootID: root.id,
            time: { created: completedAt - 1_000, completed: completedAt },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: tmp.path, root: tmp.path },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
            error,
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
            expect(await SessionInvoke.repairAfterAbort(session.id, { terminalize: true })).toBe(true)
            expect(await SessionInvoke.repairAfterAbort(session.id, { terminalize: true })).toBe(false)
          } finally {
            unsubscribeStatus()
            unsubscribeIdle()
          }

          const messages = await Session.messages({ sessionID: session.id })
          expect(messages).toHaveLength(2)
          const assistant = messages.find((message) => message.info.id === assistantID)?.info
          assertExists(assistant)
          expect(assistant.role).toBe("assistant")
          const repaired = assistant as MessageV2.Assistant
          expect(repaired.finish).toBe("error")
          expect(repaired.time.completed).toBe(completedAt)
          expect(repaired.error).toEqual(error)
          expect(repaired.tokens).toEqual({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })
          expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()
          // Both repairs republish the derived latch, and neither may claim the
          // session settled: an idle announcement would tell the client the
          // stopped turn is gone while it still waits for a continue.
          expect(statuses).toHaveLength(2)
          expect(statuses.every((status) => status.type === "paused")).toBe(true)
          expect(idleEvents).toBe(0)
        },
      })
    })

    test("attaches one aborted assistant to a pending root that has no assistant", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const completedRootID = Identifier.ascending("message")
          const completedRoot = (await Session.updateMessage({
            id: completedRootID,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() - 2_000 },
            isRoot: true,
            rootID: completedRootID,
          })) as MessageV2.User
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "assistant",
            parentID: completedRoot.id,
            rootID: completedRoot.id,
            time: { created: Date.now() - 1_500, completed: Date.now() - 1_000 },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: tmp.path, root: tmp.path },
            mode: "synergy",
            agent: "synergy",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })
          const rootID = Identifier.ascending("message")
          const root = (await Session.updateMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID,
          })) as MessageV2.User

          // Creating the aborted assistant is the `abandon` behavior, so it
          // takes an explicit terminalize request.
          const repairs = await Promise.all([
            SessionInvoke.repairAfterAbort(session.id, { terminalize: true }),
            SessionInvoke.repairAfterAbort(session.id, { terminalize: true }),
          ])
          expect(repairs.filter(Boolean)).toHaveLength(1)

          const messages = await Session.messages({ sessionID: session.id })
          const assistants = messages.filter(
            (message) => message.info.role === "assistant" && message.info.rootID === root.id,
          )
          expect(assistants).toHaveLength(1)
          const assistant = assistants[0]!.info as MessageV2.Assistant
          expect(assistant.parentID).toBe(root.id)
          expect(assistant.rootID).toBe(root.id)
          expect(assistant.agent).toBe(root.agent)
          expect(assistant.modelID).toBe(root.model.modelID)
          expect(assistant.providerID).toBe(root.model.providerID)
          expect(assistant.path).toEqual({ cwd: tmp.path, root: tmp.path })
          expect(assistant.finish).toBe("error")
          expect(assistant.error?.name).toBe("MessageAbortedError")
          expect(assistant.time.completed).toBeNumber()
          expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("aborted")
        },
      })
    })

    test("does not publish idle status while an active runtime is still stopping", async () => {
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

          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()
          const statuses: Array<{ type: string }> = []
          const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })

          try {
            // There is no message mutation and no orphaned part to settle, so
            // the repair reports nothing to repair. The invariant under test is
            // the published status: it must follow the live runtime rather than
            // announce an idle session that is still stopping.
            expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(false)
            expect(statuses).toEqual([{ type: "busy" }])
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
          const userMsg = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          const assistant = await Session.updateMessage({
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
          // The in-flight call a crash left behind. Settling it is what makes
          // the first repair do real work and the second one a no-op.
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            callID: "call_repeated_repair",
            tool: "bash",
            state: { status: "running", input: { command: "echo repeated" }, time: { start: Date.now() } },
          })

          const statuses: Array<{ type: string }> = []
          const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })

          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(true)
          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(false)
          unsubscribe()
          // Each repair republishes the derived latch. Neither may announce an
          // idle session, which would tell the client the stopped turn is gone
          // while it still waits for a continue.
          expect(statuses).toHaveLength(2)
          expect(statuses.every((status) => status.type === "paused")).toBe(true)
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

    test("does not rewrite an assistant that already completed", async () => {
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

          // Nothing to repair: the message already reached a normal end, so the
          // repair must leave it exactly as it is.
          expect(await SessionInvoke.repairAfterAbort(session.id)).toBe(false)
          const stored = (await Session.messages({ sessionID: session.id })).find(
            (message) => message.info.role === "assistant",
          )?.info as MessageV2.Assistant
          assertExists(stored)
          expect(stored.finish).toBe("stop")
          expect(stored.time.completed).toBeNumber()
          expect(stored.error).toBeUndefined()

          // The session reports the latch this stop wrote, never a work state
          // that nothing is driving.
          const result = await SessionWorking.resolve(session.id)
          expect(result).toMatchObject({ status: "paused" })
        },
      })
    })

    test("latches unfinished turns instead of repairing or driving them", async () => {
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

          const statuses: Array<{ type: string }> = []
          const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
          })
          const originalLoop = SessionInvoke.loop
          const driven: string[] = []
          ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
            driven.push(sessionID)
          })
          try {
            await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)
          } finally {
            ;(SessionInvoke.loop as any) = originalLoop
            unsubscribe()
          }

          // Startup records the stop and stops there. Resuming would restart
          // work the user never asked to continue, which is the whole point of
          // replacing "resume" with "reconcile".
          expect(driven).toEqual([])
          expect(SessionManager.isRunning(session.id)).toBe(false)
          // Reconciliation writes the latch directly, so it publishes nothing.
          expect(statuses).toEqual([])
          expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("interrupted")

          const messages = await Session.messages({ sessionID: session.id })
          const completedAssistant = messages.find((m) => m.info.id === completedAssistantID)?.info as
            | MessageV2.Assistant
            | undefined
          const interruptedAssistant = messages.find((m) => m.info.id === interruptedAssistantID)?.info as
            | MessageV2.Assistant
            | undefined
          assertExists(completedAssistant)
          assertExists(interruptedAssistant)
          expect(completedAssistant.finish).toBe("stop")
          expect(completedAssistant.error).toBeUndefined()
          // The interrupted turn stays non-terminal on purpose: that is the
          // breakpoint Continue resumes from, so terminalizing it here would
          // make the resume action a silent no-op.
          expect(interruptedAssistant.finish).toBeUndefined()
          expect(interruptedAssistant.time.completed).toBeUndefined()
          expect(SessionProgress.pendingReply(messages)).toBe(true)
        },
      })
    })

    test("isolates a session whose evidence cannot be read", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const corrupt = await Session.create({ id: Identifier.create("session", false, 1) })
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: corrupt.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          const brokenPart = {
            id: Identifier.ascending("part"),
            sessionID: corrupt.id,
            messageID: user.id,
            type: "attachment",
            mime: "application/octet-stream",
            url: "data:broken",
          }
          await Storage.write(
            StoragePath.messagePart(
              Identifier.asScopeID(corrupt.scope.id),
              Identifier.asSessionID(corrupt.id),
              Identifier.asMessageID(user.id),
              Identifier.asPartID(brokenPart.id),
            ),
            brokenPart,
          )

          const healthy = await Session.create({ id: Identifier.create("session", false, 2) })
          const healthyRootID = Identifier.ascending("message")
          const healthyRoot = await Session.updateMessage({
            id: healthyRootID,
            sessionID: healthy.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID: healthyRootID,
          })
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: healthy.id,
            role: "assistant",
            parentID: healthyRoot.id,
            time: { created: Date.now() },
            modelID: "test-model",
            providerID: "test-provider",
            path: { cwd: projectRoot, root: projectRoot },
            mode: "test",
            agent: "test",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

          // One unreadable session must not cost every later session its own
          // reconciliation.
          expect((await SessionLifecycle.snapshot(healthy.id))?.reason).toBe("interrupted")
          expect(await SessionLifecycle.snapshot(corrupt.id)).toBeUndefined()
        },
      })
    })

    test("reconciles interrupted Cortex delegation state after restart", async () => {
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

          const assistant = await Session.updateMessage({
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

          await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

          const refreshed = await Session.get(child.id)
          expect(refreshed.cortex?.status).toBe("interrupted")
          expect(refreshed.cortex?.completedAt).toBeNumber()
          // A Cortex delegation is a machine session in everything but its
          // interaction mode: its owning domain reconciles the outcome, so the
          // user-facing latch deliberately does not apply to it.
          expect(await SessionLifecycle.snapshot(child.id)).toBeUndefined()
          expect(await SessionWorking.resolve(child.id)).toBeUndefined()

          const messages = await Session.messages({ sessionID: child.id })
          const stored = messages.find((message) => message.info.id === assistant.id)?.info as
            | MessageV2.Assistant
            | undefined
          assertExists(stored)
          // Settlement is owned by the delegation's own status change, so the
          // transcript is left exactly as the crash left it.
          expect(stored.finish).toBeUndefined()
          expect(stored.time.completed).toBeUndefined()
        },
      })
    })

    test("delivers a Light Loop continuation after interrupting its last silent Cortex task", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { parent, terminalMessageID: parentMessageID } = await createTerminalLightLoopSession()
          const child = await Session.create({
            parentID: parent.id,
            cortex: {
              taskID: "cortex-interrupted-silent-light-loop-task",
              parentSessionID: parent.id,
              parentMessageID,
              description: "Silent delegated work",
              agent: "developer",
              visibility: "hidden",
              notifyParentOnComplete: false,
              startedAt: Date.now(),
              status: "running",
            },
          })
          const originalLoop = SessionInvoke.loop
          const parentWoke = Promise.withResolvers<void>()
          ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
            if (sessionID === parent.id) parentWoke.resolve()
          })

          try {
            await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

            expect((await Session.get(child.id)).cortex?.status).toBe("interrupted")
            const items = await SessionInbox.list(parent.id)
            expect(items.some((item) => item.message?.metadata?.source === "light_loop_continuation")).toBe(true)
            // A silent child reports through the Light Loop continuation, never
            // as a user-visible Cortex notification.
            expect(items.some((item) => item.source.type === "cortex")).toBe(false)
            await Promise.race([
              parentWoke.promise,
              Bun.sleep(1_000).then(() => {
                throw new Error("Parent session was not woken after silent Cortex recovery")
              }),
            ])
          } finally {
            ;(SessionInvoke.loop as any) = originalLoop
            SessionManager.unregisterRuntime(parent.id)
          }
        },
      })
    })

    test("delivers a Light Loop continuation when its last silent Cortex task was already terminal", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { parent, terminalMessageID: parentMessageID } = await createTerminalLightLoopSession()
          const completedAt = Date.now()
          const child = await Session.create({
            parentID: parent.id,
            cortex: {
              taskID: "cortex-terminal-silent-light-loop-task",
              parentSessionID: parent.id,
              parentMessageID,
              description: "Terminal silent delegated work",
              agent: "developer",
              visibility: "hidden",
              notifyParentOnComplete: false,
              startedAt: completedAt - 1_000,
              completedAt,
              status: "completed",
            },
          })
          Cortex.reset()
          const originalLoop = SessionInvoke.loop
          const parentWoke = Promise.withResolvers<void>()
          ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
            if (sessionID === parent.id) parentWoke.resolve()
          })

          try {
            await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

            const firstItems = await SessionInbox.list(parent.id)
            expect(
              firstItems.filter((item) => item.message?.metadata?.source === "light_loop_continuation"),
            ).toHaveLength(1)
            expect(firstItems.some((item) => item.source.type === "cortex")).toBe(false)
            const deliveredAt = (await Session.get(child.id)).cortex?.deliveryNotifiedAt
            expect(deliveredAt).toBeNumber()
            await Promise.race([
              parentWoke.promise,
              Bun.sleep(1_000).then(() => {
                throw new Error("Parent session was not woken after terminal silent Cortex recovery")
              }),
            ])

            await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

            // Idempotent: a repeat pass neither duplicates the continuation nor
            // re-stamps delivery.
            const secondItems = await SessionInbox.list(parent.id)
            expect(
              secondItems.filter((item) => item.message?.metadata?.source === "light_loop_continuation"),
            ).toHaveLength(1)
            expect((await Session.get(child.id)).cortex?.deliveryNotifiedAt).toBe(deliveredAt)
          } finally {
            ;(SessionInvoke.loop as any) = originalLoop
            SessionManager.unregisterRuntime(parent.id)
          }
        },
      })
    })

    test("marks an interrupted Light Loop reviewer and leaves its stop intent bound", async () => {
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
          await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)
          const childSession = await Session.get(child.id)
          const parentSession = await Session.get(parent.id)
          const workflow = parentSession.workflow
          expect(childSession.cortex?.status).toBe("interrupted")
          expect(workflow?.kind).toBe("lightloop")
          // The reviewer is recorded as interrupted and its stop intent is left
          // exactly as the crash left it. Unbinding the reviewer so the review
          // re-drives automatically is part of the retired auto-recovery path;
          // deciding what to do with a stalled review is now the user's.
          if (workflow?.kind === "lightloop") {
            expect(workflow.stopRequest?.reviewTaskID).toBe(child.cortex?.taskID)
            expect(workflow.stopRequest?.reviewSessionID).toBe(child.id)
          }
        },
      })
    })

    test("restores an undelivered terminal Cortex notification exactly once", async () => {
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

          await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

          const firstItems = await SessionInbox.list(parent.id)
          expect(firstItems).toHaveLength(1)
          expect(firstItems[0].deliveryKey).toBe(`cortex:taskNotification:${taskID}`)
          expect(firstItems[0].source.type).toBe("cortex")
          const delivered = await Session.get(child.id)
          expect(delivered.cortex?.deliveryNotifiedAt).toBeNumber()
          const deliveredAt = delivered.cortex?.deliveryNotifiedAt

          await SessionInvoke.reconcilePausedSessions(ScopeContext.current.scope.id)

          expect(await SessionInbox.list(parent.id)).toHaveLength(1)
          expect((await Session.get(child.id)).cortex?.deliveryNotifiedAt).toBe(deliveredAt)
        },
      })
    })
  })
})
