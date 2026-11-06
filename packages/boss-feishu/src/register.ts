import { AgendaItemOwners } from "@ericsanchezok/synergy-agenda/agenda/item-owners"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { buildBossDeliveryHint } from "./prompt"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ChannelPushTool } from "./tools/channel-push"
import { ChannelFeishu } from "@ericsanchezok/synergy-channel-feishu/config-schema"
import { readConfig } from "@ericsanchezok/synergy-channels/config-schema"
import { BossRuntime } from "@ericsanchezok/synergy-boss/boss/boss-runtime"
import { registerChannelRouting, registerChannelDeliveryPolicy } from "@ericsanchezok/synergy-channels/channel/routing"
import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
export function registerBridge() {
  AgendaItemOwners.register("boss-feishu")
  SessionExecutionContributions.register({
    id: "boss-feishu",
    system(session, context) {
      if (
        session.workflow?.kind !== "boss" ||
        session.workflow.role !== "boss" ||
        session.endpoint?.kind !== "channel" ||
        !context.toolIDs.includes("channel_push")
      )
        return []
      const delivery = context.deliveryMetadata
      return [
        buildBossDeliveryHint(
          delivery?.channelPush
            ? { chatId: delivery.channelChatId, replyToMessageId: delivery.channelReplyToMessageId }
            : undefined,
        ),
      ]
    },
  })
  AgentPromptContributions.register("boss-feishu", [
    {
      requiredTools: ["channel_push"],
      render: (_agent, identity) =>
        identity?.owner === "boss"
          ? "Feishu source headers: inbound messages carry [群: chat | 发送者: sender | time] plus channel sender and chat metadata. Attribute requests and receipts to those recorded facts."
          : "",
    },
    {
      requiredTools: ["channel_push", "bash"],
      render: (_agent, identity) =>
        identity?.owner === "boss"
          ? "Feishu history requires authorized read access. Do not assume an external account is available or bypass missing authorization; request human help when access is unavailable."
          : "",
    },
  ])
  BossRuntime.registerAccountSource(readBossAccounts)
  registerChannelRouting("boss-feishu", async (context) => {
    if (context.channelType !== "feishu") return
    const sessionID = await BossRuntime.bossSessionForAccount(context.accountId)
    if (!sessionID) return
    const sender = context.senderName?.trim() || context.senderId
    const chat = context.chatName?.trim() || context.chatId
    const time = new Date(context.timestamp).toLocaleString("zh-CN", { hour12: false })
    return {
      sessionID,
      scopeKey: "boss",
      interaction: SessionInteraction.interactive("boss"),
      preserveChatName: true,
      replyToMessageId: context.messageId,
      textPrefix: `[群: ${chat} | 发送者: ${sender} | ${time}]`,
      delivery: "explicit",
    }
  })
  registerChannelDeliveryPolicy(
    "boss-feishu",
    (session) => session.workflow?.kind !== "boss" || session.workflow.role !== "boss",
  )
  ToolRegistry.registerToolProvider("boss-feishu", () => [ChannelPushTool])
  SessionModePolicy.register({
    id: "boss-feishu",
    visibility({ toolName, session }) {
      if (
        toolName === "channel_push" &&
        (session?.endpoint?.kind !== "channel" || session.workflow?.kind !== "boss" || session.workflow.role !== "boss")
      )
        return { code: "tool_unavailable", toolName, message: "The channel_push tool requires a Boss Channel session." }
    },
  })
  AgentPermissionContributions.register("boss-feishu", {
    base: (agent, identity) => (identity.owner === "boss" ? PermissionNext.fromConfig({ channel_push: "allow" }) : []),
  })
  RuntimeReloadContributions.register({
    id: "boss-feishu",
    async configChanged(change) {
      if (
        change.scope === "global" &&
        (change.changedFields.includes("channel") || change.changedFields.includes("boss"))
      )
        await BossRuntime.sync(change.config.boss?.enabled === true)
    },
  })
}

export const readBossAccounts = async () =>
  Object.values((await readConfig()).channel ?? {})
    .flatMap((channel) => {
      const parsed = ChannelFeishu.safeParse(channel)
      return parsed.success ? [parsed.data] : []
    })
    .flatMap((channel) =>
      Object.entries(channel.accounts).map(([id, account]) => ({
        id,
        enabled: account.enabled !== false,
        hasProjectDirectory: Boolean(account.projectDir),
      })),
    )
