import z from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"

export const SuperPlanSessionInfo = z
  .object({
    runID: Identifier.schema("superplan_run"),
    role: z.enum(["planner", "node", "merge", "audit"]),
    nodeID: Identifier.schema("superplan_node").optional(),
    mergeID: Identifier.schema("superplan_merge").optional(),
  })
  .meta({ ref: "SessionSuperPlanInfo" })
export type SuperPlanSessionInfo = z.infer<typeof SuperPlanSessionInfo>

export const WorkflowInfo = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("plan"),
    }),
    z.object({
      kind: z.literal("lightloop"),
      instructions: z.string(),
      status: z
        .enum(["running", "reviewing", "completed", "failed", "cancelled", "timed_out", "iteration_exhausted"])
        .optional(),
      executionAgent: z.string().optional(),
      reviewAgent: z.string().optional(),
      pluginOwner: z
        .object({
          pluginId: z.string(),
          pluginGeneration: z.string(),
          scopeId: z.string(),
          correlationId: z.string().optional(),
        })
        .optional(),
      budget: z
        .object({
          maxRuntimeMs: z.number().int().positive(),
          maxIterations: z.number().int().positive(),
        })
        .optional(),
      deadlineAt: z.number().positive().optional(),
      terminalError: z.string().optional(),
      terminalHookDeliveredAt: z.number().optional(),
      terminalHookError: z.string().optional(),
      reviewTools: z.record(z.string(), z.boolean()).optional(),
      stopRequest: z
        .object({
          summary: z.string(),
          completed: z.array(z.string()).optional(),
          evidence: z.array(z.string()).optional(),
          remaining: z.array(z.string()).optional(),
          requestedAt: z.number(),
          requesterSessionID: z.string(),
          requesterMessageID: z.string(),
          reviewTaskID: z.string().optional(),
          reviewSessionID: z.string().optional(),
          reviewToolRecoveryAttempts: z.number().int().nonnegative().optional(),
        })
        .optional(),
      review: z
        .object({
          attempts: z.number(),
          lastReason: z.string().optional(),
          lastReviewedAt: z.number().optional(),
        })
        .optional(),
    }),
    z.object({
      kind: z.literal("lattice"),
      runID: z.string(),
      mode: z.enum(["auto", "collaborative"]),
    }),
    z.object({
      kind: z.literal("boss"),
      role: z.enum(["boss", "worker"]),
      workerRole: z.string().optional(),
      rootID: z.string().optional(),
      instructions: z.string().optional(),
    }),
    z
      .object({
        kind: z.literal("extension"),
        extension: z
          .object({
            kind: z.string().min(1),
            payload: z.unknown().optional(),
          })
          .meta({ ref: "WorkflowExtension" }),
      })
      .meta({ ref: "SessionWorkflowExtension" }),
  ])
  .meta({ ref: "SessionWorkflowInfo" })
export type WorkflowInfo = z.infer<typeof WorkflowInfo>

export const SessionFields = {
  agenda: z.object({ itemID: z.string() }).optional(),
  superplan: SuperPlanSessionInfo.optional(),
  blueprint: z
    .object({ loopID: z.string().optional(), loopRole: z.enum(["execution", "audit"]).optional() })
    .optional(),
  workflow: WorkflowInfo.optional(),
}

type SessionShape = typeof SessionFields
interface CreationFields {
  agenda?: z.infer<typeof SessionFields.agenda>
  superplan?: SuperPlanSessionInfo
}

declare module "@ericsanchezok/synergy-harness/session/types" {
  interface SessionExtensionShape extends SessionShape {}
  interface SessionCreationExtensions extends CreationFields {}
}

const contribution: SessionSchemaRegistry.Contribution = {
  shape: SessionFields,
  isBackground: (input) => Boolean(input.agenda),
  defaultControlProfile: (input) => (input.agenda ? "autonomous" : undefined),
  async created(input) {
    const agenda = SessionFields.agenda.parse(input.agenda)
    if (!agenda) return
    const sessionID = z.string().parse(input.id)
    const scope = z.object({ id: z.string() }).parse(input.scope)
    await Storage.write(StoragePath.agendaSession(agenda.itemID, sessionID), { sessionID, scopeID: scope.id })
  },
  normalizeImport(input, mode) {
    if (mode === "transcript") input.agenda = undefined
    else {
      input.workflow = undefined
      input.blueprint = undefined
    }
  },
}
export function registerSessionSchema() {
  SessionSchemaRegistry.register("workflows", contribution)
}
registerSessionSchema()
