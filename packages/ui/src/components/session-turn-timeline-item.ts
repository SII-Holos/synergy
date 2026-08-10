import type {
  AssistantMessage,
  AttachmentPart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@ericsanchezok/synergy-sdk/client"

export type SessionTurnTimelineItem =
  | {
      kind: "part"
      message: AssistantMessage
      part: TextPart | ToolPart | AttachmentPart | PartType
    }
  | {
      kind: "reasoning"
      message: AssistantMessage
      part: ReasoningPart
    }
  | {
      kind: "media-pending"
      message: AssistantMessage
      part: ToolPart
    }
  | {
      kind: "tool-attachments"
      message: AssistantMessage
      part: ToolPart
      files: AttachmentPart[]
    }
  | {
      kind: "compaction"
      message: MessageType
      part?: PartType
    }

export type SessionTurnTimelineVisualKind =
  | "text"
  | "reasoning"
  | "tool"
  | "attachment"
  | "media-pending"
  | "tool-attachments"
  | "compaction"

export function timelineVisualKind(item: SessionTurnTimelineItem): SessionTurnTimelineVisualKind {
  if (item.kind === "compaction") return "compaction"
  if (item.kind !== "part") return item.kind
  if (item.part.type === "tool") return "tool"
  if (item.part.type === "attachment") return "attachment"
  if (item.part.type === "compaction_recovery") return "compaction"
  return "text"
}

export function timelineItemStableKey(item: SessionTurnTimelineItem): string {
  if (item.kind === "compaction") return `compaction:${item.message.id}`
  return `${timelineVisualKind(item)}:${item.message.id}:${item.part.id}`
}
