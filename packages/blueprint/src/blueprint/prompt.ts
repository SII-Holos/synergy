import type { Info as BlueprintLoopInfo } from "./types"

export function buildBlueprintLoopContext(input: {
  loop: BlueprintLoopInfo
  isAuditSession: boolean
  agentName: string
}): string {
  const { loop } = input
  return [
    "<blueprint-loop-context>",
    `BlueprintLoop ${loop.id}: ${loop.title}; status ${loop.status}; Note ${loop.noteID}.`,
    loop.userPrompt ? `Start user instruction: ${loop.userPrompt}` : "",
    "The full Blueprint and user instructions remain the contract. Re-read the Note after compaction, resumption or missing context, and before completion; do not reduce the goal to the latest subtask or repair request.",
    loop.source === "lattice"
      ? "Only the current Lattice Step is authorized. Future Pathway Steps are context; do not create, submit or implement them."
      : "Preserve scope and non-goals; adjacent work is not an acceptable substitute.",
    input.isAuditSession
      ? "Independently verify all required outcomes. Inspect changes after the stop request for scope or lifecycle violations. Submit blueprint_loop_approve or blueprint_loop_reject; the host selects the bound loop."
      : "Complete and verify the entire outcome, then call blueprint_loop_stop({summary}) with results and evidence. After success, call no more tools, change nothing and end the turn so review can start.",
    "</blueprint-loop-context>",
  ]
    .filter(Boolean)
    .join("\n")
}
