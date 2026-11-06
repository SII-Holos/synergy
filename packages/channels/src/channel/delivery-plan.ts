import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { findReactionOnlyIntent, resolveReactionTarget } from "./reaction-only-runtime"
import { extractAssistantText, resolveFinalResponseText } from "./response-text"

export type ChannelDeliveryPlan = {
  rootID: string
  terminal: MessageV2.WithParts & { info: MessageV2.Assistant }
  messages: MessageV2.WithParts[]
  failed: boolean
} & ({ kind: "reply"; text: string } | { kind: "reaction"; reaction: string; messageId?: string })

export async function collectChannelTerminalInfos(input: { sessionID: string; rootID: string; signal?: AbortSignal }) {
  const infos = await SessionHistory.turnInfos(input).catch((error) => {
    if (error instanceof Storage.NotFoundError) return []
    throw error
  })
  return infos.filter(
    (info): info is MessageV2.Assistant => info.role === "assistant" && SessionProgress.isTerminalAssistant(info),
  )
}

export function planChannelDelivery(input: {
  rootID: string
  messages: MessageV2.WithParts[]
  terminalIDs?: ReadonlySet<string>
  replyToMessageId?: string
}): ChannelDeliveryPlan[] {
  const plans: ChannelDeliveryPlan[] = []
  let messages: MessageV2.WithParts[] = []
  let segment: MessageV2.WithParts[] = []
  for (const message of input.messages) {
    if (message.info.id !== input.rootID && message.info.rootID !== input.rootID) continue
    messages.push(message)
    if (message.info.role !== "assistant") continue
    segment.push(message)
    if (!SessionProgress.isTerminalAssistant(message.info)) continue
    const terminal = { ...message, info: message.info }
    const intent = findReactionOnlyIntent([terminal], input.rootID, message.info.id)
    if (!input.terminalIDs || input.terminalIDs.has(message.info.id)) {
      const base = { rootID: input.rootID, terminal, messages: [...messages], failed: !!message.info.error }
      if (intent)
        plans.push({
          ...base,
          kind: "reaction",
          reaction: intent.reaction,
          messageId: resolveReactionTarget(messages, input.rootID, input.replyToMessageId),
        })
      else {
        const transcript = new Map(segment.map((item) => [item.info.id, extractAssistantText(item.parts)]))
        const text = resolveFinalResponseText(transcript, terminal.parts) || (base.failed ? degradedReply(segment) : "")
        plans.push({ ...base, kind: "reply", text })
      }
    }
    if (intent) {
      const suppressed = new Set(segment.map((item) => item.info.id))
      messages = messages.filter((item) => !suppressed.has(item.info.id))
    }
    segment = []
  }
  return plans
}

export async function loadChannelDeliveryPlans(input: {
  sessionID: string
  rootID: string
  terminalIDs?: ReadonlySet<string>
  replyToMessageId?: string
  signal?: AbortSignal
}) {
  const messages = await SessionHistory.turnMessages(input)
  input.signal?.throwIfAborted()
  return planChannelDelivery({ ...input, messages })
}

function degradedReply(messages: MessageV2.WithParts[]): string {
  const titles = messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool" && part.state.status === "completed" ? [part.state.title ?? part.tool] : [],
    ),
  )
  if (!titles.length) return ""
  return [
    "⚠️ Response generation failed, but these tools completed successfully:",
    ...titles.map((title) => `- ${title}`),
    "\nReview the tool outputs above or try again later.",
  ].join("\n")
}
