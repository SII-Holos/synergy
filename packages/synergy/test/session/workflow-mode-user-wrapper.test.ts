import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { WorkflowModeUserWrapper } from "../../src/session/workflow-mode-user-wrapper"

const sessionID = "session_test"
const planSession = { planMode: true } as any
const latticeSession = { lattice: { runID: "r1", mode: "auto" as const, firstBlueprintStarted: false } } as any
const lightLoopSession = { lightLoop: { active: true, taskDescription: "test" } } as any
const normalSession = { planMode: false } as any

function userMessage(id: string, text: string, metadata?: Record<string, any>): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "synergy",
      model: { providerID: "test", modelID: "test" },
      metadata,
      isRoot: true,
      origin: { type: "user" },
    } as any,
    parts: [
      {
        id: `${id}_part`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      },
    ] as MessageV2.Part[],
  }
}

describe("WorkflowModeUserWrapper metadata", () => {
  // -- activeMode --

  test("activeMode detects the current workflow", () => {
    expect(WorkflowModeUserWrapper.activeMode(planSession)).toBe("plan")
    expect(WorkflowModeUserWrapper.activeMode(latticeSession)).toBe("lattice")
    expect(WorkflowModeUserWrapper.activeMode(lightLoopSession)).toBe("light_loop")
    expect(WorkflowModeUserWrapper.activeMode(normalSession)).toBeUndefined()
  })

  // -- stripReservedMetadata --

  test("strips reserved metadata keys (new + legacy)", () => {
    expect(
      WorkflowModeUserWrapper.stripReservedMetadata({
        workflowMode: "plan",
        workflowModeAgent: "synergy",
        workflowModeVersion: 1,
        planModeRequest: true,
        planModeAgent: "synergy",
        planModeWrapperVersion: 1,
        source: "mailbox",
      }),
    ).toEqual({ source: "mailbox" })
  })

  // -- metadataForUserMessage (plan mode → legacy compat) --

  test("marks Plan Mode user messages with new metadata keys", () => {
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        agentName: "synergy",
      }),
    ).toEqual({
      workflowMode: "plan",
      workflowModeAgent: "synergy",
      workflowModeVersion: 1,
    })
  })

  test("marks Lattice and Light Loop user messages", () => {
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: latticeSession,
        agentName: "synergy",
      }),
    ).toEqual({
      workflowMode: "lattice",
      workflowModeAgent: "synergy",
      workflowModeVersion: 1,
    })
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: lightLoopSession,
        agentName: "synergy",
      }),
    ).toEqual({
      workflowMode: "light_loop",
      workflowModeAgent: "synergy",
      workflowModeVersion: 1,
    })
  })

  test("does not mark non-workflow-mode, noReply, or control messages", () => {
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: normalSession,
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        noReply: true,
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "blueprint_loop_start" },
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "lattice_continuation" },
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "light_loop_continuation" },
        agentName: "synergy",
      }),
    ).toEqual({})
  })

  test("does not auto-mark sourced system mail unless explicitly opted in", () => {
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "mailbox" },
        agentName: "synergy",
      }),
    ).toEqual({})
    // New opt-in
    expect(
      WorkflowModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "mailbox", workflowMode: "plan" },
        agentName: "synergy",
      }),
    ).toEqual({
      workflowMode: "plan",
      workflowModeAgent: "synergy",
      workflowModeVersion: 1,
    })
  })

  // -- isRequestMetadata (backward compat) --

  test("isRequestMetadata recognizes legacy plan-mode metadata", () => {
    expect(WorkflowModeUserWrapper.isRequestMetadata({ planModeRequest: true })).toBe(true)
    expect(WorkflowModeUserWrapper.isRequestMetadata({ someOther: true })).toBe(false)
    expect(WorkflowModeUserWrapper.isRequestMetadata({ workflowMode: "plan" })).toBe(true)
    expect(WorkflowModeUserWrapper.isRequestMetadata({ workflowMode: "lattice" })).toBe(true)
    expect(WorkflowModeUserWrapper.isRequestMetadata({ workflowMode: "light_loop" })).toBe(true)
    expect(WorkflowModeUserWrapper.isRequestMetadata({ workflowMode: "bogus" })).toBe(false)
  })
})

describe("WorkflowModeUserWrapper projection", () => {
  test("wraps marked Plan Mode synergy requests (new metadata)", () => {
    const original = userMessage("message_1", "build the new importer", {
      workflowMode: "plan",
      workflowModeAgent: "synergy",
    })
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [original],
      session: planSession,
      agent: { name: "synergy" },
    })

    expect((original.parts[0] as MessageV2.TextPart).text).toBe("build the new importer")
    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy in Plan Mode")
    expect(text).toContain("User request:\nbuild the new importer")
  })

  test("wraps marked Plan Mode synergy requests (legacy metadata)", () => {
    const original = userMessage("message_1", "build the new importer", {
      planModeRequest: true,
      planModeAgent: "synergy",
    })
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [original],
      session: planSession,
      agent: { name: "synergy" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy in Plan Mode")
  })

  test("wraps Lattice requests", () => {
    const original = userMessage("message_2", "build a full CI pipeline", {
      workflowMode: "lattice",
      workflowModeAgent: "synergy-max",
    })
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [original],
      session: latticeSession,
      agent: { name: "synergy-max" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in Lattice Mode")
    expect(text).toContain("User request:\nbuild a full CI pipeline")
  })

  test("wraps Light Loop requests", () => {
    const original = userMessage("message_3", "refactor the auth module", {
      workflowMode: "light_loop",
      workflowModeAgent: "synergy",
    })
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [original],
      session: lightLoopSession,
      agent: { name: "synergy" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy in Light Loop mode")
    expect(text).toContain("User request:\nrefactor the auth module")
  })

  test("uses coding-specific guidance for synergy-max Plan Mode", () => {
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "refactor the route layer", {
          workflowMode: "plan",
          workflowModeAgent: "synergy-max",
        }),
      ],
      session: planSession,
      agent: { name: "synergy-max" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in coding Plan Mode")
    expect(text).toContain("Do not implement code. Do not edit files.")
    expect(text).toContain("User request:\nrefactor the route layer")
  })

  test("uses stored agent metadata when projecting history", () => {
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "build it", {
          workflowMode: "plan",
          workflowModeAgent: "synergy-max",
        }),
      ],
      session: planSession,
      agent: { name: "synergy" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in coding Plan Mode")
  })

  test("falls back to generic guidance for custom agents", () => {
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "shape a rollout plan", {
          workflowMode: "plan",
          workflowModeAgent: "custom-agent",
        }),
      ],
      session: planSession,
      agent: { name: "custom-agent" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are in Plan Mode")
    expect(text).toContain("User request:\nshape a rollout plan")
  })

  test("does not wrap unmarked user messages", () => {
    const projected = WorkflowModeUserWrapper.projectMessages({
      messages: [userMessage("message_1", "ordinary history")],
      session: planSession,
      agent: { name: "synergy" },
    })

    expect((projected[0].parts[0] as MessageV2.TextPart).text).toBe("ordinary history")
  })
})
