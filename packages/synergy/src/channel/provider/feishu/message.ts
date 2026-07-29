import { Log } from "../../../util/log"
import type { FeishuMention } from "./feishu-types"
import type { FeishuApiContext } from "./api-context"

const log = Log.create({ service: "channel.feishu.message" })

export const MAX_FEISHU_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000

export type QuotedMessage = {
  messageId: string
  messageType: string
  content: string
  text: string
}

export type DownloadedMedia = {
  buffer: Uint8Array
  contentType: string
  fileName?: string
  size: number
}

export function parseMessageContent(content: string, messageType: string): string {
  const placeholders: Record<string, string> = {
    merge_forward: "[Merged and Forwarded Message]",
    image: "[Image]",
    file: "[File]",
    audio: "[Audio]",
    media: "[Video]",
    video: "[Video]",
    sticker: "[Sticker]",
  }
  if (messageType in placeholders) return placeholders[messageType]

  try {
    const parsed = JSON.parse(content)
    if (messageType === "text") return parsed.text || ""
    if (messageType === "post") return parsePostText(parsed)
    return content
  } catch {
    return content
  }
}

function parsePostText(parsed: Record<string, unknown>): string {
  const paragraphs = findParagraphs(parsed)
  const lines: string[] = []

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue
    const parts: string[] = []
    for (const element of paragraph) {
      if (!element || typeof element !== "object") continue
      const el = element as { tag?: string; text?: string; href?: string; image_key?: string }
      if (el.tag === "text" && el.text) {
        parts.push(el.text)
      } else if (el.tag === "a" && el.text) {
        parts.push(el.href ? `${el.text}(${el.href})` : el.text)
      } else if (el.tag === "img" && el.image_key) {
        parts.push("[Image]")
      }
    }
    if (parts.length > 0) lines.push(parts.join(""))
  }

  return lines.join("\n")
}

export function extractPostImageKeys(content: string): string[] {
  try {
    const parsed = JSON.parse(content)
    const paragraphs = findParagraphs(parsed)
    const keys: string[] = []
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue
      for (const element of paragraph) {
        if (!element || typeof element !== "object") continue
        const el = element as { tag?: string; image_key?: string }
        if (el.tag === "img" && el.image_key) keys.push(el.image_key)
      }
    }
    return keys
  } catch {
    return []
  }
}

function findParagraphs(locales: Record<string, unknown>): unknown[] {
  if (Array.isArray(locales)) return locales

  for (const key of Object.keys(locales)) {
    const value = locales[key]
    if (key === "content" && Array.isArray(value)) return value

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>
      if (Array.isArray(inner.content)) return inner.content
    }
  }

  return []
}

export function normalizeMentions(text: string, mentions: FeishuMention[]): string {
  if (mentions.length === 0) return text

  let result = text
  for (const mention of mentions) result = result.split(mention.key).join(`@${mention.name}`)
  return result.trim()
}

function parseMediaKeys(
  content: string,
  messageType: string,
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content)
    switch (messageType) {
      case "image":
        return { imageKey: parsed.image_key }
      case "file":
        return { fileKey: parsed.file_key, fileName: parsed.file_name }
      case "audio":
      case "sticker":
        return { fileKey: parsed.file_key, fileName: parsed.file_name }
      case "media":
      case "video":
        return { fileKey: parsed.file_key, imageKey: parsed.image_key, fileName: parsed.file_name }
      default:
        return {}
    }
  } catch {
    return {}
  }
}

export async function fetchQuotedMessage(ctx: FeishuApiContext, parentId: string): Promise<QuotedMessage | undefined> {
  try {
    const token = await ctx.getAccessToken()
    const response = await fetch(`${ctx.apiBase}/im/v1/messages/${parentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined

    const result = (await response.json()) as {
      code?: number
      data?: {
        items?: Array<{ message_id?: string; msg_type?: string; body?: { content?: string }; deleted?: boolean }>
      }
    }
    if (result.code !== 0) return undefined

    const item = result.data?.items?.[0]
    if (item?.deleted || !item?.body?.content || !item.msg_type) return undefined
    return {
      messageId: item.message_id ?? parentId,
      messageType: item.msg_type,
      content: item.body.content,
      text: parseMessageContent(item.body.content, item.msg_type),
    }
  } catch (err) {
    log.warn("failed to fetch quoted message", { parentId, error: String(err) })
    return undefined
  }
}

export async function downloadMessageMedia(params: {
  ctx: FeishuApiContext
  messageId: string
  messageType: string
  content: string
  maxBytes?: number
}): Promise<DownloadedMedia | undefined> {
  const keys = parseMediaKeys(params.content, params.messageType)
  const fileKey = keys.fileKey || keys.imageKey
  if (!fileKey) {
    log.info("feishu media download skipped", {
      messageId: params.messageId,
      messageType: params.messageType,
      reason: "missing-file-key",
    })
    return undefined
  }

  const resourceType = params.messageType === "image" ? "image" : "file"
  try {
    const token = await params.ctx.getAccessToken()
    const response = await fetch(
      `${params.ctx.apiBase}/im/v1/messages/${params.messageId}/resources/${fileKey}?type=${resourceType}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      },
    )

    if (!response.ok) {
      log.warn("feishu media download HTTP error", {
        messageId: params.messageId,
        fileKey,
        status: response.status,
      })
      return undefined
    }

    const maxBytes = params.maxBytes ?? MAX_FEISHU_ATTACHMENT_BYTES
    const buffer = await readBoundedResponse(response, maxBytes)
    if (!buffer || buffer.length === 0) return undefined

    return {
      buffer,
      contentType: response.headers.get("content-type") || inferContentType(params.messageType),
      fileName: keys.fileName,
      size: buffer.length,
    }
  } catch (err) {
    log.warn("failed to download message media", { messageId: params.messageId, fileKey, error: String(err) })
    return undefined
  }
}

function inferContentType(messageType: string): string {
  const types: Record<string, string> = {
    image: "image/png",
    sticker: "image/png",
    audio: "audio/ogg",
    media: "video/mp4",
    video: "video/mp4",
  }
  return types[messageType] ?? "application/octet-stream"
}

export async function downloadImageByKey(params: {
  ctx: FeishuApiContext
  messageId: string
  imageKey: string
  maxBytes?: number
}): Promise<DownloadedMedia | undefined> {
  try {
    const token = await params.ctx.getAccessToken()
    const response = await fetch(
      `${params.ctx.apiBase}/im/v1/messages/${params.messageId}/resources/${params.imageKey}?type=image`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      },
    )

    if (!response.ok) {
      log.warn("feishu image download HTTP error", {
        messageId: params.messageId,
        imageKey: params.imageKey,
        status: response.status,
      })
      return undefined
    }

    const buffer = await readBoundedResponse(response, params.maxBytes ?? MAX_FEISHU_ATTACHMENT_BYTES)
    if (!buffer || buffer.length === 0) return undefined
    return {
      buffer,
      contentType: response.headers.get("content-type") || "image/png",
      size: buffer.length,
    }
  } catch (err) {
    log.warn("failed to download image by key", {
      messageId: params.messageId,
      imageKey: params.imageKey,
      error: String(err),
    })
    return undefined
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    return undefined
  }
  if (!response.body) return undefined

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}
