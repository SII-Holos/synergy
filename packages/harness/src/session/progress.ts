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
   * Resolve whether the given session still has a pending reply by loading its
   * messages and delegating to {@link pendingReply}. Shared by session recovery
   * and session working resolution.
   */
  export async function pendingReplyFor(input: { scopeID: string; sessionID: string }): Promise<boolean> {
    const messages = await MessageV2.filterCompacted(MessageV2.stream(input)).catch(() => [] as MessageV2.WithParts[])
    return pendingReply(messages)
  }

  /**
   * Determine whether the root message R still needs a model call.
   * Returns true if there exists a user message U with U.rootID === R.id
   * (or U itself if root) that does NOT have a terminal assistant after it.
   */
  export function needsModelCall(msgs: MessageV2.WithParts[], rootID: string): boolean {
    let latestUserIndex = -1
    for (let index = 0; index < msgs.length; index++) {
      const info = msgs[index].info
      if (info.role !== "user") continue
      const user = info as MessageV2.User
      if (user.rootID === rootID || (user.isRoot === true && user.id === rootID)) latestUserIndex = index
    }
    if (latestUserIndex < 0) return false

    return !msgs.slice(latestUserIndex + 1).some((message) => {
      if (message.info.role !== "assistant") return false
      const assistant = message.info as MessageV2.Assistant
      return assistant.rootID === rootID && isTerminalAssistant(assistant)
    })
  }
}
