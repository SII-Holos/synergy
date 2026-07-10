import { NoteStore } from "../note"
import { NoteMarkdown } from "../note/markdown"
import type { WorkflowRunSessionInfo } from "../session/types"
import { CharterStore } from "./charter-store"
import { WorkflowRunStore } from "./store"
import { WorkflowSeats } from "./seats"
import { WorkflowTypes } from "./types"

/**
 * System-prompt blocks for workflow-run sessions. Injected every turn (invoke.ts
 * Layer 2.45) so a seat's standing duties, its current entity, and its allowed
 * transitions survive context compaction. Boss sessions get a control-plane
 * framing plus the live run overview.
 */
export namespace WorkflowPrompt {
  export async function build(
    scopeID: string,
    session: { id: string; workflowRun?: WorkflowRunSessionInfo },
  ): Promise<string | undefined> {
    const binding = session.workflowRun
    if (!binding) return undefined
    const run = await WorkflowRunStore.getOrUndefined(scopeID, binding.runID).catch(() => undefined)
    if (!run) return undefined
    const charter = await CharterStore.getOrUndefined(scopeID, run.charterRef.id, run.charterRef.version).catch(
      () => undefined,
    )
    if (!charter) return undefined

    if (binding.role === "boss") return buildBoss(run, charter)
    if (binding.role === "seat") return buildSeat(scopeID, run, charter, binding)
    return undefined
  }

  function buildBoss(run: WorkflowTypes.Run, charter: WorkflowTypes.Charter): string {
    const pendingGates = run.gates.filter((g) => g.status === "pending")
    const byState = new Map<string, number>()
    for (const e of run.entities) byState.set(e.state, (byState.get(e.state) ?? 0) + 1)
    const stateSummary = [...byState.entries()].map(([state, n]) => `${state}: ${n}`).join(", ") || "(none)"

    return [
      "<workflow-boss-context>",
      `You are the Boss of workflow run "${run.title}" (${run.id}), charter "${charter.name}".`,
      "You are the control plane. You do not write code or perform seat work yourself; you observe, unblock, and make final human-responsibility decisions at gates.",
      "",
      `Run status: ${run.status}. Budget: ${run.budget.used}/${run.budget.maxModelCalls || "unlimited"} model calls.`,
      `Entities by state: ${stateSummary}`,
      `Seats: ${run.seats.map((s) => `${s.seat}#${s.instance}(${s.status})`).join(", ")}`,
      "",
      pendingGates.length > 0
        ? `Pending gates requiring your decision:\n${pendingGates
            .map((g) => `- [${g.id}] ${g.gate} on entity ${g.entityID ?? "-"} — resolve with workflow_gate_resolve`)
            .join("\n")}`
        : "No gates currently need you.",
      "",
      "Tools: workflow_status (overview), workflow_entity_add (enqueue work), workflow_gate_resolve (decide a gate), workflow_run_control (pause/resume/cancel).",
      "</workflow-boss-context>",
    ].join("\n")
  }

  async function buildSeat(
    scopeID: string,
    run: WorkflowTypes.Run,
    charter: WorkflowTypes.Charter,
    binding: WorkflowRunSessionInfo,
  ): Promise<string> {
    const seat = binding.seat!
    const instance = binding.instance ?? 0
    const seatDef = charter.seats.find((s) => s.name === seat)
    const seatSessionID = WorkflowSeats.find(run, seat, instance)?.sessionID
    const entity = run.entities.find((e) => e.assignedSeat?.seat === seat && e.bindings.seatSessionID === seatSessionID)
    const allowedTransitions = charter.transitions.filter(
      (t) => t.trigger.kind === "intent" && t.trigger.allowedSeats.includes(seat),
    )

    const charterBody = await resolveSeatCharter(scopeID, seatDef)

    const lines: string[] = [
      "<workflow-seat-context>",
      `You are seat "${seat}#${instance}" in workflow run "${run.title}" (${run.id}), charter "${charter.name}".`,
    ]
    if (charterBody) {
      lines.push("", "Your standing charter (authoritative, survives compaction):", charterBody)
    }
    if (entity) {
      lines.push("", `Current entity: "${entity.title}" (${entity.id}) in state "${entity.state}".`)
      if (entity.description) lines.push(`Objective: ${entity.description}`)
      if (Object.keys(entity.bindings).length > 0) {
        lines.push(
          `Bindings: ${Object.entries(entity.bindings)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        )
      }
      const last = entity.submissions.at(-1)
      if (last) lines.push(`Last submission: [${last.kind}${last.verdict ? `/${last.verdict}` : ""}] ${last.summary}`)
    } else {
      lines.push("", "You have no entity assigned right now. Wait for a handoff.")
    }
    lines.push(
      "",
      "Your allowed transitions (your responsibility boundary):",
      ...allowedTransitions.map((t) => `- ${t.id}: ${t.from} → ${t.to}`),
      "",
      "Submit results with workflow_submit; declare a blocker with workflow_block. Never operate on another seat's entity.",
      "</workflow-seat-context>",
    )
    return lines.join("\n")
  }

  async function resolveSeatCharter(
    scopeID: string,
    seatDef: WorkflowTypes.SeatDef | undefined,
  ): Promise<string | undefined> {
    if (!seatDef) return undefined
    if (seatDef.charterNoteID) {
      const note = await NoteStore.getAny(scopeID, seatDef.charterNoteID).catch(() => undefined)
      if (note) return NoteMarkdown.toMarkdown(note.content)
    }
    return seatDef.charterPrompt?.trim() || undefined
  }
}
