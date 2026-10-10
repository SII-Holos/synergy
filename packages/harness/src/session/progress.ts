import { MessageV2 } from "./message-v2"
import { Identifier } from "../id/id"

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
   * Inspect headers backwards to the latest reply root, retaining the same
   * compaction boundary as filterCompacted without loading unrelated bodies.
   */
  export async function pendingReplyFor(input: { scopeID: string; sessionID: string }): Promise<boolean> {
    const scopeID = Identifier.asScopeID(input.scopeID)
    const sessionID = Identifier.asSessionID(input.sessionID)
    const terminalRoots = new Set<string>()
    let boundaryUserID: string | undefined
    let skippedReply: boolean | undefined
    let before: string | undefined
    for (;;) {
      let count = 0
      for await (const info of MessageV2.readNewestInfos({ scopeID, sessionID, before, limit: 32 })) {
        count++
        before = MessageV2.messageOrderMarker(info)
        if (info.role === "assistant") {
          if (isTerminalAssistant(info)) {
            terminalRoots.add(info.parentID)
            if (info.rootID) terminalRoots.add(info.rootID)
          }
          if (!boundaryUserID && info.summary && info.finish) boundaryUserID = info.parentID
          continue
        }
        const pending = isReplyRequiredUser(info) ? !terminalRoots.has(info.id) : undefined
        if (!boundaryUserID && pending !== undefined) return pending
        if (pending !== undefined && skippedReply === undefined) skippedReply = pending
        if (info.id !== boundaryUserID) continue
        const parts = await MessageV2.parts({ scopeID, sessionID, messageID: info.id })
        if (parts.some((part) => part.type === "compaction")) return pending ?? false
      }
      if (count < 32) return skippedReply ?? false
    }
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
