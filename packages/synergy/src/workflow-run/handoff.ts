import z from "zod"
import { Identifier } from "../id/id"
import { SessionManager } from "../session/manager"
import { WorkflowTypes } from "./types"

/**
 * Structured handoff (A2A v1.5). The engine delivers a handoff to a seat
 * session as a user mail (mode "task"); its metadata carries the handoffID.
 * Acknowledgement is deterministic: WorkflowBridge observes the handoff user
 * message actually materialise in the target session (the session was woken and
 * accepted the task) and only then appends `handoff_acked`. Guards depending on
 * `handoff_acked` will not release until that fact exists — so a
 * workflow-critical handoff that failed to wake its target is never treated as
 * complete.
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

  export async function deliver(sessionID: string, handoff: Info, entity: WorkflowTypes.Entity): Promise<void> {
    const part = {
      id: Identifier.ascending("part"),
      sessionID,
      messageID: Identifier.ascending("message"),
      type: "text" as const,
      text: render(handoff, entity),
    }
    const mail: SessionManager.SessionMail.User = {
      type: "user",
      parts: [part],
      summary: { title: `Handoff: ${entity.title}` },
      metadata: {
        source: "workflow_handoff",
        workflowRun: { runID: handoff.runID, entityID: handoff.entityID, handoffID: handoff.id },
      },
    }
    await SessionManager.deliver({ target: sessionID, mail, waitForProcessing: false })
  }
}
