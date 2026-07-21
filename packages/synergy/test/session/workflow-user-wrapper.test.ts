import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { WorkflowUserWrapper } from "../../src/session/workflow-user-wrapper"

const sessionID = "session_test"
const planSession = { workflow: { kind: "plan" as const } }
const latticeSession = {
  workflow: { kind: "lattice" as const, runID: "r1", mode: "auto" as const, firstBlueprintStarted: false },
}
const lightloopSession = { workflow: { kind: "lightloop" as const, instructions: "test" } }
const normalSession = {}

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

describe("WorkflowUserWrapper metadata", () => {
  test("activeMode detects the current workflow", () => {
    expect(WorkflowUserWrapper.activeMode(planSession)).toBe("plan")
    expect(WorkflowUserWrapper.activeMode(latticeSession)).toBe("lattice")
    expect(WorkflowUserWrapper.activeMode(lightloopSession)).toBe("lightloop")
    expect(WorkflowUserWrapper.activeMode(normalSession)).toBeUndefined()
  })

  test("strips reserved metadata keys", () => {
    expect(
      WorkflowUserWrapper.stripReservedMetadata({
        workflow: "plan",
        workflowAgent: "synergy",
        workflowVersion: 1,
        source: "mailbox",
      }),
    ).toEqual({ source: "mailbox" })
  })

  test("marks workflow user messages", () => {
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: planSession,
        agentName: "synergy",
      }),
    ).toEqual({
      workflow: "plan",
      workflowAgent: "synergy",
      workflowVersion: 1,
    })

    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: latticeSession,
        agentName: "synergy",
      }),
    ).toEqual({
      workflow: "lattice",
      workflowAgent: "synergy",
      workflowVersion: 1,
    })

    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: lightloopSession,
        agentName: "synergy",
      }),
    ).toEqual({
      workflow: "lightloop",
      workflowAgent: "synergy",
      workflowVersion: 1,
    })
  })

  test("does not mark non-workflow, noReply, control, or sourced messages", () => {
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: normalSession,
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: planSession,
        noReply: true,
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "blueprint_loop_start" },
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "mailbox" },
        agentName: "synergy",
      }),
    ).toEqual({})
  })

  test("allows sourced messages to opt in with current workflow metadata", () => {
    expect(
      WorkflowUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "mailbox", workflow: "plan" },
        agentName: "synergy",
      }),
    ).toEqual({
      workflow: "plan",
      workflowAgent: "synergy",
      workflowVersion: 1,
    })
  })

  test("isRequestMetadata recognizes canonical workflow metadata only", () => {
    expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "plan" })).toBe(true)
    expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "lattice" })).toBe(true)
    expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "lightloop" })).toBe(true)
    expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "light_loop" })).toBe(false)
    expect(WorkflowUserWrapper.isRequestMetadata({ someOther: true })).toBe(false)
  })
})

describe("WorkflowUserWrapper projection", () => {
  test("wraps marked Plan workflow requests", () => {
    const original = userMessage("message_1", "build the new importer", {
      workflow: "plan",
      workflowAgent: "synergy",
    })
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [original],
      session: planSession,
      agent: { name: "synergy" },
    })

    expect((original.parts[0] as MessageV2.TextPart).text).toBe("build the new importer")
    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy in the Plan workflow")
    expect(text).toContain("User request:\nbuild the new importer")
  })

  test("wraps Lattice requests", () => {
    const original = userMessage("message_2", "build a full CI pipeline", {
      workflow: "lattice",
      workflowAgent: "synergy-max",
    })
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [original],
      session: latticeSession,
      agent: { name: "synergy-max" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in the Lattice workflow")
    expect(text).toContain("User request:\nbuild a full CI pipeline")
  })

  test("wraps Light Loop requests", () => {
    const original = userMessage("message_3", "refactor the auth module", {
      workflow: "lightloop",
      workflowAgent: "synergy",
    })
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [original],
      session: lightloopSession,
      agent: { name: "synergy" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy in the Light Loop workflow")
    expect(text).toContain("User request:\nrefactor the auth module")
  })

  test("uses coding-specific guidance for synergy-max Plan", () => {
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "refactor the route layer", {
          workflow: "plan",
          workflowAgent: "synergy-max",
        }),
      ],
      session: planSession,
      agent: { name: "synergy-max" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in the coding Plan workflow")
    expect(text).toContain("Do not implement code. Do not edit files.")
    expect(text).toContain("User request:\nrefactor the route layer")
  })

  test("uses stored agent metadata when projecting history", () => {
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "build it", {
          workflow: "plan",
          workflowAgent: "synergy-max",
        }),
      ],
      session: planSession,
      agent: { name: "synergy" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in the coding Plan workflow")
  })

  test("falls back to generic guidance for custom agents", () => {
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "shape a rollout plan", {
          workflow: "plan",
          workflowAgent: "custom-agent",
        }),
      ],
      session: planSession,
      agent: { name: "custom-agent" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are in the Plan workflow")
    expect(text).toContain("User request:\nshape a rollout plan")
  })

  test("does not wrap unmarked user messages", () => {
    const projected = WorkflowUserWrapper.projectMessages({
      messages: [userMessage("message_1", "ordinary history")],
      session: planSession,
      agent: { name: "synergy" },
    })

    expect((projected[0].parts[0] as MessageV2.TextPart).text).toBe("ordinary history")
  })
})
