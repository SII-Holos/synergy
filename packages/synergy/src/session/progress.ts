import { MessageV2 } from "./message-v2"

export namespace SessionProgress {
  export function isReplyRequiredUser(user: MessageV2.User) {
    return user.metadata?.noReply !== true
  }

  export function isTerminalAssistant(assistant: MessageV2.Assistant) {
    return !!assistant.finish && !["tool-calls", "unknown"].includes(assistant.finish)
  }

  export function findTerminalReply(messages: MessageV2.WithParts[], userID: string) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role !== "assistant") continue
      const assistant = msg.info as MessageV2.Assistant
      if (assistant.parentID === userID && isTerminalAssistant(assistant)) return msg
    }
  }

  export function hasTerminalReply(input: { messages: MessageV2.WithParts[]; userID: string }) {
    return !!findTerminalReply(input.messages, input.userID)
  }

  export function pendingReply(messages: MessageV2.WithParts[]) {
    let lastReplyRequiredUser: MessageV2.User | undefined

    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (!lastReplyRequiredUser && msg.info.role === "user") {
        const user = msg.info as MessageV2.User
        if (isReplyRequiredUser(user)) {
          lastReplyRequiredUser = user
        }
      }
      if (lastReplyRequiredUser) break
    }

    return !!lastReplyRequiredUser && !hasTerminalReply({ messages, userID: lastReplyRequiredUser.id })
  }
}
