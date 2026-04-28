import fs from "fs/promises"
import os from "os"
import path from "path"
import { ulid } from "ulid"
import { Identifier } from "@/id/id"
import { Global } from "@/global"
import type { MessageV2 } from "@/session/message-v2"
import { Document } from "@/util/document"

const LOCAL_MEDIA_MIME_PREFIXES = ["image/", "audio/", "video/"]

export namespace Attachment {
  export interface Target {
    filename?: string
    filepath?: string
    mime?: string
  }

  export interface DataPart {
    url: string
    mime: string
    filename?: string
  }

  export interface FilePartInput {
    filepath: string
    mime: string
    sessionID: string
    messageID: string
    filename?: string
    id?: string
    localPath?: string
    source?: MessageV2.FilePart["source"]
    metadata?: MessageV2.FilePart["metadata"]
  }

  export interface Policy {
    extractText: boolean
    keepBinary: boolean
    saveLocal: boolean
    kind: "image" | "pdf" | "document" | "media" | "other"
  }

  export function policy(target: Target): Policy {
    const ext = extension(target)
    const mime = target.mime || mimeFromExtension(ext)

    if (mime.startsWith("image/")) {
      return {
        kind: "image",
        extractText: false,
        keepBinary: true,
        saveLocal: true,
      }
    }

    if (mime === "application/pdf" || ext === ".pdf") {
      return {
        kind: "pdf",
        extractText: true,
        keepBinary: true,
        saveLocal: false,
      }
    }

    if (Document.supported(target.filepath ?? target.filename ?? "")) {
      return {
        kind: "document",
        extractText: true,
        keepBinary: false,
        saveLocal: false,
      }
    }

    if (LOCAL_MEDIA_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
      return {
        kind: "media",
        extractText: false,
        keepBinary: true,
        saveLocal: true,
      }
    }

    return {
      kind: "other",
      extractText: false,
      keepBinary: false,
      saveLocal: false,
    }
  }

  /** MIME types under `application/` that are actually human-readable text. */
  const TEXT_APPLICATION_TYPES = new Set([
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/x-sh",
    "application/x-shellscript",
    "application/sql",
    "application/graphql",
    "application/x-httpd-php",
    "application/xhtml+xml",
  ])

  /** RFC 6838 structured syntax suffixes that indicate text-based content. */
  const TEXT_SUFFIXES = ["+json", "+xml", "+yaml", "+csv"]

  export function isText(mime: string): boolean {
    if (mime.startsWith("text/")) return true
    if (TEXT_APPLICATION_TYPES.has(mime)) return true
    // e.g. application/ld+json, application/vnd.api+json, application/atom+xml
    if (TEXT_SUFFIXES.some((suffix) => mime.endsWith(suffix))) return true
    return false
  }

  export function decodeDataUrl(url: string) {
    const marker = ";base64,"
    const markerIndex = url.indexOf(marker)
    if (markerIndex === -1 || !url.startsWith("data:")) {
      throw new Error("Invalid data URL")
    }
    const mime = url.slice(5, markerIndex).split(";")[0]
    const data = url.slice(markerIndex + marker.length)
    return {
      mime,
      buffer: Buffer.from(data, "base64"),
    }
  }

  export async function extractTextFromDataPart(part: DataPart): Promise<string> {
    const buffer = decodeDataUrl(part.url).buffer
    const tmpPath = path.join(os.tmpdir(), `synergy-doc-${ulid()}${extension(part)}`)
    try {
      await Bun.write(tmpPath, buffer)
      return await Document.extractText(tmpPath)
    } finally {
      await fs.unlink(tmpPath).catch(() => {})
    }
  }

  export async function extractTextFromFile(filepath: string): Promise<string> {
    return await Document.extractText(filepath)
  }

  export async function saveDataPartLocally(part: DataPart): Promise<string> {
    const buffer = decodeDataUrl(part.url).buffer
    const now = new Date()
    const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    const mediaDir = path.join(Global.Path.media, dateFolder)
    await fs.mkdir(mediaDir, { recursive: true })
    const ext = extension(part) || `.${fileExtensionFromMime(part.mime)}`
    const filename = part.filename || `${ulid()}${ext}`
    const localPath = path.join(mediaDir, filename)
    await Bun.write(localPath, buffer)
    return localPath
  }

  export async function toFilePart(input: FilePartInput): Promise<MessageV2.FilePart> {
    const file = Bun.file(input.filepath)
    return {
      id: input.id ?? Identifier.ascending("part"),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "file",
      url: dataUrl(input.mime, await file.bytes()),
      mime: input.mime,
      filename: input.filename,
      localPath: input.localPath,
      source: input.source,
      metadata: input.metadata,
    }
  }

  export function dataUrl(mime: string, bytes: Uint8Array | ArrayBufferLike) {
    const buffer = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes))
    return `data:${mime};base64,${buffer.toString("base64")}`
  }

  function extension(target: Target) {
    const value = target.filepath ?? target.filename ?? ""
    return path.extname(value).toLowerCase()
  }

  function mimeFromExtension(ext: string) {
    if (ext === ".pdf") return "application/pdf"
    if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return "application/octet-stream"
  }

  function fileExtensionFromMime(mime: string) {
    return mime.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg").split("+")[0] || "bin"
  }
}
