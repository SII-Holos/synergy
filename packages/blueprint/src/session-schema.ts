import { z } from "zod"
export const WorkflowInfo = z.object({
  kind: z.literal("plan"),
})
export type WorkflowInfo = z.infer<typeof WorkflowInfo>
declare module "@ericsanchezok/synergy-harness/session/workflow-kind-registry" {
  interface WorkflowKinds {
    plan: WorkflowInfo
  }
}
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import { BlueprintLoopSources } from "./blueprint/source"
export const SuperPlanSessionInfo = z
  .object({
    runID: Identifier.schema("superplan_run"),
    role: z.enum(["planner", "node", "merge", "audit"]),
    nodeID: Identifier.schema("superplan_node").optional(),
    mergeID: Identifier.schema("superplan_merge").optional(),
  })
  .meta({ ref: "SessionSuperPlanInfo" })
export type SuperPlanSessionInfo = z.infer<typeof SuperPlanSessionInfo>

export const SessionBlueprintPhase = z.enum(["running", "auditing"])
export type SessionBlueprintPhase = z.infer<typeof SessionBlueprintPhase>
export const SessionFields = {
  superplan: SuperPlanSessionInfo.optional(),
  blueprint: z
    .object({
      loopID: z.string().optional(),
      source: z.string().optional(),
      loopRole: z.enum(["execution", "audit"]).optional(),
      phase: SessionBlueprintPhase.optional(),
    })
    .optional(),
}
type SessionShape = typeof SessionFields
declare module "@ericsanchezok/synergy-harness/session/types" {
  interface SessionExtensionShape extends SessionShape {}
  interface SessionCreationExtensions {
    superplan?: SuperPlanSessionInfo
  }
}
export function registerSessionSchema() {
  SessionSchemaRegistry.register("blueprint", {
    shape: SessionFields,
    projectionKey: () => JSON.stringify(BlueprintLoopSources.ids()),
    project(fields) {
      const value = fields.blueprint
      const source = value && typeof value === "object" && "source" in value ? value.source : undefined
      if (typeof source !== "string" || !BlueprintLoopSources.available(source)) delete fields.blueprint
    },
    navIdentity(input) {
      const blueprint = SessionFields.blueprint.safeParse(input.blueprint)
      return blueprint.success && blueprint.data ? { blueprint: blueprint.data } : undefined
    },
    normalizeImport(input, mode) {
      if (mode !== "transcript") {
        input.blueprint = undefined
        if (
          input.workflow &&
          typeof input.workflow === "object" &&
          "kind" in input.workflow &&
          input.workflow.kind === "plan"
        )
          input.workflow = undefined
      }
    },
  })
}
