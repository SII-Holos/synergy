import { MessageV2 } from "./message-v2"

export namespace SessionProgress {
  /**
   * Whether a user message owns a reply cycle (i.e. is a task root). Prefers the
   * canonical isRoot; falls back to legacy noReply only for callers that receive
   * non-canonicalized info (e.g. storage migrations reading raw message infos).
   */
  export function isReplyRequiredUser(user: MessageV2.User) {
    return user.isRoot ?? user.metadata?.noReply !== true
  }

  export function isTerminalAssistant(assistant: MessageV2.Assistant) {
    return !!assistant.finish && !["tool-calls", "unknown"].includes(assistant.finish)
  }

  export function findTerminalReply(messages: MessageV2.WithParts[], userID: string) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role !== "assistant") continue
      const assistant = msg.info as MessageV2.Assistant
      if ((assistant.parentID === userID || assistant.rootID === userID) && isTerminalAssistant(assistant)) return msg
    }
  }

  /** @deprecated Replaced by needsModelCall. Kept for migration callers. */
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
    const rootUsers = msgs.filter(
      (m) =>
        m.info.role === "user" &&
        ((m.info as MessageV2.User).rootID === rootID || (m.info.isRoot === true && m.info.id === rootID)),
    )
    if (rootUsers.length === 0) return false

    const latestUser = rootUsers[rootUsers.length - 1]

    const terminalAssistant = msgs.find((m) => {
      if (m.info.role !== "assistant") return false
      const assistant = m.info as MessageV2.Assistant
      if (assistant.rootID !== rootID) return false
      if (assistant.id <= latestUser.info.id) return false
      return isTerminalAssistant(assistant)
    })

    return !terminalAssistant
  }
}
