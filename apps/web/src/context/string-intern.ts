import type { Message, Part, ProviderListResponse } from "@ericsanchezok/synergy-sdk/client"

class StringCache {
  private readonly values = new Map<string, string>()
  bytes = 0

  constructor(
    private readonly limit: number,
    private readonly byteLimit: number,
  ) {}

  get size() {
    return this.values.size
  }
  get(value: string) {
    return this.values.get(value)
  }

  delete(value: string) {
    if (this.values.delete(value)) this.bytes -= value.length * 2
  }

  add(value: string) {
    const bytes = value.length * 2
    if (bytes > this.byteLimit) return
    this.delete(value)
    while (this.values.size >= this.limit || this.bytes + bytes > this.byteLimit) {
      const oldest = this.values.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.values.set(value, value)
    this.bytes += bytes
  }
}

export function createStringInterner() {
  const intern = new StringCache(512, 2 * 1024 * 1024)
  const shortSeen = new StringCache(1024, 256 * 1024)
  const longSeen = new StringCache(64, 256 * 1024)
  return {
    intern(value: string): string {
      if (typeof value !== "string" || value.length * 2 > 64 * 1024) return value
      const cached = intern.get(value)
      if (cached !== undefined) return cached
      const seen = value.length <= 2048 ? shortSeen : longSeen
      const repeated = seen.get(value)
      if (repeated !== undefined) {
        seen.delete(value)
        intern.add(repeated)
        return repeated
      }
      seen.add(value)
      return value
    },
    stats() {
      return {
        entries: intern.size,
        seenEntries: shortSeen.size + longSeen.size,
        retainedBytes: intern.bytes + shortSeen.bytes + longSeen.bytes,
      }
    },
  }
}

const strings = createStringInterner()
export const internString = strings.intern
export function internCacheSize(): number {
  return strings.stats().entries
}

export function internProviderList(data: ProviderListResponse): ProviderListResponse {
  for (const provider of data.all) {
    const models = provider.models ?? {}
    for (const model of Object.values(models)) {
      if (!model.api) continue
      model.api.id = internString(model.api.id)
      model.api.npm = internString(model.api.npm)
      model.api.url = internString(model.api.url)
      const variants = model.variants ?? {}
      for (const variant of Object.values(variants)) {
        const include = (variant as { include?: unknown }).include
        if (!Array.isArray(include)) continue
        for (let i = 0; i < include.length; i++) {
          const entry = include[i]
          if (typeof entry === "string") include[i] = internString(entry)
        }
      }
    }
  }
  return data
}

export function internPart(part: Part): Part {
  if (part.type === "text" && part.origin === "system" && typeof part.text === "string") {
    part.text = internString(part.text)
  }
  return part
}

export function internMessage(message: Message): Message {
  if (message.role === "user" && typeof message.system === "string") {
    message.system = internString(message.system)
  }
  return message
}

export function internMessages(messages: Message[]): Message[] {
  for (const message of messages) internMessage(message)
  return messages
}

export function internParts(parts: Part[]): Part[] {
  for (const part of parts) internPart(part)
  return parts
}
