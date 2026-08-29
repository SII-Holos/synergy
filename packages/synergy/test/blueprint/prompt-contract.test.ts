import { describe, expect, test } from "bun:test"
import type { Info as BlueprintLoopInfo } from "../../src/blueprint/types"
import { buildBlueprintLoopContext } from "../../src/blueprint/prompt"
import { WorkflowUserWrapper } from "../../src/session/workflow-user-wrapper"

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

describe("blueprint loop context golden (audit variant)", () => {
  test("audit instruction names both verdict tools and the stop boundary", () => {
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
        `You are auditing this BlueprintLoop. Read the Blueprint note with note_read ids=["nte_alpha"] and audit the start user instruction when present. Treat Change Scope, boundaries, and non-goals as requirements; adjacent work is not an acceptable superset.  Inspect the execution trajectory after the first successful blueprint_loop_stop and reject if execution called more tools, modified artifacts, assisted review, or began adjacent work after that boundary. If changes are required, call blueprint_loop_reject with sessionID "ses_exec" and structured reason, completed, remaining, and instructions fields. If and only if the outcome is complete, verified, in scope, and lifecycle-correct, call blueprint_loop_approve with sessionID "ses_exec" and a verdict summary.`,
        "</blueprint-loop-context>",
      ].join("\n"),
    )
  })

  test("audit instruction carries the lattice boundary for lattice-sourced loops", () => {
    const block = buildBlueprintLoopContext({
      loop: loopFixture({ source: "lattice" }),
      isAuditSession: true,
      agentName: "supervisor",
    })
    expect(block).toContain(
      "adjacent work is not an acceptable superset. This BlueprintLoop owns one current Lattice Step, and future Pathway Step implementation is unauthorized. Inspect the execution trajectory",
    )
  })
})

describe("blueprint loop context golden (execution variants)", () => {
  const stopBoundary =
    "After blueprint_loop_stop succeeds, execution is closed. Call no more tools, modify nothing else, and end the assistant turn immediately so the reviewer can start."

  test("synergy-max execution instruction is byte-exact", () => {
    expect(buildBlueprintLoopContext({ loop: loopFixture(), isAuditSession: false, agentName: "synergy-max" })).toBe(
      [
        "<blueprint-loop-context>",
        "Active BlueprintLoop: blueprint_loop_alpha",
        "BlueprintLoop role: execution",
        "Blueprint Note: nte_alpha",
        "Title: Ship the importer",
        "Description: N/A",
        "Status: running",
        "",
        `You are executing this coding BlueprintLoop. Before editing code, call note_read ids=["nte_alpha"] and read the full Blueprint content. Satisfy both the Blueprint note and any start user instruction before requesting audit.  Continue until the current Blueprint is fully implemented and verified. When ready for audit, call blueprint_loop_stop with a summary and concrete completion evidence. ${stopBoundary}`,
        "</blueprint-loop-context>",
      ].join("\n"),
    )
  })

  test("generic execution instruction is byte-exact", () => {
    expect(buildBlueprintLoopContext({ loop: loopFixture(), isAuditSession: false, agentName: "synergy" })).toBe(
      [
        "<blueprint-loop-context>",
        "Active BlueprintLoop: blueprint_loop_alpha",
        "BlueprintLoop role: execution",
        "Blueprint Note: nte_alpha",
        "Title: Ship the importer",
        "Description: N/A",
        "Status: running",
        "",
        `You are executing this BlueprintLoop. Before carrying out the Blueprint, call note_read ids=["nte_alpha"] and read the full Blueprint content. Satisfy both the Blueprint note and any start user instruction before requesting audit.  Continue until the current Blueprint outcome is fully delivered. When ready for audit, call blueprint_loop_stop with a summary and concrete completion evidence. ${stopBoundary}`,
        "</blueprint-loop-context>",
      ].join("\n"),
    )
  })

  test("lattice source injects the execution boundary; user prompt adds the contract lines", () => {
    const block = buildBlueprintLoopContext({
      loop: loopFixture({ source: "lattice", userPrompt: "全量执行，开一个大 PR。" }),
      isAuditSession: false,
      agentName: "synergy-max",
    })
    expect(block).toContain(
      "This BlueprintLoop owns exactly one current Lattice Step. Future Pathway Steps are context only, not authorization. Earlier messages such as “continue” mean continue the current Blueprint only. Never create, submit, or implement a later Step. Continue until the current Blueprint is fully implemented and verified.",
    )
    expect(block).toContain("Start user instruction: 全量执行，开一个大 PR。")
    expect(block).toContain("This start user instruction is run-specific contract for execution and audit.")
  })

  test("description falls back to N/A and status is projected verbatim", () => {
    const block = buildBlueprintLoopContext({
      loop: loopFixture({ description: "A importer rewrite", status: "auditing" }),
      isAuditSession: true,
      agentName: "supervisor",
    })
    expect(block).toContain("Description: A importer rewrite")
    expect(block).toContain("Status: auditing")
  })
})

describe("blueprint control-source suppression golden", () => {
  const session = { workflow: { kind: "lightloop", instructions: "task" } } as never

  test("blueprint_loop_* sources suppress workflow stamping", () => {
    for (const source of ["blueprint_loop_start", "blueprint_loop_continuation", "blueprint_loop_rejected"]) {
      expect(
        WorkflowUserWrapper.metadataForUserMessage({
          session,
          metadata: { source },
          agentName: "synergy",
        }),
      ).toEqual({})
    }
  })

  test("unstamped user requests still get workflow metadata", () => {
    expect(WorkflowUserWrapper.metadataForUserMessage({ session, agentName: "synergy" })).toEqual({
      workflow: "lightloop",
      workflowAgent: "synergy",
      workflowVersion: 1,
    })
  })
})
