import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ContinuationKernel } from "@ericsanchezok/synergy-harness/session/continuation-kernel"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { BossContinuationPolicy } from "./boss-continuation"
import { buildRuntimeBossContext, buildWorkerContext, renderBossTree } from "./boss-prompt"
import { resolveBossPersona } from "./persona"
import { BossService } from "./boss"
import { BossSpawnTool } from "./tools/boss-spawn"
import { BossAssignTool } from "./tools/boss-assign"
import { BossReportTool } from "./tools/boss-report"
import { BossStatusTool } from "./tools/boss-status"
import { BossCancelTool } from "./tools/boss-cancel"
import { BossProjectTool } from "./tools/boss-project"

/**
 * Boss domain registration (H1 continuation provider + H2 prompt
 * contribution + domain tools). Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerBossDomain(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ContinuationKernel.registerProvider("boss", () => [BossContinuationPolicy])

  WorkflowPromptRegistry.register({
    kind: "boss",
    controlSources: ["boss_report"],
    async buildSystem(session: SessionInfo, ctx: WorkflowPromptRegistry.PromptContext) {
      const workflow = session.workflow
      if (workflow?.kind !== "boss") return []
      if (workflow.role !== "boss") return [buildWorkerContext(session)]

      const persona = await resolveBossPersona()
      const parts = [
        buildRuntimeBossContext({
          identityText: persona.identityText,
          reportStyle: persona.reportStyle,
          instructions: workflow.instructions,
        }),
      ]
      const tree = await BossService.status(session.id).catch(() => undefined)
      if (tree) {
        parts.push(`<boss-tree>\n${renderBossTree(tree)}\n</boss-tree>`)
      }
      return parts
    },
    projectUserMessage(query: string, agentName: string) {
      const header =
        agentName === PrimaryAgentIdentity.names.general
          ? `You are ${PrimaryAgentIdentity.names.general} in the Boss Mode workflow.`
          : agentName === PrimaryAgentIdentity.names.coding
            ? `You are ${PrimaryAgentIdentity.names.coding} in the Boss Mode workflow.`
            : "You are in the Boss Mode workflow."
      const discipline =
        agentName === PrimaryAgentIdentity.names.general || agentName === PrimaryAgentIdentity.names.coding
          ? "You are the boss of a worker tree. Decide whether to answer directly, delegate to a specialist worker (boss_spawn / boss_assign), monitor progress (boss_status), or cancel work (boss_cancel). Summarize results back to the human."
          : "You are the boss: you decide, delegate, monitor, and summarize. Route this request yourself — answer directly or assign it to a worker."
      return ["<boss-user-request>", header, discipline, "", "User request:", query, "</boss-user-request>"].join("\n")
    },
  })

  ToolRegistry.registerToolProvider("boss", () => [
    BossSpawnTool,
    BossAssignTool,
    BossReportTool,
    BossStatusTool,
    BossCancelTool,
    BossProjectTool,
  ])
}
