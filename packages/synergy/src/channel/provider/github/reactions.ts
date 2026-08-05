/**
 * GitHub reactions are addressed differently depending on the target:
 * - comments use `POST /repos/{o}/{r}/issues/comments/{id}/reactions`
 * - the issue/PR body uses `POST /repos/{o}/{r}/issues/{n}/reactions`
 *
 * The channel core only passes `messageId` to `addReaction`, so the poll loop
 * records both kinds of targets here and the provider looks them up when
 * reacting. Numeric comment IDs map to comment reactions; synthetic event
 * message IDs (`issue-*`, `pr-opened-*`, ...) map to body reactions.
 *
 * Both maps are bounded (LRU-style, oldest dropped).
 */
const MAX_MAP_ENTRIES = 2_000
const commentToChat = new Map<string, string>()
const bodyToChat = new Map<string, string>()

export function registerCommentChat(commentId: string, chatId: string): void {
  setBounded(commentToChat, commentId, chatId)
}

/** Register a synthetic event message ID (issue/PR body reaction target). */
export function registerBodyChat(messageId: string, chatId: string): void {
  setBounded(bodyToChat, messageId, chatId)
}

export function lookupCommentChat(commentId: string): string | undefined {
  return commentToChat.get(commentId)
}

export function lookupBodyChat(messageId: string): string | undefined {
  return bodyToChat.get(messageId)
}

export function resetCommentChatMap(): void {
  commentToChat.clear()
  bodyToChat.clear()
}

export function isNumericCommentId(value: string): boolean {
  return /^[1-9]\d*$/.test(value)
}

function setBounded(map: Map<string, string>, key: string, value: string): void {
  map.set(key, value)
  if (map.size > MAX_MAP_ENTRIES) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
}
