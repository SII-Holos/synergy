import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { BlueprintLoopStore } from "../../src/blueprint"
import { Cortex } from "../../src/cortex/manager"
import { Identifier } from "../../src/id/id"
import { BlueprintContinuation, BlueprintContinuationPolicy } from "../../src/session/blueprint-continuation"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionInbox } from "../../src/session/inbox"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "test-provider", modelID: "test-model" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

let originalDeliver: typeof SessionManager.deliver
let originalGetTasksForSession: typeof Cortex.getTasksForSession
let originalPrepare: unknown
let originalStart: unknown

beforeEach(() => {
  originalDeliver = SessionManager.deliver
  originalGetTasksForSession = Cortex.getTasksForSession
  originalPrepare = (Cortex as any).prepare
  originalStart = (Cortex as any).start
  ;(Cortex.getTasksForSession as any) = mock(() => [])
})

afterEach(() => {
  ;(SessionManager.deliver as any) = originalDeliver
  ;(Cortex.getTasksForSession as any) = originalGetTasksForSession
  ;(Cortex as any).prepare = originalPrepare
  ;(Cortex as any).start = originalStart
})

async function setupLoop(status: "running" | "auditing" | "completed" = "running") {
  const session = await Session.create({})
  const loop = await BlueprintLoopStore.create({
    noteID: "note_blueprint",
    title: "Test Blueprint",
    sessionID: session.id,
  })
  await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
  if (status !== "running") {
    await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status })
  }
  await Session.update(session.id, (draft) => {
    draft.blueprint = { loopID: loop.id }
  })
  return { session, loop }
}

async function writeUser(sessionID: string, metadata?: Record<string, unknown>) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: "synergy",
    model,
    metadata,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: user.id,
    type: "text",
    text: "Implement the blueprint",
  })
  return user as MessageV2.User
}

async function writeAssistant(
  sessionID: string,
  parentID: string,
  input?: { finish?: string; error?: MessageV2.Assistant["error"] },
) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    parentID,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens,
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: input?.finish ?? "stop",
    error: input?.error,
  })
}

describe("BlueprintContinuation", () => {
  test("sends continuation when a running loop goes idle after a terminal assistant response", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await setupLoop()
        const user = await writeUser(session.id)
        await writeAssistant(session.id, user.id)

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(true)
        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        const item = items[0]
        expect(item.mode).toBe("steer")
        expect(item.deliveryKey).toContain("continuation:blueprint_loop:")
        expect(item.message?.summary?.title).toBe(`Continue ${loop.title} blueprint`)
        expect(item.message?.metadata?.source).toBe("blueprint_loop_continuation")
        expect(item.message?.metadata?.loopID).toBe(loop.id)
        expect(item.message?.metadata?.noteID).toBe(loop.noteID)
        expect(item.message?.metadata?.title).toBe(loop.title)
        expect(item.message?.metadata?.status).toBe("running")
        expect(item.message?.origin?.type).toBe("blueprint")
        const part = item.message?.parts[0] as MessageV2.TextPart
        expect(part.synthetic).toBe(true)
        expect(part.text).toContain(`BlueprintLoop ${loop.id} status is \`running\``)
        expect(part.text).toContain("current delivered state")
        expect(part.text).not.toContain("implementation state")
        expect(part.text).not.toContain("implementation work")
        expect(part.text).toContain("blueprint_loop_stop")
        expect(part.text).not.toContain('status: "failed"')
      },
    })
  })

  test("prepares, binds, and starts the audit reviewer for a pending stop intent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await setupLoop()
        const scopeID = ScopeContext.current.scope.id
        await (BlueprintLoopStore as any).recordStopRequest(scopeID, loop.id, {
          summary: "Blueprint complete",
          completed: ["Implemented the requested behavior"],
          evidence: ["Focused tests pass"],
          requestedAt: Date.now(),
          requesterSessionID: session.id,
          requesterMessageID: "msg_stop",
        })
        const order: string[] = []
        let reviewSessionID = ""
        ;(Cortex as any).prepare = mock(async (input: any) => {
          order.push("prepare")
          expect(input.agent).toBe("supervisor")
          expect(input.parentSessionID).toBe(session.id)
          expect(input.parentMessageID).toBe("msg_stop")
          expect(input.visibility).toBe("visible")
          expect(input.notifyParentOnComplete).toBe(false)
          expect(input.prompt).toContain("Focused tests pass")
          const reviewSession = await Session.create({ parentID: session.id })
          reviewSessionID = reviewSession.id
          return { id: "ctx_audit", sessionID: reviewSession.id, status: "queued" }
        })
        ;(Cortex as any).start = mock(async (taskID: string) => {
          order.push("start")
          expect(taskID).toBe("ctx_audit")
          const boundLoop = await BlueprintLoopStore.get(scopeID, loop.id)
          const reviewSession = await Session.get(reviewSessionID)
          expect(boundLoop.status).toBe("auditing")
          expect(boundLoop.auditTaskID).toBe("ctx_audit")
          expect(boundLoop.auditSessionID).toBe(reviewSessionID)
          expect(reviewSession.blueprint).toEqual({ loopID: loop.id, loopRole: "audit" })
        })

        const refreshed = await Session.get(session.id)
        const proposal = await BlueprintContinuationPolicy.handle({
          session: refreshed,
          scopeID,
          sessionID: session.id,
          terminalMessageID: "msg_terminal",
        })

        expect(proposal).toEqual({ kind: "handled" })
        expect(order).toEqual(["prepare", "start"])
      },
    })
  })

  test.each(["running", "queued"] as const)("does not continue while a child task is %s", async (status) => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await setupLoop()
        const user = await writeUser(session.id)
        await writeAssistant(session.id, user.id)
        ;(Cortex.getTasksForSession as any) = mock(() => [{ status }])
        const deliver = mock(async () => {})
        ;(SessionManager.deliver as any) = deliver

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
      },
    })
  })

  test.each(["auditing", "completed"] as const)("does not continue when loop status is %s", async (status) => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await setupLoop(status)
        const user = await writeUser(session.id)
        await writeAssistant(session.id, user.id)
        const deliver = mock(async () => {})
        ;(SessionManager.deliver as any) = deliver

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
      },
    })
  })

  test("does not continue without a terminal assistant response", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await setupLoop()
        await writeUser(session.id)
        const deliver = mock(async () => {})
        ;(SessionManager.deliver as any) = deliver

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
      },
    })
  })

  test("does not continue after an assistant error", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await setupLoop()
        const user = await writeUser(session.id)
        await writeAssistant(session.id, user.id, {
          error: new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"],
        })
        const deliver = mock(async () => {})
        ;(SessionManager.deliver as any) = deliver

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
      },
    })
  })

  test("does not continue when the latest assistant response for the user errored", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await setupLoop()
        const user = await writeUser(session.id)
        await writeAssistant(session.id, user.id)
        await writeAssistant(session.id, user.id, {
          error: new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"],
        })
        const deliver = mock(async () => {})
        ;(SessionManager.deliver as any) = deliver

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
      },
    })
  })

  test("does not continue when the bound loop is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: Identifier.ascending("blueprint_loop") }
        })
        const user = await writeUser(session.id)
        await writeAssistant(session.id, user.id)
        const deliver = mock(async () => {})
        ;(SessionManager.deliver as any) = deliver

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
      },
    })
  })
})
