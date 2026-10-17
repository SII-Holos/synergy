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
    "Keep the full Blueprint and user instructions in scope through subtasks and rework. Read the Note when requirements are missing (including after compaction) or changed; compare all outcomes before completion.",
    loop.source === "lattice"
      ? "Only the current Lattice Step is authorized. Future Pathway Steps are context; do not create, submit or implement them."
      : "Preserve scope and non-goals; adjacent work is not an acceptable substitute.",
    input.isAuditSession
      ? "Independently verify all required outcomes. Inspect changes after the stop request for scope or lifecycle violations. Submit blueprint_loop_approve or blueprint_loop_reject; the host selects the bound loop."
      : "Complete and verify the entire outcome. Use extra reviewers only for concrete unresolved questions. Call blueprint_loop_stop({summary}) with a concise result and evidence references, then end the turn without further tools or changes.",
    "</blueprint-loop-context>",
  ]
    .filter(Boolean)
    .join("\n")
}
