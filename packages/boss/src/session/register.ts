import { z } from "zod"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { WorkflowInfo } from "../session-schema"
import { WorkflowSessionService, WorkflowConflictError } from "./workflow"
import { SessionModePolicy as OwnerModePolicy } from "./tool-mode-policy"
export function registerSessions() {
  WorkflowKindRegistry.register({
    id: "boss",
    schema: WorkflowInfo,
    conflicts: [],
    inputSchema: z.object({ kind: z.literal("boss") }).strict(),
    managesLock: true,
    enable: ({ sessionID }) => WorkflowSessionService.enableBoss(sessionID),
  })
  SessionModePolicy.register({ id: "boss", visibility: OwnerModePolicy.visibility })
}
