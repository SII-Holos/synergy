import type { Info as BlueprintLoopInfo } from "./types"

/**
 * <blueprint-loop-context> system-block builder. Bytes locked byte-exact by
 * test/blueprint/prompt-contract.test.ts (S4a golden); invoke.ts renders this
 * for every session bound to an active BlueprintLoop.
 */
export function buildBlueprintLoopContext(input: {
  loop: BlueprintLoopInfo
  isAuditSession: boolean
  agentName: string
}): string {
  const { loop } = input
  const latticeExecutionBoundary =
    loop.source === "lattice"
      ? "This BlueprintLoop owns exactly one current Lattice Step. Future Pathway Steps are context only, not authorization. Earlier messages such as “continue” mean continue the current Blueprint only. Never create, submit, or implement a later Step."
      : ""
  const stopBoundary =
    "After blueprint_loop_stop succeeds, execution is closed. Call no more tools, modify nothing else, and end the assistant turn immediately so the reviewer can start."
  const loopInstruction = input.isAuditSession
    ? `You are auditing this BlueprintLoop. Read the Blueprint note with note_read ids=["${loop.noteID}"] and audit the start user instruction when present. Treat Change Scope, boundaries, and non-goals as requirements; adjacent work is not an acceptable superset. ${loop.source === "lattice" ? "This BlueprintLoop owns one current Lattice Step, and future Pathway Step implementation is unauthorized." : ""} Inspect the execution trajectory after the first successful blueprint_loop_stop and reject if execution called more tools, modified artifacts, assisted review, or began adjacent work after that boundary. If changes are required, call blueprint_loop_reject with sessionID "${loop.sessionID}" and structured reason, completed, remaining, and instructions fields. If and only if the outcome is complete, verified, in scope, and lifecycle-correct, call blueprint_loop_approve with sessionID "${loop.sessionID}" and a verdict summary.`
    : input.agentName === "synergy-max"
      ? `You are executing this coding BlueprintLoop. Before editing code, call note_read ids=["${loop.noteID}"] and read the full Blueprint content. Satisfy both the Blueprint note and any start user instruction before requesting audit. ${latticeExecutionBoundary} Continue until the current Blueprint is fully implemented and verified. When ready for audit, call blueprint_loop_stop with a summary and concrete completion evidence. ${stopBoundary}`
      : `You are executing this BlueprintLoop. Before carrying out the Blueprint, call note_read ids=["${loop.noteID}"] and read the full Blueprint content. Satisfy both the Blueprint note and any start user instruction before requesting audit. ${latticeExecutionBoundary} Continue until the current Blueprint outcome is fully delivered. When ready for audit, call blueprint_loop_stop with a summary and concrete completion evidence. ${stopBoundary}`
  const startUserInstruction = loop.userPrompt
    ? [
        `Start user instruction: ${loop.userPrompt}`,
        `This start user instruction is run-specific contract for execution and audit.`,
      ]
    : []
  return [
    "<blueprint-loop-context>",
    `Active BlueprintLoop: ${loop.id}`,
    `BlueprintLoop role: ${input.isAuditSession ? "audit" : "execution"}`,
    `Blueprint Note: ${loop.noteID}`,
    `Title: ${loop.title}`,
    `Description: ${loop.description ?? "N/A"}`,
    `Status: ${loop.status}`,
    ...startUserInstruction,
    "",
    loopInstruction,
    "</blueprint-loop-context>",
  ].join("\n")
}
