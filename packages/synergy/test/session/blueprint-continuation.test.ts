import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { BlueprintLoopStore } from "../../src/blueprint"
import { Cortex } from "../../src/cortex/manager"
import { Identifier } from "../../src/id/id"
import { BlueprintContinuation } from "../../src/session/blueprint-continuation"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "test-provider", modelID: "test-model" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

let originalDeliver: typeof SessionManager.deliver
let originalGetTasksForSession: typeof Cortex.getTasksForSession

beforeEach(() => {
  originalDeliver = SessionManager.deliver
  originalGetTasksForSession = Cortex.getTasksForSession
  ;(Cortex.getTasksForSession as any) = mock(() => [])
})

afterEach(() => {
  ;(SessionManager.deliver as any) = originalDeliver
  ;(Cortex.getTasksForSession as any) = originalGetTasksForSession
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

        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const delivered = await BlueprintContinuation.handleIdle(session.id)

        expect(delivered).toBe(true)
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].target).toBe(session.id)
        const mail = deliveries[0].mail
        expect(mail.type).toBe("user")
        if (mail.type !== "user") throw new Error("expected user mail")
        expect(mail.summary?.title).toBe(`Continue ${loop.title} blueprint`)
        expect(mail.metadata?.source).toBe("blueprint_loop_continuation")
        expect(mail.metadata?.loopID).toBe(loop.id)
        expect(mail.metadata?.noteID).toBe(loop.noteID)
        expect(mail.metadata?.title).toBe(loop.title)
        expect(mail.metadata?.status).toBe("running")
        expect(mail.metadata?.mailbox).toBeUndefined()
        expect(mail.metadata?.channelPush).toBeUndefined()
        const part = mail.parts[0] as MessageV2.TextPart
        expect(part.synthetic).toBe(true)
        expect(part.text).toContain(`BlueprintLoop ${loop.id} status is \`running\``)
        expect(part.text).toContain(`blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing"`)
        expect(part.text).toContain(`blueprint_loop_finish({ loopID: "${loop.id}", status: "failed"`)
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
