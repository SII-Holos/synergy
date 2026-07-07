import { Identifier } from "@/id/id"
import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "../blueprint"
import { ContinuationKernel } from "./continuation-kernel"
import { SessionManager } from "./manager"

/**
 * BlueprintContinuationPolicy: when a session bound to a `running` BlueprintLoop
 * goes idle after a terminal assistant response, wake it to keep executing the
 * loop. Registered with the ContinuationKernel at higher priority than Lattice
 * so a live BlueprintLoop owns the idle while it is running.
 */
export const BlueprintContinuationPolicy: ContinuationKernel.Policy = {
  id: "blueprint_loop",
  priority: 100,
  async handle(gate) {
    const loopID = gate.session.blueprint?.loopID
    if (!loopID) return false

    const loop = await BlueprintLoopStore.get(gate.scopeID, loopID).catch(() => undefined)
    if (!loop || loop.status !== "running") return false

    await deliverContinuation(gate.sessionID, loop)
    return true
  },
}

async function deliverContinuation(sessionID: string, loop: BlueprintLoopInfo): Promise<void> {
  await SessionManager.deliver({
    target: sessionID,
    mail: {
      type: "user",
      summary: {
        title: `Continue ${loop.title} blueprint`,
      },
      parts: [
        {
          id: Identifier.ascending("part"),
          sessionID,
          messageID: "",
          type: "text",
          text: continuationText(loop),
          synthetic: true,
        },
      ],
      metadata: {
        source: "blueprint_loop_continuation",
        loopID: loop.id,
        noteID: loop.noteID,
        title: loop.title,
        status: loop.status,
      },
    },
  })
}

function continuationText(loop: BlueprintLoopInfo): string {
  return [
    `BlueprintLoop ${loop.id} status is \`running\`.`,
    "",
    `A normal final response does not finish this loop. Inspect the Blueprint note (${loop.noteID}), any start user instruction, the current delivered state, and any domain-appropriate quality evidence before deciding what to do next.`,
    loop.userPrompt ? `Start user instruction: ${loop.userPrompt}` : "",
    loop.userPrompt ? `This start user instruction is run-specific contract for execution and audit.` : "",
    "",
    `If the Blueprint outcome is not complete, continue the remaining execution work now.`,
    `If the Blueprint outcome is complete and ready for review, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).`,
    `If the task is blocked beyond recovery, call blueprint_loop_finish({ loopID: "${loop.id}", status: "failed", summary: "..." }).`,
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Backwards-compatible facade. Prefer ContinuationKernel directly; this keeps
 * the original single-session entry point (used by tests and any legacy call
 * sites) working by running the shared gate then the blueprint policy.
 */
export namespace BlueprintContinuation {
  export function init(): () => void {
    return ContinuationKernel.init()
  }

  export async function handleIdle(sessionID: string): Promise<boolean> {
    const gate = await ContinuationKernel.passesSharedGate(sessionID)
    if (!gate) return false
    return BlueprintContinuationPolicy.handle(gate)
  }
}
