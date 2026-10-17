import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { describe, expect, spyOn, test } from "bun:test"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import type { Info as BlueprintLoopInfo } from "../../src/blueprint/types"
import { buildBlueprintLoopContext } from "../../src/blueprint/prompt"
import { BlueprintLoopService } from "../../src/blueprint/service"
import { WorkflowUserWrapper } from "@ericsanchezok/synergy-harness/test/internal/session/workflow-user-wrapper"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function loopFixture(over: Record<string, unknown> = {}): BlueprintLoopInfo {
  return {
    id: "blueprint_loop_alpha",
    noteID: "nte_alpha",
    title: "Ship the importer",
    sessionID: "ses_exec",
    status: "running",
    source: "user",
    ...over,
  } as unknown as BlueprintLoopInfo
}

test.each([PrimaryAgentIdentity.names.coding, PrimaryAgentIdentity.names.general])(
  "%s Plan requires a Blueprint Note without prescribing tool calls",
  (agentName) =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({})
          const plan = WorkflowPromptRegistry.get("plan")
          expect(plan?.buildSystem).toBeDefined()
          const prompt = (await plan!.buildSystem!(session, { agentName, deliveryMetadata: undefined })).join("\n")
          expect(prompt).toContain("Blueprint Note")
          expect(prompt).toContain("complete goal")
          expect(prompt).not.toMatch(/note_(?:read|write|edit|list|search)|kind:\s*"blueprint"|`question`|expand_tools/)
        },
      }),
    ),
)

test.each([PrimaryAgentIdentity.names.coding, PrimaryAgentIdentity.names.general])(
  "%s first prompt identifies the complete Blueprint without a Note call recipe",
  (agent) =>
    runtime.run(async () => {
      const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
      const deliver = spyOn(SessionManager, "deliver").mockImplementation(async (input) => {
        deliveries.push(input)
      })
      try {
        const loop = loopFixture({ executionAgent: agent })
        await BlueprintLoopService.deliverFirstPrompt(loop.sessionID, loop)
        expect(deliveries).toHaveLength(1)
        const mail = deliveries[0].mail
        if (mail.type !== "user") throw new Error("Expected execution user mail")
        const prompt = mail.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        expect(prompt).toContain(loop.noteID)
        expect(prompt).toContain("Read the complete Note")
        expect(prompt).toContain("blueprint_loop_stop")
        expect(prompt).toContain("end the turn")
        expect(prompt).not.toMatch(/note_read|noteIds=/)
      } finally {
        deliver.mockRestore()
      }
    }),
)

test.each([false, true])("Blueprint context retains the full goal and Lattice scope (review=%s)", (isAuditSession) => {
  const prompt = buildBlueprintLoopContext({
    loop: loopFixture({ source: "lattice", userPrompt: "Preserve all existing data" }),
    isAuditSession,
    agentName: "forge",
  })
  expect(prompt).toContain("nte_alpha")
  expect(prompt).toContain("Preserve all existing data")
  expect(prompt).toContain("compaction")
  expect(prompt).toContain("before completion")
  expect(prompt).toContain("Only the current Lattice Step is authorized")
  expect(prompt).toContain(isAuditSession ? "blueprint_loop_approve" : "blueprint_loop_stop")
})

describe("blueprint control-source suppression golden", () => {
  const session = { workflow: { kind: "plan", instructions: "task" } } as never

  test("blueprint_loop_* sources suppress workflow stamping", () =>
    runtime.run(() => {
      for (const source of ["blueprint_loop_start", "blueprint_loop_continuation", "blueprint_loop_rejected"]) {
        expect(
          WorkflowUserWrapper.metadataForUserMessage({
            session,
            metadata: { source },
            agentName: PrimaryAgentIdentity.names.general,
          }),
        ).toEqual({})
      }
    }))

  test("unstamped user requests still get workflow metadata", () =>
    runtime.run(() => {
      expect(
        WorkflowUserWrapper.metadataForUserMessage({ session, agentName: PrimaryAgentIdentity.names.general }),
      ).toEqual({
        workflow: "plan",
        workflowAgent: PrimaryAgentIdentity.names.general,
        workflowVersion: 1,
      })
    }))
})

afterRuntimeTests(() => runtime.close())
