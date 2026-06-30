import type {
  AssistantMessage,
  AttachmentPart,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@ericsanchezok/synergy-sdk/client"
import {
  isActiveMediaGenerationToolPart,
  isPromotedToolResultPart,
  primaryToolAttachments,
} from "./tool-result-presentation"

export type SessionTurnNarrativeItem =
  | {
      kind: "part"
      message: AssistantMessage
      part: TextPart | ReasoningPart
    }
  | {
      kind: "media-pending"
      message: AssistantMessage
      part: ToolPart
    }
  | {
      kind: "media-result"
      message: AssistantMessage
      part: ToolPart
      files: AttachmentPart[]
    }

export function narrativeKindForPart(part: PartType, working: boolean): SessionTurnNarrativeItem["kind"] | undefined {
  if (part.type === "text") return "part"
  if (part.type === "reasoning") return working ? "part" : undefined
  if (isActiveMediaGenerationToolPart(part)) return "media-pending"
  if (isPromotedToolResultPart(part)) return "media-result"
  return undefined
}

export function isSessionTurnNarrativePart(part: PartType, working: boolean): boolean {
  return narrativeKindForPart(part, working) !== undefined
}

export function collectSessionTurnNarrativeItems(
  messages: AssistantMessage[],
  partsByMessage: Record<string, PartType[] | undefined>,
  working: boolean,
): SessionTurnNarrativeItem[] {
  const items: SessionTurnNarrativeItem[] = []

  for (const message of messages) {
    const parts = partsByMessage[message.id] ?? []
    for (const part of parts) {
      const kind = narrativeKindForPart(part, working)
      if (!kind) continue

      if (kind === "media-pending") {
        items.push({ kind, message, part: part as ToolPart })
        continue
      }

      if (kind === "media-result") {
        const files = primaryToolAttachments(part)
        if (files.length === 0) continue
        items.push({ kind, message, part: part as ToolPart, files })
        continue
      }

      items.push({ kind, message, part: part as TextPart | ReasoningPart })
    }
  }

  return items
}
