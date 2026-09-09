import "../session-schema"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionRecoveryContributions } from "@ericsanchezok/synergy-harness/session/recovery-contributions"
import { SessionModePolicy as CoreModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { SessionModePolicy, workflowToolAvailability } from "./tool-mode-policy"
import { WorkflowSessionService, WorkflowConflictError } from "./workflow"
import { SessionBlueprintState } from "./blueprint-state"
import { isActiveLightLoopWorkflow } from "./light-loop-state"
import { WorkflowRecovery } from "./recovery"
import { genericPlan, synergyPlan, synergyMaxPlan } from "./plan-wrapper"
import PLAN from "./prompt/plan.txt"
import PLAN_SYNERGY from "./prompt/plan-synergy.txt"
import PLAN_SYNERGY_MAX from "./prompt/plan-synergy-max.txt"
import { z } from "zod"

export function registerWorkflowSessions() {
  for (const kind of ["plan", "lightloop", "lattice", "boss"] as const) {
    WorkflowKindRegistry.register({
      id: kind,
      managesLock: true,
      conflicts: ["plan", "lightloop", "lattice", "boss"],
      async enable({ sessionID, args }) {
        if (kind === "plan") return WorkflowSessionService.enablePlan(sessionID)
        if (kind === "boss") return WorkflowSessionService.enableBoss(sessionID)
        if (kind === "lightloop")
          return WorkflowSessionService.startLightloop(sessionID, z.string().parse(args.instructions))
        return WorkflowSessionService.enableLattice(sessionID, {
          kind,
          ...z
            .object({
              mode: z.enum(["auto", "collaborative"]),
              maxModelCalls: z.number().optional(),
              goal: z.string().optional(),
            })
            .parse(args),
        })
      },
    })
  }
  WorkflowPromptRegistry.register({
    kind: "plan",
    buildSystem(_session, ctx) {
      const parts = [PLAN.trim()]
      if (ctx.agentName === "synergy") parts.push(PLAN_SYNERGY.trim())
      if (ctx.agentName === "synergy-max") parts.push(PLAN_SYNERGY_MAX.trim())
      return parts
    },
    projectUserMessage(query, agentName) {
      return (agentName === "synergy" ? synergyPlan : agentName === "synergy-max" ? synergyMaxPlan : genericPlan)(query)
    },
    isActive: async () => false,
  })
  SessionExecutionContributions.register({
    id: "workflows",
    async isActive(session) {
      if (isActiveLightLoopWorkflow(session.workflow)) return true
      const loop = session.blueprint?.loopID
        ? await SessionBlueprintState.getLoop(session.scope.id, session.blueprint.loopID)
        : undefined
      return !!loop && SessionBlueprintState.isActiveStatus(loop.status)
    },
    hasContinuation(session) {
      return (
        !!session.blueprint?.loopID ||
        session.workflow?.kind === "lattice" ||
        isActiveLightLoopWorkflow(session.workflow)
      )
    },
    async assertWorkflowAllowed(session, kind) {
      const loop = session.blueprint?.loopID
        ? await SessionBlueprintState.getLoop(session.scope.id, session.blueprint.loopID)
        : undefined
      if (loop && SessionBlueprintState.isActiveStatus(loop.status))
        throw new WorkflowConflictError("blueprint_loop", `Cannot enable ${kind} while a BlueprintLoop is active.`)
    },
    async system(session, ctx) {
      const blueprint = session.blueprint
      if (!blueprint?.loopID) return []
      const loop = await SessionBlueprintState.getLoop(session.scope.id, blueprint.loopID)
      return loop
        ? [
            SessionBlueprintState.buildLoopContext({
              loop,
              isAuditSession: blueprint.loopRole === "audit" || session.id === loop.auditSessionID,
              agentName: ctx.agentName,
            }),
          ]
        : []
    },
    async archive(session) {
      return {
        blueprint: session.blueprint?.loopID
          ? await SessionBlueprintState.getLoop(session.scope.id, session.blueprint.loopID)
          : undefined,
      }
    },
  })
  SessionRecoveryContributions.register({
    id: "workflows",
    scopes: () => WorkflowRecovery.scopeIDsForRuntimeRecovery(),
    reconcile: WorkflowRecovery.reconcileRuntimeScope,
    resume: WorkflowRecovery.resumePendingStopRequests,
    statuses: WorkflowRecovery.recoverableStatuses,
  })
  CoreModePolicy.register({
    id: "workflows",
    visibility: SessionModePolicy.visibility,
    evaluateCall: SessionModePolicy.evaluateCall,
    unavailable: (input) =>
      SessionModePolicy.isPlan(input.session) ? SessionModePolicy.unavailable(input) : undefined,
    availability: workflowToolAvailability,
    forcedGroups: (session) =>
      session?.workflow?.kind === "plan" || session?.workflow?.kind === "lattice" || session?.blueprint?.loopID
        ? ["note"]
        : [],
  })
}
