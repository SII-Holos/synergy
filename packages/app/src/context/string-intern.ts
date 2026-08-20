import type { Message, Part, ProviderListResponse } from "@ericsanchezok/synergy-sdk/client"

// Bounded value-interning for repeated constant strings flowing from backend
// payloads into the store. Heap snapshots showed tens of thousands of
// identical provider package names ("@ai-sdk/openai-compatible" x96k),
// reasoning include fields ("reasoning.encrypted_content" x16k), and system
// prompt copies per session. The store writes these verbatim, so every
// provider refresh and message load duplicated them. Interning merges equal
// values into one shared reference; distinct values are never merged, so the
// change is semantically transparent.
//
// Retention discipline: only repeated values are promoted into the long-term
// intern table, so one-off session content is never pinned beyond the
// session bucket LRU. Short values pass through a bounded FIFO "seen" set;
// long values (e.g. agent system prompts) have their own smaller sighting
// set and promote only on a repeat.
const INTERN_LIMIT = 512
const SHORT_SEEN_LIMIT = 1024
const LONG_SEEN_LIMIT = 64
const SHORT_MAX_LENGTH = 2048

const internByValue = new Map<string, string>()
const internOrder: string[] = []
const shortSeen = new Set<string>()
const shortSeenOrder: string[] = []
const longSeen = new Map<string, string>()
const longSeenOrder: string[] = []

function promote(value: string): string {
  if (internByValue.size >= INTERN_LIMIT) {
    const oldest = internOrder.shift()
    if (oldest !== undefined) internByValue.delete(oldest)
  }
  internByValue.set(value, value)
  internOrder.push(value)
  return value
}

export function internString(value: string): string {
  const cached = internByValue.get(value)
  if (cached !== undefined) return cached

  if (value.length <= SHORT_MAX_LENGTH) {
    if (shortSeen.has(value)) {
      shortSeen.delete(value)
      return promote(value)
    }
    if (shortSeen.size >= SHORT_SEEN_LIMIT) {
      const oldest = shortSeenOrder.shift()
      if (oldest !== undefined) shortSeen.delete(oldest)
    }
    shortSeen.add(value)
    shortSeenOrder.push(value)
    return value
  }

  if (longSeen.has(value)) {
    longSeen.delete(value)
    return promote(value)
  }
  if (longSeen.size >= LONG_SEEN_LIMIT) {
    const oldest = longSeenOrder.shift()
    if (oldest !== undefined) longSeen.delete(oldest)
  }
  longSeen.set(value, value)
  longSeenOrder.push(value)
  return value
}

/** Number of entries currently held by the long-term intern table (test/diagnostic). */
export function internCacheSize(): number {
  return internByValue.size
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
