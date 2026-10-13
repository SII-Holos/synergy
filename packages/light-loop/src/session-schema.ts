import { z } from "zod"
export const WorkflowInfo = z.object({
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
})
export type WorkflowInfo = z.infer<typeof WorkflowInfo>
declare module "@ericsanchezok/synergy-harness/session/workflow-kind-registry" {
  interface WorkflowKinds {
    lightloop: WorkflowInfo
  }
}
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
export function registerSessionSchema() {
  SessionSchemaRegistry.register("light-loop", {
    shape: {},
    normalizeImport(input, mode) {
      if (
        mode !== "transcript" &&
        input.workflow &&
        typeof input.workflow === "object" &&
        "kind" in input.workflow &&
        input.workflow.kind === "lightloop"
      )
        input.workflow = undefined
    },
  })
}
