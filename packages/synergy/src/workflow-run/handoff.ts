import z from "zod"
import { Identifier } from "../id/id"
import { CharterStore } from "./charter-store"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * Structured handoff (A2A v1.5). The engine delivers a handoff to a seat
 * session as a Cortex-owned task on the seat's durable session. Its metadata
 * carries the handoffID. Acknowledgement is deterministic: WorkflowBridge
 * observes the handoff user message materialise in the target session and only
 * then appends `handoff_acked`.
 */
export namespace WorkflowHandoff {
  export const ContextRef = z.object({
    kind: z.enum(["note", "session", "message", "file", "commit"]),
    ref: z.string(),
    hint: z.string().optional(),
  })
  export type ContextRef = z.infer<typeof ContextRef>

  export const Info = z
    .object({
      id: Identifier.schema("workflow_handoff"),
      runID: z.string(),
      entityID: z.string(),
      toSeat: z.object({ seat: z.string(), instance: z.number() }),
      task: z.string(),
      acceptance: z.array(z.string()).default([]),
      contextRefs: z.array(ContextRef).default([]),
      expectedSubmission: z.enum(["deliverable", "review_verdict", "test_report"]),
    })
    .meta({ ref: "WorkflowHandoff" })
  export type Info = z.infer<typeof Info>

  export function render(handoff: Info, entity: WorkflowTypes.Entity): string {
    const lines = [
      `You have been handed a workflow task for entity "${entity.title}" (${entity.id}).`,
      "",
      `Task: ${handoff.task}`,
    ]
    // The entity description carries the Boss's analysis (exact files, steps,
    // acceptance details). It is the whole point of the handoff — always include
    // it so the seat doesn't have to re-derive what the Boss already worked out.
    if (entity.description?.trim()) {
      lines.push("", "Entity details:", entity.description.trim())
    }
    if (handoff.acceptance.length > 0) {
      lines.push("", "Acceptance criteria:")
      for (const a of handoff.acceptance) lines.push(`- ${a}`)
    }
    if (handoff.contextRefs.length > 0) {
      lines.push("", "Context (fetch these yourself; they are references, not copies):")
      for (const ref of handoff.contextRefs) {
        lines.push(`- [${ref.kind}] ${ref.ref}${ref.hint ? ` — ${ref.hint}` : ""}`)
      }
    }
    lines.push(
      "",
      `When done, record the outcome with workflow_submit (expected: ${handoff.expectedSubmission}).`,
      "If you are blocked, call workflow_block with a concrete reason.",
    )
    return lines.join("\n")
  }

  /**
   * Deliver a handoff by launching a Cortex task on the seat session. Returns
   * the Cortex task id so the seat binding can track active work.
   */
  export async function deliver(
    scopeID: string,
    sessionID: string,
    handoff: Info,
    entity: WorkflowTypes.Entity,
  ): Promise<string> {
    const text = render(handoff, entity)
    const run = await WorkflowRunStore.get(scopeID, handoff.runID)
    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)
    const def = charter.seats.find((seat) => seat.name === handoff.toSeat.seat)
    if (!def) throw new Error(`Charter has no seat '${handoff.toSeat.seat}'`)

    const { Cortex } = await import("../cortex")
    const task = await Cortex.launch({
      description: `Seat ${handoff.toSeat.seat}#${handoff.toSeat.instance}: ${entity.title}`,
      prompt: text,
      agent: def.agent,
      parentSessionID: run.bossSessionID,
      parentMessageID: Identifier.ascending("message"),
      sessionID,
      model: def.model,
      tools: def.tools,
      visibility: "hidden",
      notifyParentOnComplete: false,
      owner: {
        kind: "workflow_run",
        runID: handoff.runID,
        entityID: handoff.entityID,
        seat: handoff.toSeat.seat,
        instance: handoff.toSeat.instance,
        correlationID: `workflow:${handoff.runID}:entity:${handoff.entityID}:seat:${handoff.toSeat.seat}#${handoff.toSeat.instance}`,
      },
      metadata: {
        workflowRun: { runID: handoff.runID, entityID: handoff.entityID, handoffID: handoff.id },
      },
    })
    return task.id
  }
}
