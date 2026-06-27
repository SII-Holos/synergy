import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { BlueprintLoopStore } from "../../src/blueprint"
import { Cortex } from "../../src/cortex"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { BlueprintLoopFinishTool } from "../../src/tool/blueprint-loop-finish"
import { BlueprintLoopRestartTool } from "../../src/tool/blueprint-loop-restart"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

let originalLaunch: typeof Cortex.launch
let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalLaunch = Cortex.launch
  originalDeliver = SessionManager.deliver
})

afterEach(() => {
  ;(Cortex.launch as any) = originalLaunch
  ;(SessionManager.deliver as any) = originalDeliver
})

function ctx(sessionID: string, agent: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

async function createRunningLoop(input?: { auditAgent?: string }) {
  const session = await Session.create({})
  const loop = await BlueprintLoopStore.create({
    noteID: "note_blueprint",
    title: "Test Blueprint",
    sessionID: session.id,
    auditAgent: input?.auditAgent,
  })
  const running = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
  await Session.update(session.id, (draft) => {
    draft.blueprint = { loopID: loop.id }
  })
  return { session, loop: running }
}

describe("BlueprintLoop tools", () => {
  test("launches configured audit agent without automatic Cortex parent notification", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop({ auditAgent: "security-reviewer" })
        const launches: Parameters<typeof Cortex.launch>[0][] = []
        ;(Cortex.launch as any) = mock(async (input: Parameters<typeof Cortex.launch>[0]) => {
          const auditSession = await Session.create({})
          launches.push(input)
          return {
            id: Identifier.short("cortex"),
            sessionID: auditSession.id,
            parentSessionID: input.parentSessionID,
            parentMessageID: input.parentMessageID,
            description: input.description,
            prompt: input.prompt,
            agent: input.agent,
            executionRole: input.executionRole,
            category: input.category,
            status: "running",
            startedAt: Date.now(),
            notifyParentOnComplete: input.notifyParentOnComplete,
          }
        })

        const tool = await BlueprintLoopFinishTool.init()
        await tool.execute({ loopID: loop.id, status: "auditing" }, ctx(session.id, "synergy"))

        expect(launches).toHaveLength(1)
        expect(launches[0].agent).toBe("security-reviewer")
        expect(launches[0].parentSessionID).toBe(session.id)
        expect(launches[0].notifyParentOnComplete).toBe(false)
        expect(launches[0].prompt).toContain("execution evidence")
        expect(launches[0].prompt).not.toContain("implementation evidence")
        expect(launches[0].prompt).toContain("blueprint_loop_restart")
        expect(launches[0].prompt).toContain("blueprint_loop_finish")

        const updated = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(updated.auditSessionID).toBeDefined()
        const auditSession = await Session.get(updated.auditSessionID!)
        expect(auditSession.blueprint?.loopID).toBe(loop.id)
        expect(auditSession.blueprint?.loopRole).toBe("audit")
      },
    })
  })

  test("restart wakes the execution session with user mail", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop()
        const auditSession = await Session.create({})
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "auditing",
          auditSessionID: auditSession.id,
        })
        await Session.update(auditSession.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "audit" }
        })
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const tool = await BlueprintLoopRestartTool.init()
        await tool.execute(
          {
            loopID: loop.id,
            reason: "Missing tests",
            completed: "Implementation exists",
            remaining: "Add test coverage",
            instructions: "Write the missing tests",
          },
          ctx(auditSession.id, "security-reviewer"),
        )

        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].target).toBe(session.id)
        const mail = deliveries[0].mail
        expect(mail.type).toBe("user")
        if (mail.type !== "user") throw new Error("expected user mail")
        expect(mail.summary?.title).toBe("Blueprint audit requested changes")
        expect(mail.metadata?.source).toBe("blueprint_loop_restart")
        expect(mail.metadata?.sourceSessionID).toBe(auditSession.id)
        expect(mail.metadata?.loopID).toBe(loop.id)
        expect(mail.metadata?.noteID).toBe(loop.noteID)
        expect(mail.metadata?.title).toBe(loop.title)
        expect(mail.metadata?.reason).toBe("Missing tests")
        expect(mail.metadata?.remaining).toBe("Add test coverage")
        expect(mail.metadata?.mailbox).toBeUndefined()
        expect(mail.parts[0].type).toBe("text")

        const restarted = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(restarted.auditSessionID).toBeUndefined()
        const clearedAuditSession = await Session.get(auditSession.id)
        expect(clearedAuditSession.blueprint?.loopID).toBeUndefined()
      },
    })
  })
})
