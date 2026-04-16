import { MessageV2 } from "./message-v2"

export namespace Turn {
  export interface Raw {
    user: MessageV2.WithParts
    assistants: MessageV2.WithParts[]
  }

  function isSummaryAssistant(msg: MessageV2.WithParts): boolean {
    if (msg.info.role !== "assistant") return false
    return (msg.info as MessageV2.Assistant).summary === true
  }

  export function collect(messages: MessageV2.WithParts[], options?: { skipSynthetic?: boolean }): Raw[] {
    const skip = options?.skipSynthetic ?? false
    const turns: Raw[] = []
    let current: Raw | undefined

    for (const msg of messages) {
      if (msg.info.role === "user") {
        if (skip && isSyntheticUser(msg)) continue
        if (current) turns.push(current)
        current = { user: msg, assistants: [] }
      } else if (msg.info.role === "assistant" && current) {
        if (skip && isSummaryAssistant(msg)) continue
        if (skip || msg.info.parentID === current.user.info.id) {
          current.assistants.push(msg)
        }
      }
    }
    if (current) turns.push(current)

    return turns
  }

  export function collectOne(
    messages: MessageV2.WithParts[],
    userMessageID: string,
    options?: { skipSynthetic?: boolean },
  ): Raw | undefined {
    const skip = options?.skipSynthetic ?? false
    const idx = messages.findIndex((m) => m.info.id === userMessageID && m.info.role === "user")
    if (idx < 0) return undefined

    const user = messages[idx]
    const assistants: MessageV2.WithParts[] = []
    for (let i = idx + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.info.role === "user") {
        if (skip && isSyntheticUser(msg)) continue
        break
      }
      if (msg.info.role === "assistant") {
        if (skip && isSummaryAssistant(msg)) continue
        if (skip || msg.info.parentID === userMessageID) {
          assistants.push(msg)
        }
      }
    }
    return { user, assistants }
  }

  export function countRecentTurns(messages: MessageV2.WithParts[], count: number): number {
    let turns = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") turns++
      if (turns >= count) return i
    }
    return 0
  }

  export function isSyntheticUser(msg: MessageV2.WithParts): boolean {
    if (msg.info.role !== "user") return false
    if (msg.parts.length === 0) return true
    return msg.parts.every((p) => {
      if (p.type === "text" && p.synthetic) return true
      if (p.type === "compaction") return true
      return false
    })
  }

  export function resolveRealUser(messages: MessageV2.WithParts[], userMessageID: string): string {
    const idx = messages.findIndex((m) => m.info.id === userMessageID && m.info.role === "user")
    if (idx < 0) return userMessageID
    if (!isSyntheticUser(messages[idx])) return userMessageID
    for (let i = idx - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info.role !== "user") continue
      if (!isSyntheticUser(msg)) return msg.info.id
    }
    return userMessageID
  }

  export function resolveUserText(messages: MessageV2.WithParts[], userMessageID: string): string | undefined {
    const idx = messages.findIndex((m) => m.info.id === userMessageID && m.info.role === "user")
    if (idx < 0) return undefined

    const collected: MessageV2.WithParts[] = []
    for (let i = idx; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info.role === "assistant") break
      if (msg.info.role === "user" && !isSyntheticUser(msg)) collected.push(msg)
    }
    collected.reverse()

    const text = collected
      .flatMap((m) => m.parts.filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic))
      .map((p) => p.text)
      .join("\n")
    return text.trim() || undefined
  }
}
