import type { ModelMessage, ToolResultPart } from "ai"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Asset } from "../asset/asset"
import { Attachment } from "."
import { AttachmentImageInput } from "./image-input"

export const AttachmentModelInputError = NamedError.create(
  "AttachmentModelInputError",
  z.object({ reference: z.string(), message: z.string() }),
)

export async function materializeAttachmentInput(
  messages: ModelMessage[],
  signal: AbortSignal,
): Promise<ModelMessage[]> {
  signal.throwIfAborted()
  const resolved = new Map<string, Promise<Uint8Array>>()
  const resolve = (value: unknown): Promise<Uint8Array | undefined> => {
    const reference = typeof value === "string" ? value : value instanceof URL ? value.href : undefined
    if (!reference?.startsWith("asset://")) return Promise.resolve(undefined)
    const cached = resolved.get(reference)
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
      return bytes
    })()
    resolved.set(reference, pending)
    return pending
  }
  const image = async (value: unknown): Promise<AttachmentImageInput.Result | { remote: string }> => {
    signal.throwIfAborted()
    const reference = value instanceof URL ? value.href : value
    if (typeof reference === "string" && /^https?:\/\//i.test(reference)) return { remote: reference }
    const asset = await resolve(value)
    if (asset) return AttachmentImageInput.prepare(asset, signal)
    if (reference instanceof Uint8Array) return AttachmentImageInput.prepare(reference, signal)
    if (reference instanceof ArrayBuffer) return AttachmentImageInput.prepare(new Uint8Array(reference), signal)
    if (typeof reference !== "string") return { ok: false, reason: "invalid" }
    const data = reference.startsWith("data:") ? reference.match(/^data:[^,]*;base64,([\s\S]*)$/i)?.[1] : reference
    if (data === undefined || data.length === 0) return { ok: false, reason: "invalid" }
    if (data.length > Math.ceil(AttachmentImageInput.BUDGET.maxInputBytes / 3) * 4)
      return { ok: false, reason: "too-large" }
    if (/[^A-Za-z0-9+/=]/.test(data)) return { ok: false, reason: "invalid" }
    const bytes = Buffer.from(data, "base64")
    if (bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) return { ok: false, reason: "invalid" }
    return AttachmentImageInput.prepare(bytes, signal)
  }
  const omitted = (reason: "unavailable" | "invalid" | "too-large") => ({
    type: "text" as const,
    text: `[Image omitted: ${reason === "unavailable" ? "image processing is unavailable" : reason === "too-large" ? "the image exceeds the processing budget" : "the image could not be decoded or prepared"}. Other conversation content is available. Ask for a smaller valid image or inspect the original with file tools.]`,
  })
  const notice = (result: Extract<AttachmentImageInput.Result, { ok: true }>) =>
    result.width === result.originalWidth && result.height === result.originalHeight
      ? []
      : [
          {
            type: "text" as const,
            text: `[Image resized from ${result.originalWidth}×${result.originalHeight} to ${result.width}×${result.height} for model input. The original is unchanged. Scale coordinates accordingly when referring to the original.]`,
          },
        ]
  const toolResult = async (part: ToolResultPart): Promise<ToolResultPart> => {
    if (part.output.type !== "content") return part
    const value: typeof part.output.value = []
    for (const item of part.output.value) {
      if (item.type !== "media" || !item.mediaType.toLowerCase().startsWith("image/")) {
        value.push(item)
        continue
      }
      const result = await image(item.data)
      if ("remote" in result) value.push(omitted("invalid"))
      else if (!result.ok) value.push(omitted(result.reason))
      else value.push(...notice(result), { ...item, data: result.data, mediaType: result.mediaType })
    }
    return { ...part, output: { ...part.output, value } }
  }
  // Provenance: https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/image_preparation.rs
  // Local adaptation: prepare every AI SDK image representation before recording/dispatch; preserve remote URL transport and fatal Asset errors.
  return Promise.all(
    messages.map(async (message): Promise<ModelMessage> => {
      if (message.role === "system" || typeof message.content === "string") return message
      if (message.role === "tool") return { ...message, content: await Promise.all(message.content.map(toolResult)) }
      const content = []
      for (const part of message.content) {
        if (part.type === "tool-result") {
          content.push(await toolResult(part))
          continue
        }
        if (part.type === "image" || (part.type === "file" && part.mediaType.toLowerCase().startsWith("image/"))) {
          const result = await image(part.type === "image" ? part.image : part.data)
          if ("remote" in result)
            content.push(part.type === "image" ? { ...part, image: result.remote } : { ...part, data: result.remote })
          else if (!result.ok) content.push(omitted(result.reason))
          else {
            const url = `data:${result.mediaType};base64,${result.data}`
            content.push(
              ...notice(result),
              part.type === "image"
                ? { ...part, image: url, mediaType: result.mediaType }
                : { ...part, data: url, mediaType: result.mediaType },
            )
          }
          continue
        }
        if (part.type === "file") {
          const bytes = await resolve(part.data)
          content.push({
            ...part,
            data: bytes
              ? Attachment.dataUrl(part.mediaType, bytes)
              : part.data instanceof URL
                ? part.data.href
                : part.data,
          })
          continue
        }
        content.push(part)
      }
      return { ...message, content } as ModelMessage
    }),
  )
}
