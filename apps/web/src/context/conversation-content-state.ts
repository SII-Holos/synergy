import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

export type ConversationContentState = {
  part: Record<string, Part[]>
  partSummary: Record<string, SessionPartSummary[]>
  partPage: Record<string, unknown>
  partVersion: Record<string, string>
}

export function clearConversationContent(state: ConversationContentState, messageID: string) {
  for (const part of state.partSummary[messageID] ?? []) delete state.partVersion[part.id]
  for (const part of state.part[messageID] ?? []) delete state.partVersion[part.id]
  delete state.part[messageID]
  delete state.partSummary[messageID]
  delete state.partPage[messageID]
}
