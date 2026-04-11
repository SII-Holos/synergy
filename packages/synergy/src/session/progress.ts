import { MessageV2 } from "./message-v2"

export namespace SessionProgress {
  export function isReplyRequiredUser(user: MessageV2.User) {
    return user.metadata?.noReply !== true
  }

  export function isTerminalAssistant(assistant: MessageV2.Assistant) {
    return !!assistant.finish && !["tool-calls", "unknown"].includes(assistant.finish)
  }

  export function pendingReply(messages: MessageV2.WithParts[]) {
    let lastReplyRequiredUser: MessageV2.User | undefined
    let lastTerminalAssistant: MessageV2.Assistant | undefined

    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (!lastReplyRequiredUser && msg.info.role === "user") {
        const user = msg.info as MessageV2.User
        if (isReplyRequiredUser(user)) {
          lastReplyRequiredUser = user
        }
      }
      if (!lastTerminalAssistant && msg.info.role === "assistant") {
        const assistant = msg.info as MessageV2.Assistant
        if (isTerminalAssistant(assistant)) {
          lastTerminalAssistant = assistant
        }
      }
      if (lastReplyRequiredUser && lastTerminalAssistant) break
    }

    return !!lastReplyRequiredUser && (!lastTerminalAssistant || lastTerminalAssistant.id < lastReplyRequiredUser.id)
  }
}
