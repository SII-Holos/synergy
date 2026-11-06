import { expect, spyOn, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { LoopStopTool } from "../../src/light-loop/tools/loop-stop"
import { LightLoopTerminalStore } from "../../src/light-loop/terminal-hook"
import { LightLoopRuntime } from "../../src/light-loop/runtime"
import { WorkflowSessionService } from "../../src/session/workflow"
import { testRuntime } from "../support/runtime"

function context(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message_stop",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

test("Light Loop completes durably without a reviewer or Agenda", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        await WorkflowSessionService.startLightloop(session.id, "Complete the work")
        const tool = await LoopStopTool.init()
        const result = await tool.execute({ summary: "Verified the delivered behavior" }, context(session.id))
        expect(result.metadata.loopCompleted).toBe(true)
        expect((await Session.get(session.id)).workflow).toBeUndefined()
        expect(await LightLoopTerminalStore.get(session)).toMatchObject({
          status: "completed",
          instructions: "Complete the work",
          hookDeliveredAt: expect.any(Number),
        })
        expect(await Session.children(session.id)).toEqual([])
        expect(await Agent.get("lightloop-reviewer")).toBeUndefined()
        const terminal = await LightLoopTerminalStore.get(session)
        expect((await tool.execute({ summary: "Duplicate" }, context(session.id))).metadata.loopCompleted).toBe(true)
        expect(await LightLoopTerminalStore.get(session)).toEqual(terminal)
        await WorkflowSessionService.startLightloop(session.id, "A second task")
        await tool.execute({ summary: "Second task verified" }, context(session.id))
        expect(await LightLoopTerminalStore.get(session)).toMatchObject({
          status: "completed",
          instructions: "A second task",
        })
      },
    }),
  )
})

test("completion cannot overwrite cancellation or accept an empty summary", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        await WorkflowSessionService.startLightloop(session.id, "Preserve unfinished work")
        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: " " }, context(session.id))).rejects.toThrow()
        expect((await Session.get(session.id)).workflow?.kind).toBe("lightloop")
        await LightLoopRuntime.setTerminalStatus(session.id, "cancelled")
        await expect(tool.execute({ summary: "Late completion" }, context(session.id))).rejects.toThrow()
        expect((await LightLoopTerminalStore.get(session))?.status).toBe("cancelled")
      },
    }),
  )
})

test("terminal publication rolls back atomically and stale goals cannot complete revised work", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        const original = await WorkflowSessionService.startLightloop(session.id, "Original goal")
        {
          using failure = spyOn(Session, "update").mockImplementation(async () => {
            throw new Error("publication failed")
          })
          await expect(LightLoopRuntime.setTerminalStatus(session.id, "completed")).rejects.toThrow(
            "publication failed",
          )
        }
        expect(await LightLoopTerminalStore.get(session)).toBeUndefined()
        expect((await Session.get(session.id)).workflow).toEqual(original.workflow)
        await WorkflowSessionService.updateLightloopInstructions(session.id, "Revised goal")
        if (original.workflow?.kind !== "lightloop") throw new Error("missing workflow")
        await LightLoopRuntime.setTerminalStatus(session.id, "completed", undefined, original.workflow)
        expect(await LightLoopTerminalStore.get(session)).toBeUndefined()
        expect((await Session.get(session.id)).workflow).toMatchObject({ instructions: "Revised goal" })
        await Promise.all([
          LightLoopRuntime.setTerminalStatus(session.id, "cancelled"),
          LightLoopRuntime.setTerminalStatus(session.id, "completed"),
        ])
        expect((await LightLoopTerminalStore.get(session))?.status).toBe("cancelled")
      },
    }),
  )
})

test("a stale deadline cannot abort a revised run, while the current deadline cancels execution", async () => {
  const { SessionManager } = await import("@ericsanchezok/synergy-harness/session/manager")
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        await WorkflowSessionService.startLightloop(session.id, "Deadline-bound goal")
        const deadlineAt = Date.now() - 1
        await Session.update(session.id, (draft) => {
          if (draft.workflow?.kind === "lightloop") draft.workflow.deadlineAt = deadlineAt
        })
        const lease = SessionManager.acquire(session.id)!
        try {
          const distantDeadline = Date.now() + 30 * 24 * 60 * 60 * 1000
          await Session.update(session.id, (draft) => {
            if (draft.workflow?.kind === "lightloop") draft.workflow.deadlineAt = distantDeadline
          })
          LightLoopRuntime.scheduleDeadline(session.id, distantDeadline)
          await Bun.sleep(20)
          expect(lease.signal.aborted).toBe(false)
          expect(await LightLoopTerminalStore.get(session)).toBeUndefined()
          await Session.update(session.id, (draft) => {
            if (draft.workflow?.kind === "lightloop") draft.workflow.deadlineAt = deadlineAt
          })
          LightLoopRuntime.scheduleDeadline(session.id, deadlineAt - 1)
          await Bun.sleep(20)
          expect(lease.signal.aborted).toBe(false)
          expect(await LightLoopTerminalStore.get(session)).toBeUndefined()
          LightLoopRuntime.scheduleDeadline(session.id, deadlineAt)
          const until = Date.now() + 1000
          while (!(await LightLoopTerminalStore.get(session)) && Date.now() < until) await Bun.sleep(10)
          expect(lease.signal.aborted).toBe(true)
          expect((await LightLoopTerminalStore.get(session))?.status).toBe("timed_out")
        } finally {
          LightLoopRuntime.cancelDeadline(session.id)
          await SessionManager.release(lease, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    }),
  )
})
