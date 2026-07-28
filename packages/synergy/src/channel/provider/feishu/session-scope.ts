import type { Config } from "../../../config/config"

export function resolveGroupScopeKey(input: {
  chatId: string
  senderId: string
  rootId?: string
  threadId?: string
  scope: Config.FeishuGroupSessionScope
}): string {
  const { chatId, senderId, rootId, threadId, scope } = input
  const topicId = rootId ?? threadId

  switch (scope) {
    case "group_sender":
      return `${chatId}:sender:${senderId}`
    case "group_topic":
      return topicId ? `${chatId}:topic:${topicId}` : chatId
    case "group_topic_sender":
      return topicId ? `${chatId}:topic:${topicId}:sender:${senderId}` : `${chatId}:sender:${senderId}`
    case "group":
    default:
      return chatId
  }
}
