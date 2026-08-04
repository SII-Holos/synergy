/**
 * GitHub reactions are addressed as
 * `POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions`, so the
 * provider needs the repository for a comment ID. The channel core only passes
 * `messageId` to `addReaction`, so the poll loop records the comment → chatId
 * mapping here and the provider looks it up when reacting.
 *
 * The map is bounded (LRU-style, oldest dropped) and keyed by numeric comment
 * ID. Synthetic event message IDs (issue-*, pr-*) are never registered, so
 * reactions on those are skipped.
 */
const MAX_COMMENT_MAP_ENTRIES = 2_000
const commentToChat = new Map<string, string>()

export function registerCommentChat(commentId: string, chatId: string): void {
  commentToChat.set(commentId, chatId)
  if (commentToChat.size > MAX_COMMENT_MAP_ENTRIES) {
    const oldest = commentToChat.keys().next()
    if (!oldest.done) commentToChat.delete(oldest.value)
  }
}

export function lookupCommentChat(commentId: string): string | undefined {
  return commentToChat.get(commentId)
}

export function resetCommentChatMap(): void {
  commentToChat.clear()
}

export function isNumericCommentId(value: string): boolean {
  return /^[1-9]\d*$/.test(value)
}
