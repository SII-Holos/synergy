import type { ImagePreviewImage } from "./image-preview-model"
export interface AttachmentFile {
  mime: string
  filename?: string
  url?: string
  assetId?: string
  size?: number
  localPath?: string
  presentation?: AttachmentPresentation
  metadata?: Record<string, unknown>
  source?: unknown
}

export type AttachmentRenderer = "image" | "video" | "audio" | "thumbnail" | "file"
export type AttachmentDisplaySize = "original" | "small" | "medium" | "large"

export interface AttachmentPresentation {
  hidden?: boolean
  renderer?: AttachmentRenderer
  size?: AttachmentDisplaySize
  crop?: boolean
}

export interface ResolvedAttachmentPresentation {
  hidden: boolean
  renderer: AttachmentRenderer
  size: AttachmentDisplaySize
  crop: boolean
}

export function joinServerUrl(serverUrl: string, pathname: string): string {
  return `${serverUrl.replace(/\/$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`
}

export function resolveAttachmentUrl(serverUrl: string, file: AttachmentFile): string | undefined {
  if (file.url) {
    if (file.url.startsWith("asset://")) {
      return joinServerUrl(serverUrl, `/asset/${file.url.slice(8)}`)
    }
    if (file.url.startsWith("file://")) {
      return undefined
    }
    if (file.url.startsWith("/")) {
      return joinServerUrl(serverUrl, file.url)
    }
    if (/^(data|https?):/i.test(file.url)) {
      return file.url
    }
    return undefined
  }
  if (file.assetId) {
    return joinServerUrl(serverUrl, `/asset/${file.assetId}`)
  }
  return undefined
}

export function resolveAttachmentThumbnailUrl(serverUrl: string, file: AttachmentFile): string | undefined {
  const thumbnail = file.metadata?.thumbnail
  if (!thumbnail || typeof thumbnail !== "object" || Array.isArray(thumbnail)) return undefined
  const record = thumbnail as Record<string, unknown>
  const url = typeof record.url === "string" ? record.url : undefined
  const assetId = typeof record.assetId === "string" ? record.assetId : undefined
  if (!url && !assetId) return undefined
  return resolveAttachmentUrl(serverUrl, { ...file, url, assetId })
}

export function resolveAttachmentPresentation(file: AttachmentFile): ResolvedAttachmentPresentation {
  const presentation = file.presentation ?? {}
  const requested = presentation.renderer
  const hasThumbnail = hasAttachmentThumbnail(file)
  const renderer =
    requested === "thumbnail" && !hasThumbnail ? "file" : (requested ?? inferAttachmentRenderer(file, hasThumbnail))

  return {
    hidden: presentation.hidden === true,
    renderer,
    size: presentation.size ?? "medium",
    crop: presentation.crop === true,
  }
}

function inferAttachmentRenderer(file: AttachmentFile, hasThumbnail: boolean): AttachmentRenderer {
  if (file.mime.startsWith("image/")) return "image"
  if (file.mime.startsWith("video/")) return "video"
  if (file.mime.startsWith("audio/")) return "audio"
  if (hasThumbnail) return "thumbnail"
  return "file"
}

function hasAttachmentThumbnail(file: AttachmentFile): boolean {
  const thumbnail = file.metadata?.thumbnail
  if (!thumbnail || typeof thumbnail !== "object" || Array.isArray(thumbnail)) return false
  const record = thumbnail as Record<string, unknown>
  return typeof record.url === "string" || typeof record.assetId === "string"
}

export function attachmentKind(file: AttachmentFile): string {
  if (isPdf(file)) return "PDF"
  if (isHtml(file)) return "HTML"
  if (file.mime === "text/csv") return "CSV"
  if (file.mime.includes("wordprocessingml")) return "DOCX"
  if (file.mime.includes("spreadsheetml")) return "XLSX"
  if (file.mime.includes("presentationml")) return "PPTX"
  if (file.mime === "application/zip") return "ZIP"
  if (file.mime.startsWith("image/")) return file.mime.split("/")[1]?.toUpperCase() ?? "IMAGE"
  return file.mime.split("/")[1]?.toUpperCase() ?? "FILE"
}

export function formatAttachmentSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function attachmentMeta(file: AttachmentFile): string {
  return [attachmentKind(file), formatAttachmentSize(attachmentSize(file)), attachmentSource(file)]
    .filter(Boolean)
    .join(" · ")
}

export function attachmentColumnCount(files: { length: number }): number {
  if (files.length <= 1) return files.length
  if (files.length === 2) return 2
  return 3
}

export function attachmentColumns<T>(items: T[]): T[][] {
  const count = attachmentColumnCount(items)
  if (count === 0) return []

  const columns: T[][] = Array.from({ length: count }, () => [])

  for (let i = 0; i < items.length; i++) {
    columns[i % count].push(items[i])
  }

  return columns.filter((column) => column.length > 0)
}

export function resolveImagePreviewImage(
  serverUrl: string,
  file: AttachmentFile,
  index: number,
): ImagePreviewImage | undefined {
  if (!isImageAttachment(file)) return undefined
  const src = resolveAttachmentUrl(serverUrl, file)
  if (!src) return undefined

  const filename = file.filename ?? "image"
  const identity = file.url ?? file.assetId ?? file.localPath ?? filename
  return {
    id: `${index}:${identity}`,
    src,
    filename,
    mime: file.mime,
    size: attachmentSize(file),
    alt: filename,
    downloadUrl: src,
    externalUrl: src,
  }
}

export function isImageAttachment(file: AttachmentFile): boolean {
  return file.mime.startsWith("image/")
}

export function isPdfAttachment(file: AttachmentFile): boolean {
  return file.mime === "application/pdf"
}

export function isHtmlAttachment(file: AttachmentFile): boolean {
  return file.mime === "text/html"
}

function isPdf(file: AttachmentFile): boolean {
  return isPdfAttachment(file)
}

function isHtml(file: AttachmentFile): boolean {
  return isHtmlAttachment(file)
}

function attachmentSize(file: AttachmentFile): number | undefined {
  if (file.size !== undefined) return file.size
  const attachment = file.metadata?.attachment as Record<string, unknown> | undefined
  return typeof attachment?.size === "number" ? attachment.size : undefined
}

function attachmentSource(file: AttachmentFile): string | undefined {
  const attachment = file.metadata?.attachment as Record<string, unknown> | undefined
  const originTool = attachment?.originTool
  return typeof originTool === "string" && originTool ? `Generated by ${originTool}` : undefined
}
