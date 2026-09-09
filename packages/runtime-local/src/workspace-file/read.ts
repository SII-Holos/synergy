import path from "path"
import { WorkspaceFile } from "./types"

const TEXT_READ_BYTES = 4 * 1024 * 1024
const LARGE_TEXT_PREVIEW_BYTES = 512 * 1024
const IMAGE_READ_BYTES = 10 * 1024 * 1024
const DEFAULT_READ_LIMIT = 2000

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".lock",
  ".log",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zig",
])

export function likelyBinaryByExtension(filepath: string) {
  const ext = path.extname(filepath).toLowerCase()
  if (!ext) return false
  if (TEXT_EXTENSIONS.has(ext)) return false
  return [
    ".7z",
    ".avif",
    ".bin",
    ".class",
    ".dll",
    ".dmg",
    ".doc",
    ".docx",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".mov",
    ".mp3",
    ".mp4",
    ".pdf",
    ".png",
    ".rar",
    ".so",
    ".tar",
    ".wasm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ].includes(ext)
}

function knownTextByExtension(filepath: string) {
  return TEXT_EXTENSIONS.has(path.extname(filepath).toLowerCase())
}

function binaryFromSample(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  for (const byte of bytes) {
    if (byte === 0) return true
  }
  return false
}

async function isBinaryTextCandidate(absolute: string, size: number, mime: string | undefined) {
  if (mime?.startsWith("text/")) return false
  if (mime?.includes("charset=")) return false
  if (knownTextByExtension(absolute)) return false
  const file = Bun.file(absolute)
  const sample = await file
    .slice(0, Math.min(size, 4096))
    .arrayBuffer()
    .catch(() => new ArrayBuffer(0))
  return binaryFromSample(sample) || likelyBinaryByExtension(absolute)
}

export namespace WorkspaceFileRead {
  export async function read(
    input: {
      path: string
      offset?: number
      limit?: number
      preview?: boolean
      mode?: "range" | "document"
    },
    deps: {
      resolve(path: string): string
      node(path: string): Promise<WorkspaceFile.Node>
    },
  ): Promise<WorkspaceFile.ReadResult> {
    const absolute = deps.resolve(input.path)
    const info = await deps.node(absolute)
    if (info.type !== "file") {
      return {
        kind: "binary",
        path: info.path,
        node: info,
        totalBytes: info.size,
        truncated: false,
        unsupportedReason: "Path is not a readable file",
      }
    }

    const file = Bun.file(absolute)
    const mimeType = file.type || undefined
    if (mimeType?.startsWith("image/") && mimeType !== "image/svg+xml") {
      if (info.size > IMAGE_READ_BYTES) {
        return {
          kind: "binary",
          path: info.path,
          node: info,
          mimeType,
          totalBytes: info.size,
          truncated: true,
          unsupportedReason: "Image is too large to preview inline",
        }
      }
      const buffer = await file.arrayBuffer()
      return {
        kind: "image",
        path: info.path,
        node: info,
        content: Buffer.from(buffer).toString("base64"),
        mimeType,
        encoding: "base64",
        totalBytes: info.size,
        truncated: false,
      }
    }

    if (await isBinaryTextCandidate(absolute, info.size, mimeType)) {
      return {
        kind: "binary",
        path: info.path,
        node: info,
        mimeType,
        totalBytes: info.size,
        truncated: false,
        unsupportedReason: "Binary files do not have a text preview",
      }
    }

    const capped = info.size > TEXT_READ_BYTES
    const bytesToRead = capped ? LARGE_TEXT_PREVIEW_BYTES : info.size
    const text = await file.slice(0, bytesToRead).text()
    const lines = text.split(/\r?\n/)
    if (input.mode === "document") {
      return {
        kind: "text",
        path: info.path,
        node: info,
        content: text,
        mimeType,
        encoding: "utf-8",
        range: {
          offset: 0,
          limit: Math.max(1, lines.length),
          startLine: 1,
          endLine: lines.length,
        },
        totalBytes: info.size,
        lineCount: capped ? undefined : lines.length,
        truncated: capped,
        truncationReason: capped ? "size" : undefined,
      }
    }

    const offset = Math.max(0, input.offset ?? 0)
    const limit = Math.max(1, Math.min(input.limit ?? (input.preview ? 200 : DEFAULT_READ_LIMIT), 5000))
    const selected = lines.slice(offset, offset + limit)
    const endLine = offset + selected.length
    const hasMoreLines = endLine < lines.length
    const truncated = capped || hasMoreLines
    const nextRange = hasMoreLines
      ? {
          offset: endLine,
          limit,
          startLine: endLine + 1,
          endLine: Math.min(endLine + limit, lines.length),
        }
      : undefined

    return {
      kind: "text",
      path: info.path,
      node: info,
      content: selected.join("\n"),
      mimeType,
      encoding: "utf-8",
      range: {
        offset,
        limit,
        startLine: offset + 1,
        endLine,
      },
      totalBytes: info.size,
      lineCount: capped ? undefined : lines.length,
      truncated,
      truncationReason: hasMoreLines ? "range" : capped ? "size" : undefined,
      nextRange,
    }
  }
}
