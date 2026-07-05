import type { BunFile } from "bun"
import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { Attachment } from "../attachment"

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".svg": "image/svg+xml",
}

const DESCRIPTION = `Load a local image file into the current model context for direct visual inspection.

Use this when the active model supports image input and you need to inspect an image yourself, such as a generated plot, screenshot, diagram, rendered page, or visual artifact. The tool does not analyze the image with a separate model; it attaches the image so the current model can see it on the next model step.

Use look_at instead when view_image is unavailable because the current model does not support image input. Use attach only when the user should receive or inspect the file.`

const parameters = z.object({
  filePath: z.string().describe("Absolute path to the local image file to load into the current model context"),
})

interface ViewImageMetadata {
  filePath?: string
  filename?: string
  mimeType?: string
  sizeBytes?: number
  modelContext?: boolean
  truncated?: boolean
  preview?: string
  error?: string
}

export const ViewImageTool = Tool.define<typeof parameters, ViewImageMetadata>("view_image", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath)
      ? params.filePath
      : path.join(ScopeContext.current.directory, params.filePath)
    const filename = path.basename(filepath)
    const file = Bun.file(filepath)

    if (!(await file.exists())) {
      return {
        title: "File not found",
        output: `Error: File not found: ${filepath}`,
        metadata: { filePath: filepath, filename, error: "file_not_found" },
      }
    }

    const mimeType = inferImageMimeType(filepath, file.type)
    if (!mimeType.startsWith("image/")) {
      return {
        title: "Unsupported file type",
        output: `${filename}: ${mimeType} is not an image. Use read/scan_document for text or document extraction.`,
        metadata: {
          filePath: filepath,
          filename,
          mimeType,
          error: "unsupported_file_type",
        },
      }
    }

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      metadata: {},
    })

    const sizeBytes = (await file.stat()).size
    if (!(await isValidImageFile(file, mimeType))) {
      return {
        title: "Unsupported file type",
        output: `${filename}: content does not match ${mimeType}. Use read/scan_document for text or document extraction.`,
        metadata: {
          filePath: filepath,
          filename,
          mimeType,
          error: "unsupported_file_type",
        },
      }
    }
    const summary = `${filename} (${mimeType}) loaded by view_image`
    const preview = `Image loaded into the current model context: ${filename} (${mimeType}, ${formatSize(sizeBytes)}). The active model can inspect it directly on the next model step.`

    return {
      title: `Viewed Image: ${filename}`,
      output: preview,
      metadata: {
        filePath: filepath,
        filename,
        mimeType,
        sizeBytes,
        modelContext: true,
        truncated: false,
        preview,
      },
      attachments: [
        await Attachment.toPart({
          filepath,
          mime: mimeType,
          filename,
          localPath: filepath,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          presentation: { renderer: "image", size: "medium", crop: false },
          model: { mode: "provider-file", summary },
        }),
      ],
    }
  },
})

function inferImageMimeType(filepath: string, fileType: string): string {
  if (fileType.startsWith("image/")) return fileType
  return IMAGE_MIME_BY_EXTENSION[path.extname(filepath).toLowerCase()] ?? (fileType || "application/octet-stream")
}

async function isValidImageFile(file: BunFile, mimeType: string): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 4100).arrayBuffer())
  if (mimeType === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff])
  if (mimeType === "image/gif")
    return startsWith(bytes, [...byteString("GIF87a")]) || startsWith(bytes, [...byteString("GIF89a")])
  if (mimeType === "image/webp")
    return (
      startsWith(bytes, [...byteString("RIFF")]) && byteString("WEBP").every((byte, index) => bytes[8 + index] === byte)
    )
  if (mimeType === "image/svg+xml") return looksLikeSvg(bytes)
  if (mimeType === "image/heic" || mimeType === "image/heif") return looksLikeHeif(bytes)
  return mimeType.startsWith("image/")
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((byte, index) => bytes[index] === byte)
}

function byteString(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0))
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes).trimStart()
  return text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))
}

function looksLikeHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const brands = ["ftypheic", "ftypheix", "ftyphevc", "ftyphevx", "ftypmif1", "ftypmsf1"]
  const header = new TextDecoder().decode(bytes.slice(4, 16))
  return brands.some((brand) => header.startsWith(brand))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
