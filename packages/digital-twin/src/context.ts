import type { ModelMessage } from "ai"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"

function nativeContext(current: ModelMessage[]): ModelMessage[] {
  return current.flatMap(({ providerOptions, ...message }): ModelMessage[] => {
    if (typeof message.content === "string") return [message]
    const content = [...message.content].flatMap<Exclude<ModelMessage["content"], string>[number]>((part) => {
      if (part.type === "reasoning")
        return part.text.trim()
          ? [{ type: "text" as const, text: `Recorded assistant reasoning (quoted data):\n${part.text}` }]
          : []
      if (!("providerOptions" in part)) return [{ ...part }]
      const { providerOptions, ...content } = part
      return [content]
    })
    return content.length
      ? [
          {
            ...message,
            content,
          } as ModelMessage,
        ]
      : []
  })
}

function mediaNodes(messages: ModelMessage[]) {
  const result = new WeakSet<object>()
  for (const message of messages) {
    if (typeof message.content === "string") continue
    for (const part of message.content) {
      const parts = part.type === "tool-result" && part.output.type === "content" ? part.output.value : [part]
      for (const value of parts) {
        if (!["image", "file", "image-data", "file-data", "image-url", "file-url"].includes(value.type)) continue
        if (
          "data" in value &&
          value.data &&
          typeof value.data === "object" &&
          "type" in value.data &&
          value.data.type === "text"
        )
          continue
        result.add(value)
      }
    }
  }
  return result
}

function textual(value: unknown, media: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => textual(entry, media))
  if (!value || typeof value !== "object") return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL) return undefined
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !(media.has(record) && ["data", "image", "url"].includes(key)))
      .map(([key, entry]) => [key, textual(entry, media)]),
  )
}

export function contextText(current: ModelMessage[]) {
  const messages = nativeContext(current)
  return JSON.stringify(textual(messages, mediaNodes(messages)))
}

async function mask<T>(value: T, media: WeakSet<object>): Promise<T> {
  if (typeof value === "string") return (await SecretMask.apply(value)) as T
  if (Array.isArray(value)) return (await Promise.all(value.map((entry) => mask(entry, media)))) as T
  if (!value || typeof value !== "object") return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    await Promise.all(
      Object.entries(record).map(async ([key, entry]) => [
        key,
        media.has(record) && ["data", "image", "url"].includes(key) ? entry : await mask(entry, media),
      ]),
    ),
  ) as T
}

export async function contextMessages(current: ModelMessage[], payload: object): Promise<ModelMessage[]> {
  const source = nativeContext(current)
  const messages = await mask(source, mediaNodes(source))
  return [
    ...messages.map((message): ModelMessage => {
      if (message.role === "system")
        return { role: "user", content: `Recorded system context (quoted data):\n${message.content}` }
      return message
    }),
    { role: "user", content: await SecretMask.apply(JSON.stringify(payload)) },
  ]
}
