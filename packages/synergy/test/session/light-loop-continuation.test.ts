import { afterEach, describe, expect, mock, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { Session } from "../../src/session"
import { LightLoopContinuationPolicy } from "../../src/session/light-loop-continuation"
import type { ContinuationKernel } from "../../src/session/continuation-kernel"
import type { Info as SessionInfo } from "../../src/session/types"

const originalPrepare = (Cortex as any).prepare
const originalStart = (Cortex as any).start
const originalUpdate = Session.update

afterEach(() => {
  ;(Cortex as any).prepare = originalPrepare
  ;(Cortex as any).start = originalStart
  ;(Session.update as any) = originalUpdate
})

function gate(session: Partial<SessionInfo>): ContinuationKernel.Gate {
  return {
    session: session as SessionInfo,
    scopeID: "scope_test",
    sessionID: session.id ?? "ses_test",
    terminalMessageID: "msg_terminal",
  }
}

describe("LightLoopContinuationPolicy", () => {
  test("proposes a system continuation when Light Loop is active", async () => {
    const proposal = await LightLoopContinuationPolicy.handle(
      gate({
        id: "ses_light_loop",
        workflow: { kind: "lightloop", taskDescription: "Write unit tests" },
      }),
    )

    if (!proposal || proposal.kind !== "inbox") throw new Error("expected inbox proposal")
    expect(proposal.kind).toBe("inbox")
    expect(proposal.mode).toBe("steer")
    expect(proposal.message.summary?.title).toBe("Continue light loop")
    expect(proposal.message.origin).toEqual({ type: "system" })
    expect(proposal.message.metadata?.source).toBe("light_loop_continuation")
    expect(proposal.message.parts).toHaveLength(1)
    const part = proposal.message.parts[0]
    expect(part.type).toBe("text")
    if (part.type !== "text") throw new Error("expected text part")
    expect(part.origin).toBe("system")
    expect(part.synthetic).toBeUndefined()
    expect(part.text).toContain("Task: Write unit tests")
    expect(part.text).toContain("loop_stop()")
  })

  test.each([
    { name: "another workflow", workflow: { kind: "plan" as const } },
    { name: "no workflow", workflow: undefined },
  ])("does not propose for $name", async ({ workflow }) => {
    expect(await LightLoopContinuationPolicy.handle(gate({ workflow }))).toBeUndefined()
  })

  test("does not propose while a completion review is pending", async () => {
    const proposal = await LightLoopContinuationPolicy.handle(
      gate({
        id: "ses_review_pending",
        workflow: {
          kind: "lightloop",
          taskDescription: "Write unit tests",
          stopRequest: {
            summary: "done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_review_pending",
            requesterMessageID: "msg_123",
            reviewSessionID: "ses_reviewer",
          },
        },
      }),
    )

    expect(proposal).toBeUndefined()
  })

  test("prepares, binds, and starts a reviewer for a pending stop intent", async () => {
    const order: string[] = []
    const session = {
      id: "ses_partial_review",
      workflow: {
        kind: "lightloop" as const,
        taskDescription: "Write unit tests",
        stopRequest: {
          summary: "done",
          completed: ["Implemented the behavior"],
          evidence: ["Focused tests pass"],
          requestedAt: Date.now(),
          requesterSessionID: "ses_partial_review",
          requesterMessageID: "msg_123",
        },
      },
    }
    ;(Cortex as any).prepare = mock(async (input: any) => {
      order.push("prepare")
      expect(input.parentSessionID).toBe(session.id)
      expect(input.parentMessageID).toBe("msg_123")
      expect(input.agent).toBe("lightloop-reviewer")
      expect(input.prompt).toContain("Focused tests pass")
      return { id: "ctx_review", sessionID: "ses_reviewer", status: "queued" }
    })
    ;(Session.update as any) = mock(async (_sessionID: string, fn: (draft: any) => void) => {
      order.push("bind")
      fn(session)
    })
    ;(Cortex as any).start = mock(async (taskID: string) => {
      order.push("start")
      expect(taskID).toBe("ctx_review")
      expect((session.workflow.stopRequest as any).reviewTaskID).toBe("ctx_review")
      expect((session.workflow.stopRequest as any).reviewSessionID).toBe("ses_reviewer")
    })

    const proposal = await LightLoopContinuationPolicy.handle(gate(session))

    expect(proposal).toEqual({ kind: "handled" })
    expect(order).toEqual(["prepare", "bind", "start"])
  })
})
