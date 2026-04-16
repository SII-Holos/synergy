import type { Message } from "@ericsanchezok/synergy-sdk"
import type { TextPart } from "@ericsanchezok/synergy-sdk/client"
import { DateTime } from "luxon"

export type HolosSender = "me" | "my-agent" | "peer" | "peer-agent"

export type HolosBubbleGroup = {
  key: string
  sender: HolosSender
  messages: Message[]
}

export function classifyHolosSender(message: Message): HolosSender {
  const meta = message.metadata as Record<string, unknown> | undefined
  const holosMeta = meta?.holos as { inbound?: boolean } | undefined
  const isInbound = message.role === "user" && holosMeta?.inbound === true
  const source = meta?.source as string | undefined

  if (isInbound) {
    return source === "agent" ? "peer-agent" : "peer"
  }
  return source === "agent" ? "my-agent" : "me"
}

export function isHolosOutbound(sender: HolosSender): boolean {
  return sender === "me" || sender === "my-agent"
}

export function groupHolosMessages(messages: Message[]): HolosBubbleGroup[] {
  const groups: HolosBubbleGroup[] = []
  for (const message of messages) {
    const sender = classifyHolosSender(message)
    const last = groups[groups.length - 1]
    if (last && last.sender === sender) {
      last.messages.push(message)
    } else {
      groups.push({ key: message.id, sender, messages: [message] })
    }
  }
  return groups
}

export function formatHolosMessageTime(ms: number): string {
  return DateTime.fromMillis(ms).toFormat("HH:mm")
}

export function extractHolosText(parts: Array<{ type: string; [key: string]: unknown }>): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part as TextPart).text)
    .join("\n")
}

export function holosSenderLabel(sender: HolosSender, contactName: string, myName: string): string {
  switch (sender) {
    case "me":
      return myName || "You"
    case "my-agent":
      return "Your Agent"
    case "peer":
      return contactName
    case "peer-agent":
      return `${contactName}'s Agent`
  }
}
