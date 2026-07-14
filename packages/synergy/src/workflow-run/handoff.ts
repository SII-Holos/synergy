import z from "zod"
import { Identifier } from "../id/id"
import { Session } from "../session"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { CharterStore } from "./charter-store"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * Structured handoff (A2A v1.5). The engine delivers a durable task to the
 * seat's SessionInbox. Its metadata carries the handoffID. Acknowledgement is
 * deterministic: WorkflowBridge observes the handoff user message materialise
 * in the target session and only then appends `handoff_acked`.
 */
export namespace WorkflowHandoff {
  export interface Delivery {
    itemID?: string
    messageID: string
  }

  const deliveries = new Map<string, Promise<Delivery>>()

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

  /** Deliver one durable task for a stable handoff id. */
  export async function deliver(
    scopeID: string,
    sessionID: string,
    handoff: Info,
    entity: WorkflowTypes.Entity,
    options?: { wake?: boolean },
  ): Promise<Delivery> {
    const key = `${sessionID}:${handoff.id}`
    const active = deliveries.get(key)
    if (active) return active
    const delivery = deliverOnce(scopeID, sessionID, handoff, entity, options).finally(() => deliveries.delete(key))
    deliveries.set(key, delivery)
    return delivery
  }

  async function deliverOnce(
    scopeID: string,
    sessionID: string,
    handoff: Info,
    entity: WorkflowTypes.Entity,
    options?: { wake?: boolean },
  ): Promise<Delivery> {
    const existing = await findExisting(sessionID, handoff.id)
    if (existing) {
      scheduleWake(sessionID, options)
      return existing
    }

    const text = render(handoff, entity)
    const run = await WorkflowRunStore.get(scopeID, handoff.runID)
    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)
    const def = charter.seats.find((seat) => seat.name === handoff.toSeat.seat)
    if (!def) throw new Error(`Charter has no seat '${handoff.toSeat.seat}'`)

    const result = await SessionInbox.deliver({
      sessionID,
      mode: "task",
      message: {
        role: "user",
        agent: def.agent,
        origin: { type: "system", detail: "workflow_handoff" },
        visible: true,
        parts: [{ id: Identifier.ascending("part"), type: "text", text, origin: "system" }],
        summary: { title: `Workflow task: ${entity.title}` },
        metadata: {
          workflowRun: { runID: handoff.runID, entityID: handoff.entityID, handoffID: handoff.id },
        },
        model: def.model,
        tools: def.tools,
      },
    })
    scheduleWake(sessionID, options)
    return result
  }

  function scheduleWake(sessionID: string, options?: { wake?: boolean }): void {
    if (options?.wake !== false && !SessionManager.isRunning(sessionID)) {
      SessionManager.scheduleWake(sessionID, "workflow_handoff")
    }
  }

  async function findExisting(sessionID: string, handoffID: string): Promise<Delivery | undefined> {
    const pending = (await SessionInbox.list(sessionID)).find(
      (item) => workflowHandoffID(item.message?.metadata) === handoffID,
    )
    if (pending) return { itemID: pending.id, messageID: pending.messageID }

    const materialized = (await Session.messages({ sessionID })).find(
      (message) => message.info.role === "user" && workflowHandoffID(message.info.metadata) === handoffID,
    )
    if (materialized) return { messageID: materialized.info.id }
  }

  function workflowHandoffID(metadata: unknown): string | undefined {
    if (!metadata || typeof metadata !== "object") return undefined
    const workflow = (metadata as Record<string, unknown>).workflowRun
    if (!workflow || typeof workflow !== "object") return undefined
    const handoffID = (workflow as Record<string, unknown>).handoffID
    return typeof handoffID === "string" ? handoffID : undefined
  }
}
