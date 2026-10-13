import { z } from "zod"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { WorkflowInfo } from "../session-schema"
import { WorkflowSessionService, WorkflowConflictError } from "./workflow"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { genericPlan, generalPlan, codingPlan } from "./plan-wrapper"
import PLAN from "./prompt/plan.txt"
import PLAN_GENERAL from "./prompt/plan-general.txt"
import PLAN_CODING from "./prompt/plan-coding.txt"
import { SessionBlueprintState } from "./blueprint-state"
import { WorkflowRecovery } from "./recovery"
import { SessionRecoveryContributions } from "@ericsanchezok/synergy-harness/session/recovery-contributions"
import { BlueprintToolAccess } from "../blueprint/tool-access"
import { BlueprintLoopSources } from "../blueprint/source"
import { BlueprintLoopStore } from "../blueprint/loop-store"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

async function sourceAvailable(scopeID: string, loopID: string) {
  try {
    const loop = await BlueprintLoopStore.getStored(scopeID, loopID)
    return BlueprintLoopSources.available(loop.source)
  } catch (error) {
    if (error instanceof Storage.NotFoundError) return false
    throw error
  }
}

export function registerSessions() {
  SessionExecutionOwners.register("blueprint", {
    allowsSession: (session) =>
      session.blueprint?.loopID ? sourceAvailable(session.scope.id, session.blueprint.loopID) : true,
    allowsMessage: (session, message) => {
      const loopID = message.metadata?.loopID
      return typeof loopID === "string" && !!loopID && sourceAvailable(session.scope.id, loopID)
    },
  })
  WorkflowKindRegistry.register({
    id: "plan",
    schema: WorkflowInfo,
    conflicts: [],
    inputSchema: WorkflowInfo.strict(),
    managesLock: true,
    enable: ({ sessionID }) => WorkflowSessionService.enablePlan(sessionID),
  })
  WorkflowPromptRegistry.register({
    kind: "plan",
    buildSystem(_session, ctx) {
      const parts = [PLAN.trim()]
      if (ctx.agentName === PrimaryAgentIdentity.names.general)
        parts.push(PrimaryAgentIdentity.render("general", PLAN_GENERAL.trim()))
      if (ctx.agentName === PrimaryAgentIdentity.names.coding)
        parts.push(PrimaryAgentIdentity.render("coding", PLAN_CODING.trim()))
      return parts
    },
    projectUserMessage(query, agentName) {
      return (
        agentName === PrimaryAgentIdentity.names.general
          ? generalPlan
          : agentName === PrimaryAgentIdentity.names.coding
            ? codingPlan
            : genericPlan
      )(query)
    },
    isActive: async () => false,
  })
  SessionExecutionContributions.register({
    id: "blueprint",
    async isActive(session) {
      const loop = session.blueprint?.loopID
        ? await SessionBlueprintState.getLoop(session.scope.id, session.blueprint.loopID)
        : undefined
      return !!loop && SessionBlueprintState.isActiveStatus(loop.status)
    },
    async abandonWorkflow(session) {
      const loopID = session.blueprint?.loopID
      if (!loopID) return false
      const loop = await SessionBlueprintState.getLoop(session.scope.id, loopID)
      if (!loop || !SessionBlueprintState.isActiveStatus(loop.status)) return false
      await WorkflowRecovery.abandonLoop(session.scope.id, loopID)
      return true
    },
    hasContinuation: (session) =>
      !!session.blueprint?.loopID &&
      !!session.blueprint.source &&
      BlueprintLoopSources.available(session.blueprint.source),
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
    id: "blueprint",
    scopes: () => WorkflowRecovery.scopeIDsForRuntimeRecovery(),
    reconcile: WorkflowRecovery.reconcileRuntimeScope,
    statuses: WorkflowRecovery.recoverableStatuses,
  })
  SessionModePolicy.register({
    id: "blueprint",
    forcedGroups: (session) =>
      session?.workflow?.kind === "plan" ||
      (session?.blueprint?.loopID &&
        session.blueprint.source &&
        BlueprintLoopSources.available(session.blueprint.source))
        ? ["note"]
        : [],
    async availability(input) {
      const result = new Map()
      const session = input.session
      if (!session?.id || !(await BlueprintToolAccess.canStopLoop(session)))
        result.set(
          "blueprint_loop_stop",
          SessionModePolicy.unavailable({
            toolName: "blueprint_loop_stop",
            reason: "blueprint_loop_required",
            session,
          }),
        )
      if (!session?.id || !(await BlueprintToolAccess.canUseReviewTools(input.agent, session.id, session)))
        for (const toolName of ["blueprint_loop_approve", "blueprint_loop_reject"])
          result.set(toolName, SessionModePolicy.unavailable({ toolName, reason: "permission", session }))
      return result
    },
    unavailable(input) {
      if (!["audit_only", "blueprint_loop_required"].includes(input.reason)) return
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        message:
          input.reason === "audit_only"
            ? `The "${input.toolName}" tool is only available to the active Blueprint audit session.`
            : `The "${input.toolName}" tool requires an active BlueprintLoop session.`,
        metadata: input.metadata,
      }
    },
  })
}
