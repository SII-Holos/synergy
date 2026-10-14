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

/**
 * Blueprint prompt contract (S4a golden). Locks the byte-level shape of the
 * <blueprint-loop-context> system block (audit / synergy-max execution /
 * generic execution variants, lattice boundary, start user instruction) and
 * the control-source suppression for blueprint_loop_* message sources before
 * the S4b vertical slice moves the bytes into the blueprint domain. Any diff
 * here must be an explicit product decision, never a refactor side effect.
 */

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
          expect(prompt).toContain("stored as a Blueprint Note")
          expect(prompt).toContain("decision-complete")
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
        expect(prompt).toContain(`note ID: ${loop.noteID}`)
        expect(prompt).toContain("Read the full Blueprint")
        expect(prompt).toContain("blueprint_loop_stop")
        expect(prompt).toContain("call no more tools, modify nothing else")
        expect(prompt).not.toMatch(/note_read|noteIds=|call blueprint_loop_stop with/)
      } finally {
        deliver.mockRestore()
      }
    }),
)

describe("blueprint loop context golden (audit variant)", () => {
  test("audit instruction names both verdict tools and the stop boundary", () =>
    runtime.run(() => {
      expect(buildBlueprintLoopContext({ loop: loopFixture(), isAuditSession: true, agentName: "supervisor" })).toBe(
        [
          "<blueprint-loop-context>",
          "Active BlueprintLoop: blueprint_loop_alpha",
          "BlueprintLoop role: audit",
          "Blueprint Note: nte_alpha",
          "Title: Ship the importer",
          "Description: N/A",
          "Status: running",
          "",
          `You are auditing this BlueprintLoop. Read the complete Blueprint note and audit the start user instruction when present. Treat Change Scope, boundaries, and non-goals as requirements; adjacent work is not an acceptable superset.  Inspect the execution trajectory after the first successful blueprint_loop_stop and reject if execution called more tools, modified artifacts, assisted review, or began adjacent work after that boundary. Formally submit rejection through blueprint_loop_reject if changes are required; approve through blueprint_loop_approve only when the outcome is complete, verified, in scope, and lifecycle-correct. The execution target is ses_exec.`,
          "</blueprint-loop-context>",
        ].join("\n"),
      )
    }))

  test("audit instruction carries the lattice boundary for lattice-sourced loops", () =>
    runtime.run(() => {
      const block = buildBlueprintLoopContext({
        loop: loopFixture({ source: "lattice" }),
        isAuditSession: true,
        agentName: "supervisor",
      })
      expect(block).toContain(
        "adjacent work is not an acceptable superset. This BlueprintLoop owns one current Lattice Step, and future Pathway Step implementation is unauthorized. Inspect the execution trajectory",
      )
    }))
})

describe("blueprint loop context golden (execution variants)", () => {
  const stopBoundary =
    "After blueprint_loop_stop succeeds, execution is closed. Call no more tools, modify nothing else, and end the assistant turn immediately so the reviewer can start."

  test("synergy-max execution instruction is byte-exact", () =>
    runtime.run(() => {
      expect(
        buildBlueprintLoopContext({
          loop: loopFixture(),
          isAuditSession: false,
          agentName: PrimaryAgentIdentity.names.coding,
        }),
      ).toBe(
        [
          "<blueprint-loop-context>",
          "Active BlueprintLoop: blueprint_loop_alpha",
          "BlueprintLoop role: execution",
          "Blueprint Note: nte_alpha",
          "Title: Ship the importer",
          "Description: N/A",
          "Status: running",
          "",
          `You are executing this coding BlueprintLoop. Understand the full Blueprint before editing code. Satisfy both the Blueprint note and any start user instruction before requesting audit.  Continue until the current Blueprint is fully implemented and verified. When ready, formally request audit through blueprint_loop_stop. ${stopBoundary}`,
          "</blueprint-loop-context>",
        ].join("\n"),
      )
    }))

  test("generic execution instruction is byte-exact", () =>
    runtime.run(() => {
      expect(
        buildBlueprintLoopContext({
          loop: loopFixture(),
          isAuditSession: false,
          agentName: PrimaryAgentIdentity.names.general,
        }),
      ).toBe(
        [
          "<blueprint-loop-context>",
          "Active BlueprintLoop: blueprint_loop_alpha",
          "BlueprintLoop role: execution",
          "Blueprint Note: nte_alpha",
          "Title: Ship the importer",
          "Description: N/A",
          "Status: running",
          "",
          `You are executing this BlueprintLoop. Understand the full Blueprint before carrying out its work. Satisfy both the Blueprint note and any start user instruction before requesting audit.  Continue until the current Blueprint outcome is fully delivered. When ready, formally request audit through blueprint_loop_stop. ${stopBoundary}`,
          "</blueprint-loop-context>",
        ].join("\n"),
      )
    }))

  test("lattice source injects the execution boundary; user prompt adds the contract lines", () =>
    runtime.run(() => {
      const block = buildBlueprintLoopContext({
        loop: loopFixture({ source: "lattice", userPrompt: "全量执行，开一个大 PR。" }),
        isAuditSession: false,
        agentName: PrimaryAgentIdentity.names.coding,
      })
      expect(block).toContain(
        "This BlueprintLoop owns exactly one current Lattice Step. Future Pathway Steps are context only, not authorization. Earlier messages such as “continue” mean continue the current Blueprint only. Never create, submit, or implement a later Step. Continue until the current Blueprint is fully implemented and verified.",
      )
      expect(block).toContain("Start user instruction: 全量执行，开一个大 PR。")
      expect(block).toContain("This start user instruction is run-specific contract for execution and audit.")
    }))

  test("description falls back to N/A and status is projected verbatim", () =>
    runtime.run(() => {
      const block = buildBlueprintLoopContext({
        loop: loopFixture({ description: "A importer rewrite", status: "auditing" }),
        isAuditSession: true,
        agentName: "supervisor",
      })
      expect(block).toContain("Description: A importer rewrite")
      expect(block).toContain("Status: auditing")
    }))
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
