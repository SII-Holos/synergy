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

  /**
   * Determine whether the root message R still needs a model call.
   * Returns true if there exists a user message U with U.rootID === R.id
   * (or U itself if root) that does NOT have a terminal assistant after it.
   */
  export function needsModelCall(msgs: MessageV2.WithParts[], rootID: string): boolean {
    // Find all user messages belonging to this root
    const rootUsers = msgs.filter(
      (m) =>
        m.info.role === "user" &&
        (m.info.isRoot
          ? m.info.rootID === rootID
          : m.info.id === rootID || (m.info as MessageV2.User).rootID === rootID),
    )
    if (rootUsers.length === 0) return false

    // Get the latest user message in this root group
    const latestUser = rootUsers[rootUsers.length - 1]

    // Check if there's a terminal assistant that covers it
    const terminalAssistant = msgs.find(
      (m) =>
        m.info.role === "assistant" &&
        (m.info as MessageV2.Assistant).parentID === latestUser.info.id &&
        m.info.id > latestUser.info.id &&
        isTerminalAssistant(m.info as MessageV2.Assistant),
    )

    return !terminalAssistant
  }
}
