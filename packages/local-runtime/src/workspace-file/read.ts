import path from "path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { FileMutation } from "../file/mutation"
import { FileEntry } from "../file/entry"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
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

function binaryFromSample(bytes: Uint8Array) {
  for (const byte of bytes) {
    if (byte === 0) return true
  }
  return false
}

async function readBytes(
  absolute: string,
  info: WorkspaceFile.Node,
  limit: number,
  validate: (path: string) => Promise<void>,
) {
  const target = await FileMutation.canonical(absolute)
  await validate(target)
  const file = await fs.open(
    target,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
  )
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw new FileMutation.AccessDeniedError("Path is not a readable file")
    if (
      Number(before.size) !== info.size ||
      (info.entryVersion && (await FileEntry.inspect(absolute))?.version !== info.entryVersion)
    )
      throw new FileMutation.ConflictError()
    const buffer = Buffer.allocUnsafe(Math.min(limit, info.size))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new FileMutation.ConflictError()
      offset += bytesRead
    }
    const after = await file.stat({ bigint: true })
    await validate(target)
    if ((await FileMutation.canonical(absolute)) !== target) throw new FileMutation.ConflictError()
    const current = await fs.stat(target, { bigint: true })
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== current.dev ||
      before.ino !== current.ino
    )
      throw new FileMutation.ConflictError()
    return buffer
  } finally {
    await file.close()
  }
}

async function isBinaryTextCandidate(
  absolute: string,
  mime: string | undefined,
  read: (limit: number) => Promise<Uint8Array>,
) {
  if (mime?.startsWith("text/")) return false
  if (mime?.includes("charset=")) return false
  if (knownTextByExtension(absolute)) return false
  return binaryFromSample(await read(4096)) || likelyBinaryByExtension(absolute)
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
      validate(path: string): Promise<void>
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

    const mimeType = Bun.file(absolute).type || undefined
    const contents = (limit: number) => readBytes(absolute, info, limit, deps.validate)
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
      const buffer = await contents(IMAGE_READ_BYTES)
      return {
        kind: "image",
        path: info.path,
        node: info,
        content: Buffer.from(buffer).toString("base64"),
        contentVersion: FileTime.version(new Uint8Array(buffer)),
        mimeType,
        encoding: "base64",
        totalBytes: info.size,
        truncated: false,
      }
    }

    if (await isBinaryTextCandidate(absolute, mimeType, contents)) {
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
    const buffer = await contents(bytesToRead)
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer, { stream: capped })
      if (text.includes("\0")) throw new Error("Binary content")
    } catch {
      return {
        kind: "binary",
        path: info.path,
        node: info,
        mimeType,
        totalBytes: info.size,
        truncated: capped,
        unsupportedReason: "The file is not valid UTF-8 text",
      }
    }
    const contentVersion = capped ? undefined : FileTime.version(buffer)
    const lines = text.split(/\r?\n/)
    if (input.mode === "document") {
      return {
        kind: "text",
        contentVersion,
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
      contentVersion,
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
