import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { AgendaStore } from "../../src/agenda/store"
import { Identifier } from "../../src/id/id"
import { Cortex } from "../../src/cortex"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { LoopStopTool } from "../../src/tool/loop-stop"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

let originalGet: typeof Session.get
let originalUpdate: typeof Session.update
let originalLaunch: typeof Cortex.launch
let originalCancel: typeof Cortex.cancel

beforeEach(() => {
  originalGet = Session.get
  originalUpdate = Session.update
  originalLaunch = Cortex.launch
  originalCancel = Cortex.cancel
})

afterEach(() => {
  ;(Session.get as any) = originalGet
  ;(Session.update as any) = originalUpdate
  ;(Cortex.launch as any) = originalLaunch
  ;(Cortex.cancel as any) = originalCancel
})

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function sessionWithLightLoop(active: boolean, taskDescription = "Test task") {
  return {
    id: "ses_test_loop",
    workflow: active ? { kind: "lightloop" as const, taskDescription } : { kind: "plan" as const },
  } as unknown as Session.Info
}

function sessionWithoutLightLoop() {
  return {
    id: "ses_test_no_loop",
  } as unknown as Session.Info
}

describe("loop_stop", () => {
  test("returns idempotent result when a review is already pending (proves stop request was recorded)", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        ;(session as any).workflow.stopRequest = {
          summary: "done",
          requestedAt: Date.now(),
          requesterSessionID: "ses_test_loop",
          requesterMessageID: "msg_123",
          reviewTaskID: "ctx_existing",
          reviewSessionID: "ses_existing",
        }
        ;(Session.get as any) = mock(async () => session)
        ;(Session.update as any) = mock(async () => {})

        const tool = await LoopStopTool.init()
        const result = await tool.execute({ summary: "done again" }, ctx("ses_test_loop"))

        expect(result.title).toBe("Light Loop review already requested")
        expect(result.metadata.loopStopRequested).toBe(true)
        expect(result.metadata.reviewSessionID).toBe("ses_existing")
        // Workflow is NOT cleared by idempotent return
        expect(session.workflow?.kind).toBe("lightloop")
      },
    })
  })

  test("records stop request with reviewer IDs in a single atomic write after successful launch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        const updateCalls: Array<{ stopRequest: any }> = []
        ;(Session.get as any) = mock(async () => session)
        ;(Session.update as any) = mock(async (_sid: string, fn: (draft: any) => void) => {
          fn(session)
          updateCalls.push({ stopRequest: (session.workflow as any)?.stopRequest })
        })
        ;(Cortex.launch as any) = mock(async () => ({ id: "ctx_new", sessionID: "ses_reviewer_new" }))

        const tool = await LoopStopTool.init()
        const result = await tool.execute({ summary: "all done" }, ctx("ses_test_loop"))

        expect(result.title).toBe("Light Loop review requested")
        expect(result.metadata.reviewTaskID).toBe("ctx_new")
        expect(result.metadata.reviewSessionID).toBe("ses_reviewer_new")
        // Single atomic write: stopRequest + reviewSessionID + reviewTaskID all together
        expect(updateCalls).toHaveLength(1)
        const stopReq = updateCalls[0]!.stopRequest
        expect(stopReq.summary).toBe("all done")
        expect(stopReq.reviewTaskID).toBe("ctx_new")
        expect(stopReq.reviewSessionID).toBe("ses_reviewer_new")
        expect(stopReq.requesterSessionID).toBe("ses_test_loop")
      },
    })
  })

  test("cancels launched reviewer when the single atomic session update fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        const cancelled: string[] = []
        ;(Session.get as any) = mock(async () => session)
        ;(Session.update as any) = mock(async (_sid: string, _fn: (draft: any) => void) => {
          throw new Error("persist failed")
        })
        ;(Cortex.launch as any) = mock(async () => ({ id: "ctx_launched", sessionID: "ses_reviewer_launched" }))
        ;(Cortex.cancel as any) = mock(async (taskID: string) => {
          cancelled.push(taskID)
        })

        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: "done" }, ctx("ses_test_loop"))).rejects.toThrow("persist failed")

        expect(cancelled).toEqual(["ctx_launched"])
        // stopRequest was never written because persist failed
        expect((session.workflow as any).stopRequest).toBeUndefined()
      },
    })
  })

  test("does not persist stop request when reviewer launch fails (launch happens first)", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        const updateFn = mock(async () => {})
        ;(Session.get as any) = mock(async () => session)
        ;(Session.update as any) = updateFn
        ;(Cortex.launch as any) = mock(async () => {
          throw new Error("reviewer launch failed")
        })

        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: "done" }, ctx("ses_test_loop"))).rejects.toThrow("reviewer launch failed")

        // Session.update was never called — stopRequest was never written
        expect(updateFn).not.toHaveBeenCalled()
        expect((session.workflow as any).stopRequest).toBeUndefined()
      },
    })
  })

  test("throws when summary is empty", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        ;(Session.get as any) = mock(async () => session)
        ;(Session.update as any) = mock(async () => {})

        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: "   " }, ctx("ses_test_loop"))).rejects.toThrow("summary is required")
      },
    })
  })

  test("throws when session has no Light Loop workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithoutLightLoop()
        ;(Session.get as any) = mock(async () => session)

        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: "done" }, ctx("ses_test_no_loop"))).rejects.toThrow(
          "No active Light Loop workflow on this session",
        )
      },
    })
  })

  test("throws when another workflow is active", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(false)
        ;(Session.get as any) = mock(async () => session)

        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: "done" }, ctx("ses_test_loop"))).rejects.toThrow(
          "No active Light Loop workflow on this session",
        )
      },
    })
  })
  test("rejects review while an Agenda item can still wake the Light Loop session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = sessionWithLightLoop(true)
        const agenda = await AgendaStore.create({
          title: "Experiment progress",
          prompt: "Check the experiment",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        ;(Session.get as any) = mock(async () => session)
        const launch = mock(async () => ({ id: "ctx_unexpected", sessionID: "ses_unexpected" }))
        ;(Cortex.launch as any) = launch

        const tool = await LoopStopTool.init()
        await expect(tool.execute({ summary: "done" }, ctx(session.id))).rejects.toThrow(
          `agenda_cancel(id="${agenda.id}")`,
        )
        expect(launch).not.toHaveBeenCalled()
      },
    })
  })
})
