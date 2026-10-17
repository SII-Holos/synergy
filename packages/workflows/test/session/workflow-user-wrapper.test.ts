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
  for (const agent of [PrimaryAgentIdentity.names.general, PrimaryAgentIdentity.names.coding, "custom-agent"]) {
    for (const session of [planSession, lightloopSession]) {
      test(`${session.workflow.kind} preserves marked user text for ${agent}`, () =>
        runtime.run(() => {
          const original = userMessage("message_1", "Build the importer and preserve its public API", {
            workflow: session.workflow.kind,
            workflowAgent: agent,
          })
          const projected = WorkflowUserWrapper.projectMessages({
            messages: [original],
            session,
            agent: { name: PrimaryAgentIdentity.names.general },
          })
          expect(projected).toEqual([original])
        }))
    }
  }

  test("preserves unmarked history", () =>
    runtime.run(() => {
      const original = userMessage("message_1", "ordinary history")
      expect(
        WorkflowUserWrapper.projectMessages({
          messages: [original],
          session: planSession,
          agent: { name: PrimaryAgentIdentity.names.general },
        }),
      ).toEqual([original])
    }))
})

afterRuntimeTests(() => runtime.close())
