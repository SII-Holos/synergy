export namespace HolosMessageMetadata {
  export type Info = {
    inbound?: true
    senderId?: string
    senderName?: string
    messageId?: string
    replyToMessageId?: string
  }

  export type Quote = {
    messageId?: string
    text?: string
    senderName?: string
  }

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  }

  function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  function compact<T extends Record<string, unknown>>(value: T): T | undefined {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (entries.length === 0) return undefined
    return Object.fromEntries(entries) as T
  }

  export function holos(metadata: Record<string, unknown> | undefined): Info | undefined {
    const value = asRecord(metadata?.holos)
    if (!value) return undefined
    return compact({
      inbound: value.inbound === true ? true : undefined,
      senderId: asString(value.senderId),
      senderName: asString(value.senderName),
      messageId: asString(value.messageId),
      replyToMessageId: asString(value.replyToMessageId),
    })
  }

  export function quote(metadata: Record<string, unknown> | undefined): Quote | undefined {
    const value = asRecord(metadata?.quote)
    if (!value) return undefined
    return compact({
      messageId: asString(value.messageId),
      text: asString(value.text),
      senderName: asString(value.senderName),
    })
  }

  export function merge(
    metadata: Record<string, unknown> | undefined,
    patch: {
      source?: string
      holos?: Partial<Info>
      quote?: Partial<Quote>
    },
  ): Record<string, unknown> | undefined {
    const next: Record<string, unknown> = { ...(metadata ?? {}) }

    if (patch.source !== undefined) next.source = patch.source

    if (patch.holos !== undefined) {
      const merged = compact({
        ...(holos(metadata) ?? {}),
        ...patch.holos,
      })
      if (merged) next.holos = merged
      else delete next.holos
    }

    if (patch.quote !== undefined) {
      const merged = compact({
        ...(quote(metadata) ?? {}),
        ...patch.quote,
      })
      if (merged) next.quote = merged
      else delete next.quote
    }

    return compact(next)
  }
}
