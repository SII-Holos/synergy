import { assetHttpUrl } from "@/utils/asset-url"

const TARGET_IMAGE_BYTES = 4.5 * 1024 * 1024
const IMAGE_SCALE_STEPS = [1, 0.85, 0.7, 0.6, 0.5, 0.4]
const IMAGE_QUALITY_STEPS = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]

const TEXT_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "graphql",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "log",
  "lua",
  "m",
  "md",
  "mjs",
  "patch",
  "php",
  "pl",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "svelte",
  "swift",
  "tex",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
])

export class PromptAttachmentError extends Error {
  constructor(
    readonly title: string,
    message: string,
  ) {
    super(message)
    this.name = "PromptAttachmentError"
  }
}

export interface PreparedPromptAttachment {
  mime: string
  dataUrl: string
}

export function isTextAttachmentFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true
  if (["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(file.type)) {
    return true
  }
  const normalizedMime = file.type.toLowerCase()
  if (
    normalizedMime.endsWith("+json") ||
    normalizedMime.endsWith("+xml") ||
    normalizedMime.endsWith("+yaml") ||
    normalizedMime.endsWith("+yml")
  ) {
    return true
  }
  if (normalizedMime && normalizedMime !== "application/octet-stream") return false
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (!extension) return false
  return TEXT_FILE_EXTENSIONS.has(extension)
}

export async function uploadPromptAttachment(
  client: {
    asset: { upload: (params?: { file?: unknown }) => Promise<{ data?: { id?: string; url?: string; mime?: string } }> }
  },
  baseUrl: string,
  file: File,
): Promise<{ url: string; mime: string }> {
  const res = await client.asset.upload({ file })
  const data = res.data as { id?: string; url?: string; mime?: string } | undefined
  return { url: assetHttpUrl(baseUrl, data), mime: data?.mime ?? file.type ?? "text/plain" }
}

function readAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error("Failed to read attachment"))
    reader.readAsDataURL(file)
  })
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      const size =
        file.size < 1024 * 1024 ? `${Math.round(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`
      reject(
        new Error(
          `Browser could not decode ${file.name} (${file.type || "unknown type"}, ${size}). ` +
            `The file may be corrupted or uses an unsupported variant.`,
        ),
      )
    }
    image.src = url
  })
}

/**
 * Strip the cICP (Coding-Independent Code Points) chunk from a PNG file.
 *
 * macOS screenshots on Display P3 monitors produce PNGs with both cICP and
 * iCCP chunks. Chromium's compositor can reject this combination when loaded
 * via URL.createObjectURL() + new Image(). Removing the ancillary cICP chunk
 * lets the decoder fall through to the standard iCCP path.
 *
 * This is a zero-dependency byte walker — no pixel decode, no decompression.
 * Cost: ~microseconds for typical PNGs.
 */
async function stripCicpFromPng(file: File): Promise<File> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength < 20) return file // PNG sig (8) + min chunk (12)

  const bytes = new Uint8Array(buffer)

  // PNG signature: \x89 P N G \r \n \x1a \n
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return file
  }

  let offset = 8
  while (offset + 12 <= bytes.length) {
    // Chunk length: big-endian uint32
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) return file // truncated chunk → bail

    // cICP chunk type bytes: 'c' 'I' 'C' 'P'
    if (
      bytes[offset + 4] === 0x63 &&
      bytes[offset + 5] === 0x49 &&
      bytes[offset + 6] === 0x43 &&
      bytes[offset + 7] === 0x50
    ) {
      // Rebuild buffer without this chunk
      const before = new Uint8Array(buffer, 0, offset)
      const after = new Uint8Array(buffer, chunkEnd)
      const result = new Uint8Array(before.length + after.length)
      result.set(before, 0)
      result.set(after, before.length)
      return new File([result], file.name, { type: file.type })
    }

    offset = chunkEnd
  }

  return file // cICP not found, pass through
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality))
}

function createCanvas(image: HTMLImageElement, scale: number) {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))

  const context = canvas.getContext("2d")
  if (!context) throw new Error("Failed to create image canvas")

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

function outputMimes(inputMime: string) {
  if (inputMime === "image/jpeg") return ["image/jpeg", "image/webp"]
  return ["image/webp", "image/jpeg"]
}

export async function preparePromptAttachment(file: File): Promise<PreparedPromptAttachment> {
  if (!file.type.startsWith("image/")) {
    return {
      mime: file.type,
      dataUrl: await readAsDataUrl(file),
    }
  }

  if (file.type === "image/gif") {
    if (file.size > TARGET_IMAGE_BYTES) {
      throw new PromptAttachmentError(
        "GIF too large",
        "Animated GIFs must already be small enough to attach. Use a smaller GIF or attach a still image instead.",
      )
    }
    return {
      mime: file.type,
      dataUrl: await readAsDataUrl(file),
    }
  }

  // Strip cICP chunk from PNGs before decode — Chromium's compositor
  // rejects Display P3 PNGs when both cICP and iCCP chunks are present.
  // Removing the ancillary cICP chunk lets the decoder fall through to
  // the iCCP profile path, which handles P3 correctly.
  if (file.type === "image/png") {
    file = await stripCicpFromPng(file)
  }

  let image: HTMLImageElement
  try {
    image = await loadImage(file)
  } catch (error) {
    throw new PromptAttachmentError(
      "Couldn’t attach image",
      error instanceof Error ? error.message : "This image couldn’t be processed.",
    )
  }

  for (const mime of outputMimes(file.type)) {
    for (const scale of IMAGE_SCALE_STEPS) {
      const canvas = createCanvas(image, scale)
      for (const quality of IMAGE_QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, mime, quality)
        if (!blob || blob.size > TARGET_IMAGE_BYTES) continue
        return {
          mime,
          dataUrl: await readAsDataUrl(blob),
        }
      }
    }
  }

  throw new PromptAttachmentError(
    "Image too large",
    "This image couldn’t be shrunk enough to attach safely. Try a smaller image.",
  )
}
