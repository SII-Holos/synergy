import type { Message, Part, ProviderListResponse } from "@ericsanchezok/synergy-sdk/client"

// Bounded value-interning for repeated constant strings flowing from backend
// payloads into the store. Heap snapshots showed tens of thousands of
// identical provider package names ("@ai-sdk/openai-compatible" x96k),
// reasoning include fields ("reasoning.encrypted_content" x16k), and system
// prompt copies per session. The store writes these verbatim, so every
// provider refresh and message load duplicated them. Interning merges equal
// values into one shared reference; distinct values are never merged, so the
// change is semantically transparent.
const INTERN_LIMIT = 512
const internByValue = new Map<string, string>()
const internOrder: string[] = []

export function internString(value: string): string {
  const cached = internByValue.get(value)
  if (cached !== undefined) return cached
  if (internByValue.size >= INTERN_LIMIT) {
    const oldest = internOrder.shift()
    if (oldest !== undefined) internByValue.delete(oldest)
  }
  internByValue.set(value, value)
  internOrder.push(value)
  return value
}

/** Number of entries currently held by the interning table (test/diagnostic). */
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
  if (part.type === "text" && part.origin === "system" && typeof part.text === "string" && part.text.length <= 65536) {
    part.text = internString(part.text)
  }
  return part
}

export function internMessage(message: Message): Message {
  if (message.role === "user" && typeof message.system === "string" && message.system.length <= 65536) {
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
