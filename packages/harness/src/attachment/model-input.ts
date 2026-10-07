import type { ModelMessage } from "ai"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Asset } from "../asset/asset"
import { Attachment } from "."

export const AttachmentModelInputError = NamedError.create(
  "AttachmentModelInputError",
  z.object({ reference: z.string(), message: z.string() }),
)

export async function materializeAttachmentInput(
  messages: ModelMessage[],
  signal: AbortSignal,
): Promise<ModelMessage[]> {
  signal.throwIfAborted()
  const resolved = new Map<string, Promise<string>>()
  const resolve = (value: unknown, mime?: string): Promise<string | undefined> => {
    const reference = typeof value === "string" ? value : value instanceof URL ? value.href : undefined
    if (!reference?.startsWith("asset://")) return Promise.resolve(undefined)
    const key = `${reference}:${mime ?? ""}`
    const cached = resolved.get(key)
    if (cached) return cached
    const pending = (async () => {
      signal.throwIfAborted()
      const id = reference.slice("asset://".length)
      const filepath = Asset.resolvePath(id)
      if (!filepath) throw new AttachmentModelInputError({ reference, message: "The attachment reference is invalid." })
      const file = await Asset.read(id)
      if (!file)
        throw new AttachmentModelInputError({ reference, message: "The attachment is unavailable. Upload it again." })
      const bytes = await file.bytes()
      signal.throwIfAborted()
      return Attachment.dataUrl(mime ?? Asset.mimeFromExt(Asset.extFromId(id)), bytes)
    })()
    resolved.set(key, pending)
    return pending
  }
  return Promise.all(
    messages.map(async (message): Promise<ModelMessage> => {
      if (message.role === "system" || message.role === "tool" || typeof message.content === "string") return message
      const content = await Promise.all(
        message.content.map(async (part) => {
          if (part.type === "image") {
            const image = await resolve(part.image, part.mediaType)
            return image ? { ...part, image: new URL(image) } : part
          }
          if (part.type === "file") {
            const data = await resolve(part.data, part.mediaType)
            return data ? { ...part, data: new URL(data) } : part
          }
          return part
        }),
      )
      return { ...message, content } as ModelMessage
    }),
  )
}
