import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { LightLoopContinuationPolicy } from "../../src/session/light-loop-continuation"
import { SessionManager } from "../../src/session/manager"
import type { ContinuationKernel } from "../../src/session/continuation-kernel"
import type { Info as SessionInfo } from "../../src/session/types"

let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalDeliver = SessionManager.deliver
})

afterEach(() => {
  ;(SessionManager.deliver as any) = originalDeliver
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
  test("handle returns true and delivers continuation when Light Loop workflow is active", async () => {
    const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      deliveries.push(input)
    })

    const g = gate({
      id: "ses_light_loop",
      workflow: { kind: "lightloop", taskDescription: "Write unit tests" },
    })

    const handled = await LightLoopContinuationPolicy.handle(g)

    expect(handled).toBe(true)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].target).toBe("ses_light_loop")

    const mail = deliveries[0].mail
    expect(mail.type).toBe("user")
    if (mail.type !== "user") throw new Error("expected user mail")
    expect(mail.summary?.title).toBe("Continue light loop")
    expect(mail.metadata?.source).toBe("light_loop_continuation")
    expect(mail.parts).toHaveLength(1)
    expect(mail.parts[0].type).toBe("text")
    if (mail.parts[0].type === "text") {
      expect(mail.parts[0].origin).toBe("system")
      expect("synthetic" in mail.parts[0]).toBe(false)
      expect(mail.parts[0].text).toContain("Task: Write unit tests")
      expect(mail.parts[0].text).toContain("loop_stop()")
    }
  })

  test("handle returns false when another workflow is active", async () => {
    const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      deliveries.push(input)
    })

    const g = gate({
      id: "ses_not_active",
      workflow: { kind: "plan" },
    })

    const handled = await LightLoopContinuationPolicy.handle(g)

    expect(handled).toBe(false)
    expect(deliveries).toHaveLength(0)
  })

  test("handle returns false when no workflow is active", async () => {
    const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      deliveries.push(input)
    })

    const g = gate({
      id: "ses_no_loop",
    })

    const handled = await LightLoopContinuationPolicy.handle(g)

    expect(handled).toBe(false)
    expect(deliveries).toHaveLength(0)
  })

  test("handle returns false when a stop request is pending", async () => {
    const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      deliveries.push(input)
    })

    const g = gate({
      id: "ses_review_pending",
      workflow: {
        kind: "lightloop" as const,
        taskDescription: "Write unit tests",
        stopRequest: {
          summary: "done",
          requestedAt: Date.now(),
          requesterSessionID: "ses_review_pending",
          requesterMessageID: "msg_123",
          reviewSessionID: "ses_reviewer",
        },
      },
    })

    const handled = await LightLoopContinuationPolicy.handle(g)

    expect(handled).toBe(false)
    expect(deliveries).toHaveLength(0)
  })

  test("handle continues when stop request has no reviewer session (legacy or migration robustness)", async () => {
    const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      deliveries.push(input)
    })

    const g = gate({
      id: "ses_partial_review",
      workflow: {
        kind: "lightloop" as const,
        taskDescription: "Write unit tests",
        stopRequest: {
          summary: "done",
          requestedAt: Date.now(),
          requesterSessionID: "ses_partial_review",
          requesterMessageID: "msg_123",
          reviewTaskID: "ctx_partial",
        },
      },
    })

    const handled = await LightLoopContinuationPolicy.handle(g)

    expect(handled).toBe(true)
    expect(deliveries).toHaveLength(1)
  })

  test("delivered mail is a system-origin user message with continuation prompt", async () => {
    const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
    ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
      deliveries.push(input)
    })

    const g = gate({
      id: "ses_delivery",
      workflow: { kind: "lightloop", taskDescription: "Refactor the login flow" },
    })

    await LightLoopContinuationPolicy.handle(g)

    const mail = deliveries[0].mail
    expect(mail.type).toBe("user")
    if (mail.type !== "user") throw new Error("expected user mail")

    const part = mail.parts[0]
    expect(part.type).toBe("text")
    if (part.type === "text") {
      expect(part.origin).toBe("system")
      expect("synthetic" in part).toBe(false)
      expect(part.text).toBe(`Task: Refactor the login flow

Review the task against the current work:
- Are all requested deliverables complete?
- Is the result verified with appropriate evidence?
- Are there unresolved errors, missing edge cases, or implied follow-up steps?

If anything remains, continue working now. If the task is complete and verified, call loop_stop() to request a completion review. Do not claim completion without evidence.`)
    }
  })
})
