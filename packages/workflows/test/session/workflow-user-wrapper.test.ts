import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { describe, expect, test } from "bun:test"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { WorkflowUserWrapper } from "@ericsanchezok/synergy-harness/test/internal/session/workflow-user-wrapper"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const sessionID = "session_test"
const planSession = { workflow: { kind: "plan" as const } }
const latticeSession = {
  workflow: { kind: "lattice" as const, runID: "r1", mode: "auto" as const },
}
const lightloopSession = { workflow: { kind: "lightloop" as const, instructions: "test" } }
const terminalLightloopSession = {
  workflow: { kind: "lightloop" as const, instructions: "done", status: "completed" as const },
}
const normalSession = {}

function userMessage(id: string, text: string, metadata?: Record<string, any>): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: PrimaryAgentIdentity.names.general,
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
  test("activeMode detects the current workflow", () =>
    runtime.run(() => {
      expect(WorkflowUserWrapper.activeMode(planSession)).toBe("plan")
      expect(WorkflowUserWrapper.activeMode(latticeSession)).toBe("lattice")
      expect(WorkflowUserWrapper.activeMode(lightloopSession)).toBe("lightloop")
      expect(WorkflowUserWrapper.activeMode(terminalLightloopSession)).toBeUndefined()
      expect(WorkflowUserWrapper.activeMode(normalSession)).toBeUndefined()
    }))

  test("strips reserved metadata keys", () =>
    runtime.run(() => {
      expect(
        WorkflowUserWrapper.stripReservedMetadata({
          workflow: "plan",
          workflowAgent: PrimaryAgentIdentity.names.general,
          workflowVersion: 1,
          source: "mailbox",
        }),
      ).toEqual({ source: "mailbox" })
    }))

  test("marks workflow user messages", () =>
    runtime.run(() => {
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: planSession,
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({
        workflow: "plan",
        workflowAgent: PrimaryAgentIdentity.names.general,
        workflowVersion: 1,
      })

      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: latticeSession,
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({
        workflow: "lattice",
        workflowAgent: PrimaryAgentIdentity.names.general,
        workflowVersion: 1,
      })

      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: lightloopSession,
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({
        workflow: "lightloop",
        workflowAgent: PrimaryAgentIdentity.names.general,
        workflowVersion: 1,
      })
    }))

  test("does not mark non-workflow, noReply, control, or sourced messages", () =>
    runtime.run(() => {
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: normalSession,
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({})
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: planSession,
          noReply: true,
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({})
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: planSession,
          metadata: { source: "blueprint_loop_start" },
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({})
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: planSession,
          metadata: { source: "mailbox" },
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({})
    }))

  test("allows sourced messages to opt in with current workflow metadata", () =>
    runtime.run(() => {
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session: planSession,
          metadata: { source: "mailbox", workflow: "plan" },
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toEqual({
        workflow: "plan",
        workflowAgent: PrimaryAgentIdentity.names.general,
        workflowVersion: 1,
      })
    }))

  test("isRequestMetadata recognizes canonical workflow metadata only", () =>
    runtime.run(() => {
      expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "plan" })).toBe(true)
      expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "lattice" })).toBe(true)
      expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "lightloop" })).toBe(true)
      expect(WorkflowUserWrapper.isRequestMetadata({ workflow: "light_loop" })).toBe(false)
      expect(WorkflowUserWrapper.isRequestMetadata({ someOther: true })).toBe(false)
    }))
})

describe("WorkflowUserWrapper projection", () => {
  test("wraps marked Plan workflow requests", () =>
    runtime.run(() => {
      const original = userMessage("message_1", "build the new importer", {
        workflow: "plan",
        workflowAgent: PrimaryAgentIdentity.names.general,
      })
      const projected = WorkflowUserWrapper.projectMessages({
        messages: [original],
        session: planSession,
        agent: { name: PrimaryAgentIdentity.names.general },
      })

      expect((original.parts[0] as MessageV2.TextPart).text).toBe("build the new importer")
      const text = (projected[0].parts[0] as MessageV2.TextPart).text
      expect(text).toContain(`You are ${PrimaryAgentIdentity.names.general} in the Plan workflow`)
      expect(text).toContain("converge materially different routes")
      expect(text).toContain("single clarification checkpoint")
      expect(text).toContain("one question call")
      expect(text).toContain("User request:\nbuild the new importer")
    }))

  test("uses coding-specific Plan guidance", () =>
    runtime.run(() => {
      const projected = WorkflowUserWrapper.projectMessages({
        messages: [
          userMessage("message_1", "refactor the route layer", {
            workflow: "plan",
            workflowAgent: PrimaryAgentIdentity.names.coding,
          }),
        ],
        session: planSession,
        agent: { name: PrimaryAgentIdentity.names.coding },
      })

      const text = (projected[0].parts[0] as MessageV2.TextPart).text
      expect(text).toContain(`You are ${PrimaryAgentIdentity.names.coding} in the coding Plan workflow`)
      expect(text).toContain("Do not carry out the requested change.")
      expect(text).toContain("one material engineering route")
      expect(text).toContain("canonical owner")
      expect(text).toContain("single clarification checkpoint")
      expect(text).toContain("one question call")
      expect(text).toContain("User request:\nrefactor the route layer")
    }))

  test("uses stored agent metadata when projecting history", () =>
    runtime.run(() => {
      const projected = WorkflowUserWrapper.projectMessages({
        messages: [
          userMessage("message_1", "build it", {
            workflow: "plan",
            workflowAgent: PrimaryAgentIdentity.names.coding,
          }),
        ],
        session: planSession,
        agent: { name: PrimaryAgentIdentity.names.general },
      })

      const text = (projected[0].parts[0] as MessageV2.TextPart).text
      expect(text).toContain(`You are ${PrimaryAgentIdentity.names.coding} in the coding Plan workflow`)
    }))

  test("falls back to generic guidance for custom agents", () =>
    runtime.run(() => {
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
    }))

  test("does not wrap unmarked user messages", () =>
    runtime.run(() => {
      const projected = WorkflowUserWrapper.projectMessages({
        messages: [userMessage("message_1", "ordinary history")],
        session: planSession,
        agent: { name: PrimaryAgentIdentity.names.general },
      })

      expect((projected[0].parts[0] as MessageV2.TextPart).text).toBe("ordinary history")
    }))
})

afterRuntimeTests(() => runtime.close())
