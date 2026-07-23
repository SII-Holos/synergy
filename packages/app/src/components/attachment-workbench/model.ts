import type { AttachmentPart, Part, ToolPart } from "@ericsanchezok/synergy-sdk"

export const ATTACHMENT_TEXT_MAX_BYTES = 4 * 1024 * 1024
export const ATTACHMENT_PDF_MAX_BYTES = 50 * 1024 * 1024

export interface AttachmentResourceState {
  version: 1
  sessionID: string
  messageID: string
  attachmentID: string
}

export type AttachmentPreviewKind = "pdf" | "markdown" | "html" | "source" | "video" | "audio" | "unsupported"

export interface AttachmentPreviewCapability {
  kind: AttachmentPreviewKind
  defaultMode: "preview" | "source"
  dual: boolean
  maxBytes?: number
}

export class AttachmentTooLargeError extends Error {
  constructor(
    readonly limit: number,
    readonly actual?: number,
  ) {
    super("Attachment exceeds the preview size limit")
    this.name = "AttachmentTooLargeError"
  }
}

export function attachmentResourceState(value: unknown): AttachmentResourceState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  if (state.version !== 1) return undefined
  if (typeof state.sessionID !== "string" || !state.sessionID) return undefined
  if (typeof state.messageID !== "string" || !state.messageID) return undefined
  if (typeof state.attachmentID !== "string" || !state.attachmentID) return undefined
  return {
    version: 1,
    sessionID: state.sessionID,
    messageID: state.messageID,
    attachmentID: state.attachmentID,
  }
}

export function attachmentResourceId(state: AttachmentResourceState): string {
  return [state.sessionID, state.messageID, state.attachmentID].map(encodeURIComponent).join("/")
}

function completedToolAttachments(part: Part): AttachmentPart[] {
  if (part.type !== "tool") return []
  const state = (part as ToolPart).state
  return state.status === "completed" ? (state.attachments ?? []) : []
}

export function findAttachmentByLocator(
  parts: Part[] | undefined,
  locator: AttachmentResourceState,
): AttachmentPart | undefined {
  for (const part of parts ?? []) {
    if (part.type === "attachment" && part.id === locator.attachmentID) return part
    const nested = completedToolAttachments(part).find((attachment) => attachment.id === locator.attachmentID)
    if (nested) return nested
  }
  return undefined
}

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "text/csv",
  "text/plain",
  "text/xml",
  "text/x-markdown",
  "text/yaml",
])

function extension(filename: string | undefined) {
  return filename?.split(".").at(-1)?.toLowerCase()
}

export function classifyAttachmentPreview(mime: string, filename?: string): AttachmentPreviewCapability {
  const ext = extension(filename)
  if (mime === "application/pdf" || ext === "pdf") {
    return { kind: "pdf", defaultMode: "preview", dual: false, maxBytes: ATTACHMENT_PDF_MAX_BYTES }
  }
  if (mime === "text/markdown" || mime === "text/x-markdown" || ext === "md" || ext === "markdown") {
    return { kind: "markdown", defaultMode: "preview", dual: true, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  }
  if (mime === "text/html" || ext === "html" || ext === "htm") {
    return { kind: "html", defaultMode: "preview", dual: true, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  }
  if (mime.startsWith("video/")) return { kind: "video", defaultMode: "preview", dual: false }
  if (mime.startsWith("audio/")) return { kind: "audio", defaultMode: "preview", dual: false }
  if (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    ["json", "jsonc", "xml", "yaml", "yml", "csv", "ts", "tsx", "js", "jsx", "css", "py", "rs", "go", "sh"].includes(
      ext ?? "",
    )
  ) {
    return { kind: "source", defaultMode: "source", dual: false, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  }
  return { kind: "unsupported", defaultMode: "preview", dual: false }
}

export async function fetchAttachmentBytes(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error(`Attachment request failed (${response.status})`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new AttachmentTooLargeError(maxBytes, declared)

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new AttachmentTooLargeError(maxBytes, bytes.byteLength)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new AttachmentTooLargeError(maxBytes, total)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
