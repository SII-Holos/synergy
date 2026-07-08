import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { SessionManager } from "../../src/session/manager"
import { LightLoopApproveTool } from "../../src/tool/light-loop-approve"
import { LightLoopRejectTool } from "../../src/tool/light-loop-reject"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

let originalGet: typeof Session.get
let originalUpdate: typeof Session.update
let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalGet = Session.get
  originalUpdate = Session.update
  originalDeliver = SessionManager.deliver
})

afterEach(() => {
  ;(Session.get as any) = originalGet
  ;(Session.update as any) = originalUpdate
  ;(SessionManager.deliver as any) = originalDeliver
})

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: "lightloop-reviewer",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function lightLoopSession(
  opts: {
    taskDescription?: string
    stopRequest?: any
    review?: any
  } = {},
): Session.Info {
  return {
    id: "ses_exec",
    workflow: {
      kind: "lightloop" as const,
      taskDescription: opts.taskDescription ?? "Build the thing",
      ...(opts.stopRequest ? { stopRequest: opts.stopRequest } : {}),
      ...(opts.review ? { review: opts.review } : {}),
    },
  } as unknown as Session.Info
}

function reviewerSession(id = "ses_reviewer", parentSessionID = "ses_exec"): Session.Info {
  return {
    id,
    cortex: {
      parentSessionID,
      parentMessageID: "msg_1",
      description: "Review LightLoop",
      agent: "lightloop-reviewer",
      executionRole: "delegated_subagent",
      startedAt: Date.now(),
      status: "running",
    },
  } as unknown as Session.Info
}

function mockSessions(target: Session.Info, reviewers: Session.Info[] = [reviewerSession()]) {
  const sessions = new Map<string, Session.Info>([[target.id, target]])
  for (const reviewer of reviewers) sessions.set(reviewer.id, reviewer)
  ;(Session.get as any) = mock(async (sessionID: string) => sessions.get(sessionID))
}

describe("light_loop_approve", () => {
  test("clears LightLoop workflow when called from the recorded review session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession({
          stopRequest: {
            summary: "all done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_exec",
            requesterMessageID: "msg_1",
            reviewSessionID: "ses_reviewer",
            reviewTaskID: "ctx_1",
          },
        })

        let workflowCleared = false
        mockSessions(session)
        ;(Session.update as any) = mock(async (_sid: string, fn: (draft: any) => void) => {
          fn(session)
          if (session.workflow === undefined) workflowCleared = true
        })
        const deliveries: any[] = []
        ;(SessionManager.deliver as any) = mock(async (input: any) => {
          deliveries.push(input)
        })

        const tool = await LightLoopApproveTool.init()
        const result = await tool.execute(
          { sessionID: "ses_exec", summary: "Approved: looks good" },
          ctx("ses_reviewer"),
        )

        expect(result.metadata.loopApproved).toBe(true)
        expect(workflowCleared).toBe(true)
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].mail.metadata).toMatchObject({
          source: "light_loop_approved",
          sourceSessionID: "ses_reviewer",
        })
        const part = deliveries[0].mail.parts[0]
        expect(part.origin).toBe("system")
        expect("synthetic" in part).toBe(false)
      },
    })
  })

  test("throws when called from the execution session (not the reviewer)", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession({
          stopRequest: {
            summary: "all done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_exec",
            requesterMessageID: "msg_1",
            reviewSessionID: "ses_reviewer",
            reviewTaskID: "ctx_1",
          },
        })

        mockSessions(session)

        const tool = await LightLoopApproveTool.init()
        await expect(tool.execute({ sessionID: "ses_exec", summary: "approved" }, ctx("ses_exec"))).rejects.toThrow(
          "Only the recorded reviewer session may approve this stop request",
        )
      },
    })
  })

  test("throws when there is no pending stop request", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession()
        mockSessions(session)

        const tool = await LightLoopApproveTool.init()
        await expect(tool.execute({ sessionID: "ses_exec", summary: "approved" }, ctx("ses_reviewer"))).rejects.toThrow(
          "has no pending stop request",
        )
      },
    })
  })

  test("rejects calls from unrelated sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession({
          stopRequest: {
            summary: "all done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_exec",
            requesterMessageID: "msg_1",
            reviewSessionID: "ses_reviewer",
            reviewTaskID: "ctx_1",
          },
        })

        mockSessions(session)

        const tool = await LightLoopApproveTool.init()
        await expect(
          tool.execute({ sessionID: "ses_exec", summary: "approved" }, ctx("ses_unrelated")),
        ).rejects.toThrow("Only the recorded reviewer session may approve this stop request")
      },
    })
  })
})

describe("light_loop_reject", () => {
  test("clears stopRequest, increments attempts, preserves taskDescription, and delivers control message", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession({
          stopRequest: {
            summary: "all done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_exec",
            requesterMessageID: "msg_1",
            reviewSessionID: "ses_reviewer",
            reviewTaskID: "ctx_1",
          },
          review: { attempts: 2 },
        })

        const deliveries: any[] = []
        mockSessions(session)
        ;(Session.update as any) = mock(async (_sid: string, fn: (draft: any) => void) => {
          fn(session)
        })
        ;(SessionManager.deliver as any) = mock(async (input: any) => {
          deliveries.push(input)
        })

        const tool = await LightLoopRejectTool.init()
        const result = await tool.execute(
          {
            sessionID: "ses_exec",
            reason: "tests missing",
            remaining: "- Add tests (BLOCKING)",
            instructions: "Write unit tests for the new module",
          },
          ctx("ses_reviewer"),
        )

        expect(result.metadata.loopRejected).toBe(true)
        expect(result.metadata.attempts).toBe(3)
        expect((session.workflow as any)?.stopRequest).toBeUndefined()
        expect((session.workflow as any)?.review?.attempts).toBe(3)
        expect((session.workflow as any)?.review?.lastReason).toBe("tests missing")
        expect((session.workflow as any)?.taskDescription).toBe("Build the thing")
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].mail.metadata.source).toBe("light_loop_rejected")
        expect(deliveries[0].mail.metadata.sourceSessionID).toBe("ses_reviewer")
        const part = deliveries[0].mail.parts[0]
        expect(part.origin).toBe("system")
        expect("synthetic" in part).toBe(false)
      },
    })
  })

  test("throws when called from the execution session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession({
          stopRequest: {
            summary: "all done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_exec",
            requesterMessageID: "msg_1",
            reviewSessionID: "ses_reviewer",
            reviewTaskID: "ctx_1",
          },
        })

        mockSessions(session)

        const tool = await LightLoopRejectTool.init()
        await expect(
          tool.execute(
            { sessionID: "ses_exec", reason: "nope", remaining: "- x", instructions: "do x" },
            ctx("ses_exec"),
          ),
        ).rejects.toThrow("Only the recorded reviewer session may reject this stop request")
      },
    })
  })

  test("requires non-empty reason, remaining, and instructions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession({
          stopRequest: {
            summary: "all done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_exec",
            requesterMessageID: "msg_1",
            reviewSessionID: "ses_reviewer",
            reviewTaskID: "ctx_1",
          },
        })

        mockSessions(session)

        const tool = await LightLoopRejectTool.init()

        await expect(
          tool.execute(
            { sessionID: "ses_exec", reason: "   ", remaining: "- x", instructions: "do x" },
            ctx("ses_reviewer"),
          ),
        ).rejects.toThrow("reason is required")

        await expect(
          tool.execute(
            { sessionID: "ses_exec", reason: "nope", remaining: "   ", instructions: "do x" },
            ctx("ses_reviewer"),
          ),
        ).rejects.toThrow("remaining is required")

        await expect(
          tool.execute(
            { sessionID: "ses_exec", reason: "nope", remaining: "- x", instructions: "   " },
            ctx("ses_reviewer"),
          ),
        ).rejects.toThrow("instructions is required")
      },
    })
  })

  test("throws when there is no pending stop request", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = lightLoopSession()
        mockSessions(session)

        const tool = await LightLoopRejectTool.init()
        await expect(
          tool.execute(
            { sessionID: "ses_exec", reason: "nope", remaining: "- x", instructions: "do x" },
            ctx("ses_reviewer"),
          ),
        ).rejects.toThrow("has no pending stop request")
      },
    })
  })
})
