const THUMBNAIL_MAX_DIMENSION = 128
const THUMBNAIL_MIME = "image/webp"
const THUMBNAIL_QUALITY = 0.78
const BITMAP_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
let imagePipelineWarmup: Promise<void> | undefined

export class PromptAttachmentError extends Error {
  constructor(
    readonly title: string,
    message: string,
  ) {
    super(message)
    this.name = "PromptAttachmentError"
  }
}

export interface UploadedPromptAttachment {
  mime: string
  url: string
  size?: number
  metadata?: Record<string, unknown>
  presentation?: {
    renderer?: "thumbnail"
    size?: "small"
    crop?: boolean
  }
}

type AssetUploadClient = {
  asset: {
    upload: (params?: {
      file?: unknown
    }) => Promise<{ data?: { id?: string; url?: string; mime?: string; size?: number } }>
  }
}

function assetUrl(data: { id?: string; url?: string } | undefined) {
  if (!data) return ""
  if (data.url) return data.url
  return data.id ? `asset://${data.id}` : ""
}

async function uploadAsset(client: AssetUploadClient, file: File): Promise<UploadedPromptAttachment> {
  const res = await client.asset.upload({ file })
  const data = res.data
  const url = assetUrl(data)
  if (!url) throw new PromptAttachmentError("Couldn't attach file", "The server did not return an asset URL.")
  return {
    url,
    mime: data?.mime ?? file.type ?? "application/octet-stream",
    size: data?.size ?? file.size,
  }
}

function isBitmapImage(file: File) {
  return BITMAP_IMAGE_TYPES.has(file.type.toLowerCase())
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
 */
async function stripCicpFromPng(file: File): Promise<File> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength < 20) return file

  const bytes = new Uint8Array(buffer)
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
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) return file

    if (
      bytes[offset + 4] === 0x63 &&
      bytes[offset + 5] === 0x49 &&
      bytes[offset + 6] === 0x43 &&
      bytes[offset + 7] === 0x50
    ) {
      const before = new Uint8Array(buffer, 0, offset)
      const after = new Uint8Array(buffer, chunkEnd)
      const result = new Uint8Array(before.length + after.length)
      result.set(before, 0)
      result.set(after, before.length)
      return new File([result], file.name, { type: file.type })
    }

    offset = chunkEnd
  }

  return file
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality))
}
export function warmPromptAttachmentImagePipeline() {
  if (imagePipelineWarmup) return imagePipelineWarmup
  if (typeof document === "undefined" || typeof Image === "undefined") return Promise.resolve()

  imagePipelineWarmup = (async () => {
    const seedCanvas = document.createElement("canvas")
    seedCanvas.width = 1
    seedCanvas.height = 1
    seedCanvas.getContext("2d")?.clearRect(0, 0, 1, 1)

    const seedBlob = await canvasToBlob(seedCanvas, "image/png")
    const thumbnailCanvas = document.createElement("canvas")
    thumbnailCanvas.width = 1
    thumbnailCanvas.height = 1

    const thumbnailContext = thumbnailCanvas.getContext("2d")
    if (!thumbnailContext) return

    if (seedBlob && typeof File !== "undefined") {
      const image = await loadImage(new File([seedBlob], "prompt-attachment-warmup.png", { type: "image/png" })).catch(
        () => undefined,
      )
      if (image) thumbnailContext.drawImage(image, 0, 0, 1, 1)
    }

    await canvasToBlob(thumbnailCanvas, THUMBNAIL_MIME, THUMBNAIL_QUALITY)
  })().catch(() => undefined)

  return imagePipelineWarmup
}

export function schedulePromptAttachmentImagePipelineWarmup() {
  if (typeof window === "undefined") return

  const warm = () => void warmPromptAttachmentImagePipeline()
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(warm, { timeout: 1500 })
    return
  }

  window.setTimeout(warm, 250)
}

async function createThumbnailFile(file: File): Promise<File | undefined> {
  if (!isBitmapImage(file)) return undefined

  let image: HTMLImageElement
  try {
    image = await loadImage(file)
  } catch (error) {
    throw new PromptAttachmentError(
      "Couldn't attach image",
      error instanceof Error ? error.message : "This image couldn't be processed.",
    )
  }

  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  const scale = longest > 0 ? Math.min(1, THUMBNAIL_MAX_DIMENSION / longest) : 1
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))

  const context = canvas.getContext("2d")
  if (!context) throw new PromptAttachmentError("Couldn't attach image", "Failed to create an image thumbnail.")

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  const blob = await canvasToBlob(canvas, THUMBNAIL_MIME, THUMBNAIL_QUALITY)
  if (!blob) throw new PromptAttachmentError("Couldn't attach image", "Failed to create an image thumbnail.")

  return new File([blob], `${file.name}.thumb.webp`, { type: THUMBNAIL_MIME })
}

async function normalizeFileForUpload(file: File) {
  if (file.type === "image/png") return stripCicpFromPng(file)
  return file
}

export async function uploadPromptAttachment(client: AssetUploadClient, file: File): Promise<UploadedPromptAttachment> {
  const uploadFile = await normalizeFileForUpload(file)
  const uploaded = await uploadAsset(client, uploadFile)
  if (!isBitmapImage(uploadFile)) return uploaded

  const thumbnailFile = await createThumbnailFile(uploadFile)
  if (!thumbnailFile) return uploaded

  const thumbnail = await uploadAsset(client, thumbnailFile)
  return {
    ...uploaded,
    metadata: {
      thumbnail: {
        url: thumbnail.url,
        mime: thumbnail.mime,
        size: thumbnail.size,
      },
    },
    presentation: {
      renderer: "thumbnail",
      size: "small",
      crop: true,
    },
  }
}
