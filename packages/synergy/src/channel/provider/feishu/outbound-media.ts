import path from "path"
import type { FeishuApiContext } from "./api-context"
import * as ChannelTypes from "../../types"

type UploadImageResult = { imageKey: string }
type UploadFileResult = { fileKey: string }

type PreparedMediaMessage =
  | { msgType: "image"; content: string }
  | { msgType: "file"; content: string }
  | { msgType: "audio"; content: string }
  | { msgType: "media"; content: string }

export namespace FeishuOutboundMedia {
  export async function prepare(part: Exclude<ChannelTypes.OutboundPart, { type: "text" }>, ctx: FeishuApiContext) {
    const asset = await loadAsset(part)

    switch (part.type) {
      case "image": {
        const uploaded = await uploadImage(asset, ctx)
        return {
          msgType: "image",
          content: JSON.stringify({ image_key: uploaded.imageKey }),
        } satisfies PreparedMediaMessage
      }
      case "audio": {
        const uploaded = await uploadFile(asset, ctx, {
          fileType: "opus",
          fileName: asset.filename,
        })
        return {
          msgType: "audio",
          content: JSON.stringify({ file_key: uploaded.fileKey }),
        } satisfies PreparedMediaMessage
      }
      case "video": {
        if (!part.durationMs) {
          const uploaded = await uploadFile(asset, ctx, {
            fileType: inferFileType(asset.filename, asset.contentType),
            fileName: asset.filename,
          })
          return {
            msgType: "file",
            content: JSON.stringify({ file_key: uploaded.fileKey }),
          } satisfies PreparedMediaMessage
        }
        const uploaded = await uploadFile(asset, ctx, {
          fileType: "mp4",
          fileName: asset.filename,
          durationMs: part.durationMs,
        })
        return {
          msgType: "media",
          content: JSON.stringify({ file_key: uploaded.fileKey, duration: part.durationMs }),
        } satisfies PreparedMediaMessage
      }
      case "file": {
        const uploaded = await uploadFile(asset, ctx, {
          fileType: inferFileType(asset.filename, asset.contentType),
          fileName: asset.filename,
        })
        return {
          msgType: "file",
          content: JSON.stringify({ file_key: uploaded.fileKey }),
        } satisfies PreparedMediaMessage
      }
    }
  }

  async function uploadImage(asset: LoadedAsset, ctx: FeishuApiContext): Promise<UploadImageResult> {
    const body = new FormData()
    body.set("image_type", "message")
    body.set("image", new File([toBlobPart(asset.buffer)], asset.filename, { type: asset.contentType }))

    const token = await ctx.getAccessToken()
    const response = await fetch(`${ctx.apiBase}/im/v1/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    })

    const result = (await response.json()) as { code?: number; msg?: string; data?: { image_key?: string } }
    if (result.code !== 0 || !result.data?.image_key) {
      throw new Error(`Image upload failed: ${result.msg ?? `code ${result.code}`}`)
    }

    return { imageKey: result.data.image_key }
  }

  async function uploadFile(
    asset: LoadedAsset,
    ctx: FeishuApiContext,
    options: { fileType: string; fileName: string; durationMs?: number },
  ): Promise<UploadFileResult> {
    const body = new FormData()
    body.set("file_type", options.fileType)
    body.set("file_name", sanitizeFileName(options.fileName))
    if (options.durationMs) {
      body.set("duration", String(options.durationMs))
    }
    body.set("file", new File([toBlobPart(asset.buffer)], options.fileName, { type: asset.contentType }))

    const token = await ctx.getAccessToken()
    const response = await fetch(`${ctx.apiBase}/im/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    })

    const result = (await response.json()) as { code?: number; msg?: string; data?: { file_key?: string } }
    if (result.code !== 0 || !result.data?.file_key) {
      throw new Error(`File upload failed: ${result.msg ?? `code ${result.code}`}`)
    }

    return { fileKey: result.data.file_key }
  }
}

type LoadedAsset = {
  buffer: Uint8Array
  filename: string
  contentType: string
}

async function loadAsset(part: Exclude<ChannelTypes.OutboundPart, { type: "text" }>): Promise<LoadedAsset> {
  if (part.path) {
    const file = Bun.file(part.path)
    const buffer = new Uint8Array(await file.arrayBuffer())
    return {
      buffer,
      filename: part.filename ?? path.basename(part.path),
      contentType: part.contentType || file.type || inferContentTypeFromName(part.filename ?? path.basename(part.path)),
    }
  }

  if (part.url) {
    const response = await fetch(part.url)
    if (!response.ok) {
      throw new Error(`Failed to fetch outbound media: HTTP ${response.status}`)
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    const filename = part.filename ?? inferFileNameFromUrl(part.url) ?? `attachment-${Date.now()}`
    return {
      buffer,
      filename,
      contentType: part.contentType || response.headers.get("content-type") || inferContentTypeFromName(filename),
    }
  }

  throw new Error(`Outbound ${part.type} part requires either path or url`)
}

function inferFileType(filename: string, contentType?: string) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === ".mp4" || contentType?.startsWith("video/")) return "mp4"
  if (ext === ".opus" || contentType?.startsWith("audio/")) return "opus"
  if (ext === ".pdf") return "pdf"
  if ([".doc", ".docx"].includes(ext)) return "doc"
  if ([".xls", ".xlsx", ".csv"].includes(ext)) return "xls"
  if ([".ppt", ".pptx"].includes(ext)) return "ppt"
  return "stream"
}

function inferContentTypeFromName(filename: string) {
  const ext = path.extname(filename).toLowerCase()
  if ([".png"].includes(ext)) return "image/png"
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg"
  if ([".webp"].includes(ext)) return "image/webp"
  if ([".gif"].includes(ext)) return "image/gif"
  if ([".pdf"].includes(ext)) return "application/pdf"
  if ([".mp4"].includes(ext)) return "video/mp4"
  if ([".opus"].includes(ext)) return "audio/ogg"
  return "application/octet-stream"
}

function inferFileNameFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname
    const base = path.basename(pathname)
    return base || undefined
  } catch {
    return undefined
  }
}

function toBlobPart(buffer: Uint8Array) {
  return new Uint8Array(buffer)
}

function sanitizeFileName(fileName: string) {
  return /^[\x20-\x7E]+$/.test(fileName)
    ? fileName
    : encodeURIComponent(fileName).replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29")
}
