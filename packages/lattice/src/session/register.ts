import { z } from "zod"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { WorkflowInfo } from "../session-schema"
import { WorkflowSessionService, WorkflowConflictError } from "./workflow"
import { SessionModePolicy as OwnerModePolicy } from "./tool-mode-policy"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
export function registerSessions() {
  WorkflowKindRegistry.register({
    id: "lattice",
    schema: WorkflowInfo,
    conflicts: [],
    inputSchema: z
      .object({
        kind: z.literal("lattice"),
        mode: z.enum(["auto", "collaborative"]),
        maxModelCalls: z.number().int().min(0).optional(),
        goal: z.string().optional(),
      })
      .strict(),
    managesLock: true,
    enable: ({ sessionID, args }) =>
      WorkflowSessionService.enableLattice(sessionID, {
        kind: "lattice",
        ...z
          .object({
            mode: z.enum(["auto", "collaborative"]),
            maxModelCalls: z.number().optional(),
            goal: z.string().optional(),
          })
          .parse(args),
      }),
  })
  SessionExecutionContributions.register({
    id: "lattice",
    hasContinuation: (session) => session.workflow?.kind === "lattice",
    async abandonWorkflow(session) {
      if (session.workflow?.kind !== "lattice") return false
      await ScopeContext.provide({
        scope: session.scope,
        fn: async () => {
          const cancel = WorkflowPromptRegistry.get("lattice")?.cancel
          if (!cancel) throw new Error("Lattice cancellation is unavailable")
          await cancel(session.id)
        },
      })
      return true
    },
  })
  SessionModePolicy.register({
    id: "lattice",
    visibility: OwnerModePolicy.visibility,
    forcedGroups: (session) => (session?.workflow?.kind === "lattice" ? ["note"] : []),
  })
}
