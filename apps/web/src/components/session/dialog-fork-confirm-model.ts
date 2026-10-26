import type {
  ProjectDirectories,
  SessionWorkspace,
  SessionWorkspaceSelection,
  TextPart,
} from "@ericsanchezok/synergy-sdk"
import { isSystemPart } from "@ericsanchezok/synergy-ui/user-message-utils"

/** Pure presentation helpers for the fork-confirm dialog, kept UI-free for unit testing. */

export interface ForkConfirmMessage {
  id: string
  time?: { created: number; completed?: number }
}

export function computeForkCounts(allMessages: { id: string; role: string }[], targetId?: string) {
  const idx =
    targetId === undefined ? allMessages.length - 1 : allMessages.findIndex((message) => message.id === targetId)
  if (idx < 0) return { userMessages: 0, assistantReplies: 0 }
  const copied = allMessages.slice(0, idx + 1)
  return {
    userMessages: copied.filter((message) => message.role === "user").length,
    assistantReplies: copied.filter((message) => message.role === "assistant").length,
  }
}

export type ForkWorkspaceChoice = {
  id: "main" | "create" | "current"
  kind: "main" | "create" | "worktree" | "workspace" | "none"
  path?: string
  workspace: SessionWorkspaceSelection
}

export function forkWorkspaceChoices(source: SessionWorkspace | null, directories?: ProjectDirectories) {
  const main = directories?.folders.find(
    (folder) => folder.workspaceID === directories.mainWorkspaceID && folder.available,
  )
  const choices: ForkWorkspaceChoice[] = []
  if (main) {
    choices.push({
      id: "main",
      kind: "main",
      path: main.path,
      workspace: { mode: "workspace", workspaceID: main.workspaceID, workspaceGeneration: main.generation },
    })
    if (main.git)
      choices.push({ id: "create", kind: "create", workspace: { mode: "create", sourceWorkspaceID: main.workspaceID } })
  }
  if (!main || source?.id !== main.workspaceID) {
    choices.push({
      id: "current",
      kind: !source ? "none" : source.type === "git_worktree" ? "worktree" : "workspace",
      path: source?.path,
      workspace: { mode: source ? "current" : "none" },
    })
  }
  return choices
}

/** Which ICU branch summarizes the copied message/reply counts. */
export function copiedSummaryKind(counts: { userMessages: number; assistantReplies: number }) {
  if (counts.userMessages > 0 && counts.assistantReplies > 0) return "both" as const
  if (counts.userMessages > 0) return "messages" as const
  if (counts.assistantReplies > 0) return "replies" as const
  return "other" as const
}

/** Extract a short user-visible text preview from the first non-system text part. */
export function forkReplyPreview(
  parts: readonly { type: string; text?: string; origin?: string; synthetic?: boolean }[],
): string | undefined {
  for (const part of parts) {
    if (part.type !== "text") continue
    if (isSystemPart(part as unknown as Pick<TextPart, "type" | "origin" | "synthetic">)) continue
    const trimmed = part.text?.trim()
    if (!trimmed) continue
    return trimmed.length <= 96 ? trimmed : `${trimmed.slice(0, 95)}\u2026`
  }
  return undefined
}
