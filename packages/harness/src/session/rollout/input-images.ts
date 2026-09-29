import { createHash } from "node:crypto"
import { z } from "zod"

export namespace InputImages {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Entry = z
    .object({ sha256: Hash, status: z.enum(["included", "omitted"]), reason: z.string().max(100).optional() })
    .strict()
  export const List = z.array(Entry).max(128)
  export const Hashes = z.array(Hash).max(128)
  export type Entry = z.infer<typeof Entry>
  export type Receipt = {
    callID: string
    providerID: string
    modelID: string
    recorded: boolean
    images: { sha256: string; stage: "included" | "submitted" | "omitted"; reason?: string }[]
  }

  export function digest(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex")
  }
  function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  }
  function data(value: unknown): string | undefined {
    if (value instanceof Uint8Array) return digest(value)
    if (value instanceof URL) value = value.href
    if (typeof value !== "string") return
    const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value)
    if (match?.[1]) return digest(Buffer.from(match[1], "base64"))
  }
  function model(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const hashes = new Set<string>()
    for (const message of value) {
      const content = record(message)?.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const item = record(part)
        const image =
          item?.type === "image"
            ? item.image
            : item?.type === "file" && typeof item.mediaType === "string" && item.mediaType.startsWith("image/")
              ? item.data
              : undefined
        const hash = data(image)
        if (hash) hashes.add(hash)
      }
    }
    return [...hashes].slice(0, 128)
  }
  export function compare(before: unknown, after: unknown): Entry[] {
    return retained(model(before), after)
  }
  export function retained(before: string[], after: unknown): Entry[] {
    const kept = new Set(model(after))
    return [...new Set([...before, ...kept])]
      .slice(0, 128)
      .map((sha256) =>
        kept.has(sha256)
          ? { sha256, status: "included" }
          : { sha256, status: "omitted", reason: "provider_transform_omitted" },
      )
  }
  export function wire(body: string): string[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return []
    }
    const root = record(parsed)
    const messages = root?.messages ?? root?.contents ?? root?.input
    if (!Array.isArray(messages)) return []
    const hashes = new Set<string>()
    function parts(items: unknown, depth = 0) {
      if (!Array.isArray(items) || depth > 4) return
      for (const item of items) {
        const part = record(item)
        if (!part) continue
        let hash: string | undefined
        if (part.type === "image_url") hash = data(record(part.image_url)?.url)
        if (part.type === "input_image") hash = data(part.image_url)
        const source = record(part.source)
        if (part.type === "image" && source?.type === "base64" && typeof source.data === "string")
          hash = data(`data:${source.media_type};base64,${source.data}`)
        const inline = record(part.inlineData) ?? record(part.inline_data)
        if (inline && typeof inline.data === "string")
          hash = data(`data:${inline.mimeType ?? inline.mime_type};base64,${inline.data}`)
        const image = record(part.image)
        const bytes = record(image?.source)?.bytes
        if (image && typeof bytes === "string") hash = data(`data:image/${image.format};base64,${bytes}`)
        if (hash && hashes.size < 128) hashes.add(hash)
        if (part.type === "tool_result") parts(part.content, depth + 1)
      }
    }
    for (const message of messages) {
      const row = record(message)
      parts(row?.content ?? row?.parts)
    }
    return [...hashes]
  }
}
