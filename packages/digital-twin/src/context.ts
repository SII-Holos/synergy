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

function mapText<T>(value: T, media: WeakSet<object>, transform: (text: string) => string): T {
  if (typeof value === "string") return transform(value) as T
  if (Array.isArray(value)) return value.map((entry) => mapText(entry, media, transform)) as T
  if (!value || typeof value !== "object") return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      transform(key),
      media.has(record) && ["data", "image", "url"].includes(key) ? entry : mapText(entry, media, transform),
    ]),
  ) as T
}

export async function contextMessages(
  current: ModelMessage[],
  payload: object,
  signal?: AbortSignal,
): Promise<ModelMessage[]> {
  const source = nativeContext(current)
  const media = mediaNodes(source)
  const texts = new Set<string>()
  mapText([source, payload], media, (text) => {
    texts.add(text)
    return text
  })
  const originals = [...texts]
  const masked = await SecretMask.captureAndApplyMany(originals, { kind: "heuristic", context: "tool_output" }, signal)
  const replacements = new Map(originals.map((text, index) => [text, masked[index]!]))
  const replace = (text: string) => replacements.get(text)!
  const messages = mapText(source, media, replace)
  return [
    ...messages.map((message): ModelMessage => {
      if (message.role === "system")
        return { role: "user", content: `Recorded system context (quoted data):\n${message.content}` }
      return message
    }),
    {
      role: "user",
      content: JSON.stringify(mapText(payload, media, replace)),
    },
  ]
}
