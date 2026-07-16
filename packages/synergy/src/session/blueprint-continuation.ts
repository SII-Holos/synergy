import { BlueprintLoopStore, type Info as BlueprintLoopInfo } from "../blueprint"
import { ContinuationKernel } from "./continuation-kernel"

export const BlueprintContinuationPolicy: ContinuationKernel.Policy = {
  id: "blueprint_loop",
  priority: 100,
  async handle(gate) {
    const loopID = gate.session.blueprint?.loopID
    if (!loopID) return undefined

    const loop = await BlueprintLoopStore.get(gate.scopeID, loopID).catch(() => undefined)
    if (!loop || loop.status !== "running") return undefined

    return continuationProposal(loop)
  },
}

function continuationProposal(loop: BlueprintLoopInfo): ContinuationKernel.InboxProposal {
  return {
    kind: "inbox",
    mode: "steer",
    message: {
      role: "user",
      summary: { title: `Continue ${loop.title} blueprint` },
      parts: [
        {
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
  }
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
    `If the Blueprint outcome is complete and verified, call blueprint_loop_stop with a concise summary, completed requirements, concrete evidence, and any known limitations to request independent review.`,
  ]
    .filter(Boolean)
    .join("\n")
}

export namespace BlueprintContinuation {
  export function init(): () => void {
    return ContinuationKernel.init()
  }

  export async function handleIdle(sessionID: string): Promise<boolean> {
    return ContinuationKernel.evaluate(sessionID)
  }
}
