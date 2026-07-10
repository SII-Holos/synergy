import z from "zod"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { WorkflowRunStore, CharterStore, WorkflowTypes } from "../workflow-run"
import DESCRIPTION from "./workflow-status.txt"

const parameters = z.object({
  entityID: z.string().optional().describe("Focus on a single entity."),
})

export const WorkflowStatusTool = Tool.define("workflow_status", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const session = await Session.get(ctx.sessionID)
    const binding = session.workflowRun
    if (!binding) throw new Error("This session is not bound to a workflow run.")
    const run = await WorkflowRunStore.get(scopeID, binding.runID)

    if (params.entityID) {
      const entity = run.entities.find((e) => e.id === params.entityID)
      if (!entity) throw new Error(`Entity ${params.entityID} not found in run ${run.id}.`)
      return {
        title: `Entity ${entity.title}`,
        output: renderEntity(entity),
        metadata: { runID: run.id, entityID: entity.id, state: entity.state } as Record<string, any>,
      }
    }

    if (binding.role === "boss") {
      return {
        title: `Run ${run.title}`,
        output: await renderBossOverview(scopeID, run),
        metadata: { runID: run.id } as Record<string, any>,
      }
    }

    const entity = run.entities.find(
      (e) => e.assignedSeat?.seat === binding.seat && e.bindings.seatSessionID === ctx.sessionID,
    )
    return {
      title: entity ? `Your entity: ${entity.title}` : "No entity assigned",
      output: entity ? renderEntity(entity) : "You have no entity assigned right now. Wait for a handoff.",
      metadata: { runID: run.id, entityID: entity?.id } as Record<string, any>,
    }
  },
})

function renderEntity(entity: WorkflowTypes.Entity): string {
  const lines = [`Entity ${entity.id}: "${entity.title}"`, `State: ${entity.state}`]
  if (entity.blockedReason) lines.push(`Blocked: ${entity.blockedReason}`)
  if (Object.keys(entity.bindings).length > 0) {
    lines.push("Bindings:")
    for (const [k, v] of Object.entries(entity.bindings)) lines.push(`  ${k}: ${v}`)
  }
  if (entity.submissions.length > 0) {
    lines.push("Submissions:")
    for (const s of entity.submissions) lines.push(`  [${s.kind}${s.verdict ? `/${s.verdict}` : ""}] ${s.summary}`)
  }
  return lines.join("\n")
}

async function renderBossOverview(scopeID: string, run: WorkflowTypes.Run): Promise<string> {
  const charter = await CharterStore.getOrUndefined(scopeID, run.charterRef.id, run.charterRef.version).catch(
    () => undefined,
  )
  const byState = new Map<string, WorkflowTypes.Entity[]>()
  for (const e of run.entities) {
    const list = byState.get(e.state) ?? []
    list.push(e)
    byState.set(e.state, list)
  }
  const lines = [
    `Run ${run.id}: "${run.title}" — ${run.status}`,
    `Budget: ${run.budget.used}/${run.budget.maxModelCalls || "unlimited"}`,
    "",
    "Entities:",
  ]
  const order = charter?.states ?? [...byState.keys()]
  for (const state of order) {
    const entities = byState.get(state)
    if (!entities || entities.length === 0) continue
    lines.push(`  ${state}: ${entities.map((e) => `${e.title} (${e.id})`).join(", ")}`)
  }
  lines.push("", "Seats:")
  for (const s of run.seats) lines.push(`  ${s.seat}#${s.instance}: ${s.status}${s.entityID ? ` → ${s.entityID}` : ""}`)
  const pending = run.gates.filter((g) => g.status === "pending")
  if (pending.length > 0) {
    lines.push("", "Pending gates:")
    for (const g of pending) lines.push(`  [${g.id}] ${g.gate} on ${g.entityID ?? "-"}`)
  }
  return lines.join("\n")
}
