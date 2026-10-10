import type { Info } from "@ericsanchezok/synergy-harness/session/types"
import type { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { isFeishuReactionOnlyAvailable } from "./provider/feishu/reaction-only"
const REACTION_ONLY_TOOL = "channel_reaction_only"
type FeishuChannelSession = Pick<Info, "endpoint" | "workflow"> & {
  endpoint: { kind: "channel"; channel: { type: string; accountId?: string } }
}
function isFeishuChannelSession(session?: Pick<Info, "endpoint" | "workflow">): session is FeishuChannelSession {
  return session?.endpoint?.kind === "channel" && session.endpoint.channel?.type === "feishu"
}
// Boss-role sessions deliver only through explicit channel_push calls: the
// foreground skips reaction delivery for boss routes and the outbound bridge
// skips boss sessions, so a reaction-only terminal would silently swallow the
// turn (no reaction, no content, no follow-up model round).
function isBossRoleSession(session?: { workflow?: { kind?: unknown; role?: unknown } }): boolean {
  return session?.workflow?.kind === "boss" && session.workflow?.role === "boss"
}
export function channelToolVisibility(input: {
  toolName: string
  session?: Pick<Info, "endpoint" | "workflow">
}): ToolDiagnostic | undefined {
  if (input.toolName === "response_card" && input.session?.endpoint?.kind !== "channel") {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool is only available in Channel sessions.`,
      metadata: { requiredEndpoint: "channel" },
    }
  }

  if (
    input.toolName === "github_deliver_fix" &&
    (input.session?.endpoint?.kind !== "channel" || input.session?.endpoint?.channel?.type !== "github")
  ) {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool is only available in GitHub Channel sessions.`,
      metadata: { requiredEndpoint: "github" },
    }
  }

  if (input.toolName === REACTION_ONLY_TOOL) {
    const session = input.session
    if (!isFeishuChannelSession(session) || isBossRoleSession(session)) {
      return {
        code: "tool_unavailable",
        toolName: input.toolName,
        message: `The "${input.toolName}" tool is only available in Feishu Channel sessions.`,
        metadata: { requiredEndpoint: "feishu" },
      }
    }
  }
}
/**
 * The account-config half of the reaction-only gate lives here rather than in
 * `channelToolVisibility` because `SessionModePolicy.visibility` is synchronous
 * and does not await its contributions: a returned Promise is truthy, so it
 * would hide the tool for every definition from every contribution source.
 * `availability` is awaited, and its diagnostic removes the tool from `visible`.
 */
export async function channelToolAvailability(input: {
  session?: Info
  agent: string
}): Promise<Map<string, ToolDiagnostic>> {
  const unavailable = new Map<string, ToolDiagnostic>([
    [
      REACTION_ONLY_TOOL,
      {
        code: "tool_unavailable",
        toolName: REACTION_ONLY_TOOL,
        message: `The "${REACTION_ONLY_TOOL}" tool requires the Feishu account's "reactionOnlyReply.enabled" to be true with "streaming" disabled.`,
        metadata: { requiredEndpoint: "feishu" },
      },
    ],
  ])
  if (!isFeishuChannelSession(input.session) || isBossRoleSession(input.session)) return new Map()
  try {
    const accountId = input.session.endpoint.channel.accountId
    const channel = (await Config.current()).channel?.feishu
    const account = channel && accountId ? channel.accounts[accountId] : undefined
    if (channel?.type !== "feishu" || !account) return unavailable
    return isFeishuReactionOnlyAvailable({ account, channel }) ? new Map() : unavailable
  } catch {
    return unavailable
  }
}
export function registerChannelToolPolicy() {
  SessionModePolicy.register({
    id: "channel",
    visibility: channelToolVisibility,
    availability: channelToolAvailability,
  })
}
