import type { SessionMessageLoadState } from "@/context/session-message-loader"

export type SessionLoadView =
  | { type: "conversation" }
  | { type: "loading" }
  | { type: "delayed-loading" }
  | { type: "initial-error"; error: string }
  | { type: "empty" }
  | { type: "refreshing-empty" }
  | { type: "empty-error"; error: string }

type SessionLoadViewInput = {
  hasRenderableContent: boolean
  messages: ReadonlyArray<{ id: string }> | undefined
  load: SessionMessageLoadState
  delayed: boolean
}

export function hasSessionRenderableContent(input: {
  hasActiveMessage: boolean
  timelineCount: number
  pendingTimelineCount: number
  hasTransition: boolean
}) {
  return input.hasActiveMessage || input.timelineCount > 0 || input.pendingTimelineCount > 0 || input.hasTransition
}

export function sessionLoadView(input: SessionLoadViewInput): SessionLoadView {
  if (input.hasRenderableContent) return { type: "conversation" }

  const hasSnapshot = input.messages !== undefined || input.load.hasSnapshot
  if (input.load.phase === "error") {
    const error = input.load.error ?? "Couldn’t load conversation"
    return hasSnapshot ? { type: "empty-error", error } : { type: "initial-error", error }
  }

  if (hasSnapshot) {
    if (input.load.phase === "refreshing") return { type: "refreshing-empty" }
    return { type: "empty" }
  }

  if (input.delayed && input.load.phase === "loading") return { type: "delayed-loading" }
  return { type: "loading" }
}
