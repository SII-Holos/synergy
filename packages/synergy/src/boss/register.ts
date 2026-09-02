import { Config } from "../config/config"
import { ContinuationKernel } from "../session/continuation-kernel"
import type { Info as SessionInfo } from "../session/types"
import { WorkflowPromptRegistry } from "../session/workflow-prompt-registry"
import { ToolRegistry } from "../tool/registry"
import { BossContinuationPolicy } from "./boss-continuation"
import {
  DEFAULT_IDENTITY_TEXT,
  buildBossDeliveryHint,
  buildRuntimeBossContext,
  buildWorkerContext,
  renderBossTree,
} from "./boss-prompt"
import { BossService } from "./boss"
import { BossSpawnTool } from "./tools/boss-spawn"
import { BossAssignTool } from "./tools/boss-assign"
import { BossReportTool } from "./tools/boss-report"
import { BossStatusTool } from "./tools/boss-status"
import { BossCancelTool } from "./tools/boss-cancel"
import { BossProjectTool } from "./tools/boss-project"

/**
 * Boss domain registration (H1 continuation provider + H2 prompt
 * contribution + domain tools). Loaded through src/product-registration.ts.
 */
let registered = false

export function registerBossDomain(): void {
  if (registered) return
  registered = true

  ContinuationKernel.registerProvider("boss", () => [BossContinuationPolicy])

  WorkflowPromptRegistry.register({
    kind: "boss",
    controlSources: ["boss_report"],
    async buildSystem(session: SessionInfo, ctx: WorkflowPromptRegistry.PromptContext) {
      const workflow = session.workflow
      if (workflow?.kind !== "boss") return []
      if (workflow.role !== "boss") return [buildWorkerContext(session)]

      const configuredIdentity = (await Config.current().catch(() => undefined))?.experimental?.boss_identity_text
      const identityText = configuredIdentity?.trim() || DEFAULT_IDENTITY_TEXT
      const parts = [
        buildRuntimeBossContext(session, {
          identityText,
          instructions: workflow.instructions,
        }),
      ]

      // Tell the boss whether this turn's reply auto-delivers back to the
      // originating Feishu message, so it neither duplicates with
      // channel_push nor misses a receipt. Treat delivery as automatic only
      // when a single unambiguous reply anchor exists; conflicting anchors
      // (multiple Feishu requests in one turn) cannot auto-deliver, so the
      // boss must use channel_push explicitly per requester.
      const bossDeliveryMetadata = ctx.deliveryMetadata
      const autoDelivers =
        bossDeliveryMetadata?.channelPush === true && typeof bossDeliveryMetadata.channelReplyToMessageId === "string"
      parts.push(
        buildBossDeliveryHint(
          autoDelivers
            ? { auto: true, replyToMessageId: bossDeliveryMetadata!.channelReplyToMessageId }
            : { auto: false },
        ),
      )

      const tree = await BossService.status(session.id).catch(() => undefined)
      if (tree) {
        parts.push(`<boss-tree>\n${renderBossTree(tree)}\n</boss-tree>`)
      }
      return parts
    },
    projectUserMessage(query: string, agentName: string) {
      const header =
        agentName === "synergy"
          ? "You are synergy in the Boss Mode workflow."
          : agentName === "synergy-max"
            ? "You are synergy-max in the Boss Mode workflow."
            : "You are in the Boss Mode workflow."
      const discipline =
        agentName === "synergy" || agentName === "synergy-max"
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
