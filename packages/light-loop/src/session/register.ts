import { z } from "zod"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { WorkflowInfo } from "../session-schema"
import { WorkflowSessionService } from "./workflow"
import { isActiveLightLoopWorkflow } from "./light-loop-state"
export function registerSessions() {
  WorkflowKindRegistry.register({
    id: "lightloop",
    schema: WorkflowInfo,
    conflicts: [],
    update: ({ sessionID, args }) =>
      WorkflowSessionService.updateLightloopInstructions(sessionID, z.string().parse(args.instructions)),
    inputSchema: z.object({ kind: z.literal("lightloop"), instructions: z.string().trim().min(1) }).strict(),
    managesLock: true,
    activeForPresentation: (session) => isActiveLightLoopWorkflow(session.workflow),
    enable: ({ sessionID, args }) =>
      WorkflowSessionService.startLightloop(sessionID, z.string().parse(args.instructions)),
  })
  SessionExecutionContributions.register({
    id: "light-loop",
    isActive: async (session) => isActiveLightLoopWorkflow(session.workflow),
    hasContinuation: (session) => isActiveLightLoopWorkflow(session.workflow),
    async abandonWorkflow(session) {
      if (!isActiveLightLoopWorkflow(session.workflow)) return false
      await WorkflowSessionService.cancelLightloop(session.id)
      return true
    },
  })
  SessionModePolicy.register({
    id: "light-loop",
    async availability(input) {
      const result = new Map()
      const session = input.session
      if (!isActiveLightLoopWorkflow(session?.workflow))
        result.set(
          "loop_stop",
          SessionModePolicy.unavailable({ toolName: "loop_stop", reason: "light_loop_required", session }),
        )
      return result
    },
    unavailable(input) {
      if (input.reason !== "light_loop_required") return
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        message: `The "${input.toolName}" tool requires an active Light Loop session.`,
        metadata: input.metadata,
      }
    },
  })
}
