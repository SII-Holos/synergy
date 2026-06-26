import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { PlanModeUserWrapper } from "../../src/session/plan-mode-user-wrapper"

const sessionID = "session_test"
const planSession = { blueprint: { planMode: true } } as any
const normalSession = { blueprint: { planMode: false } } as any

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

describe("PlanModeUserWrapper metadata", () => {
  test("strips reserved metadata keys from external input", () => {
    expect(
      PlanModeUserWrapper.stripReservedMetadata({
        planModeRequest: true,
        planModeAgent: "synergy",
        planModeWrapperVersion: 1,
        source: "mailbox",
      }),
    ).toEqual({ source: "mailbox" })
  })

  test("marks ordinary Plan Mode user messages", () => {
    expect(
      PlanModeUserWrapper.metadataForUserMessage({
        session: planSession,
        agentName: "synergy",
      }),
    ).toEqual({
      planModeRequest: true,
      planModeAgent: "synergy",
      planModeWrapperVersion: 1,
    })
  })

  test("does not mark non-Plan Mode, noReply, or Blueprint control messages", () => {
    expect(
      PlanModeUserWrapper.metadataForUserMessage({
        session: normalSession,
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      PlanModeUserWrapper.metadataForUserMessage({
        session: planSession,
        noReply: true,
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      PlanModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "blueprint_loop_start" },
        agentName: "synergy",
      }),
    ).toEqual({})
  })

  test("does not auto-mark sourced system mail unless explicitly requested", () => {
    expect(
      PlanModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "mailbox" },
        agentName: "synergy",
      }),
    ).toEqual({})
    expect(
      PlanModeUserWrapper.metadataForUserMessage({
        session: planSession,
        metadata: { source: "mailbox", planModeRequest: true },
        agentName: "synergy",
      }),
    ).toEqual({
      planModeRequest: true,
      planModeAgent: "synergy",
      planModeWrapperVersion: 1,
    })
  })
})

describe("PlanModeUserWrapper projection", () => {
  test("wraps marked synergy requests for model input without mutating stored parts", () => {
    const original = userMessage("message_1", "build the new importer", {
      planModeRequest: true,
      planModeAgent: "synergy",
    })
    const projected = PlanModeUserWrapper.projectMessages({
      messages: [original],
      session: planSession,
      agent: { name: "synergy" },
    })

    expect((original.parts[0] as MessageV2.TextPart).text).toBe("build the new importer")
    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy in Plan Mode")
    expect(text).toContain("Your job is to create a new Blueprint or refine an existing Blueprint")
    expect(text).toContain("User request:\nbuild the new importer")
  })

  test("uses coding-specific guidance for synergy-max", () => {
    const projected = PlanModeUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "refactor the route layer", {
          planModeRequest: true,
          planModeAgent: "synergy-max",
        }),
      ],
      session: planSession,
      agent: { name: "synergy-max" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in coding Plan Mode")
    expect(text).toContain("Do not implement code. Do not edit files.")
    expect(text).toContain("TDD strategy")
    expect(text).toContain("User request:\nrefactor the route layer")
  })

  test("uses the stored Plan Mode agent metadata when projecting history", () => {
    const projected = PlanModeUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "map the implementation surface", {
          planModeRequest: true,
          planModeAgent: "synergy-max",
        }),
      ],
      session: planSession,
      agent: { name: "synergy" },
    })

    const text = (projected[0].parts[0] as MessageV2.TextPart).text
    expect(text).toContain("You are synergy-max in coding Plan Mode")
  })

  test("falls back to generic guidance for custom agents", () => {
    const projected = PlanModeUserWrapper.projectMessages({
      messages: [
        userMessage("message_1", "shape a rollout plan", {
          planModeRequest: true,
          planModeAgent: "custom-agent",
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
    const projected = PlanModeUserWrapper.projectMessages({
      messages: [userMessage("message_1", "ordinary history")],
      session: planSession,
      agent: { name: "synergy" },
    })

    expect((projected[0].parts[0] as MessageV2.TextPart).text).toBe("ordinary history")
  })
})
