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

export async function uploadPromptAttachment(serverUrl: string, file: File): Promise<{ url: string; mime: string }> {
  const form = new FormData()
  form.append("file", file)
  const res = await fetch(`${serverUrl}/asset`, { method: "POST", body: form })
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${res.statusText}`)
  const data = (await res.json()) as { url?: string; mime?: string }
  return { url: data.url || "", mime: data.mime || file.type || "text/plain" }
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
      reject(new Error("Failed to decode image"))
    }
    image.src = url
  })
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

  let image: HTMLImageElement
  try {
    image = await loadImage(file)
  } catch {
    throw new PromptAttachmentError(
      "Couldn’t attach image",
      "This image couldn’t be processed. Try a PNG, JPEG, or WebP image.",
    )
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

  if (file.size <= TARGET_IMAGE_BYTES) {
    return {
      mime: file.type,
      dataUrl: await readAsDataUrl(file),
    }
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
