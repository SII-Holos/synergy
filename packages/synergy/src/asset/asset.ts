import path from "path"
import { Global } from "@/global"

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/pdf": "pdf",
}

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
}

export namespace Asset {
  export function dir(): string {
    return Global.Path.assets
  }

  export function isValidId(id: string): boolean {
    return /^[a-f0-9]{16}(\.[a-z0-9]+)?$/.test(id)
  }

  export function filePath(id: string): string {
    return path.join(Global.Path.assets, id)
  }

  export function resolvePath(id: string): string | undefined {
    if (!isValidId(id)) return undefined
    const assetDir = path.resolve(dir())
    const resolved = path.resolve(assetDir, id)
    const relative = path.relative(assetDir, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
    return resolved
  }

  export function generateId(buffer: Buffer, mime: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(buffer).digest("hex").slice(0, 16)
    const ext = MIME_TO_EXT[mime] ?? "bin"
    return `${hash}.${ext}`
  }

  export async function write(buffer: Buffer, mime: string): Promise<string> {
    const id = generateId(buffer, mime)
    await Bun.write(filePath(id), buffer)
    return id
  }

  export async function read(id: string): Promise<ReturnType<typeof Bun.file> | undefined> {
    const file = Bun.file(filePath(id))
    if (!(await file.exists())) return undefined
    return file
  }

  export function mimeFromExt(ext: string): string {
    return EXT_TO_MIME[ext] ?? "application/octet-stream"
  }

  export function extFromMime(mime: string): string | undefined {
    return MIME_TO_EXT[mime]
  }

  export function extFromName(name: string): string | undefined {
    const dot = name.lastIndexOf(".")
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : undefined
  }

  export function extFromId(id: string): string {
    const dot = id.lastIndexOf(".")
    return dot >= 0 ? id.slice(dot + 1) : "bin"
  }
}
