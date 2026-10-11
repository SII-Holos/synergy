import { AttachmentImageInput } from "@ericsanchezok/synergy-harness/attachment/image-input"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

const budget = AttachmentImageInput.BUDGET
const CACHE_BYTES = 64 * 1024 * 1024
const state = RuntimeContext.state(() => ({
  cache: new Map<string, AttachmentImageInput.Result>(),
  bytes: 0,
  tail: Promise.resolve(),
}))

function dimensions(width: number, height: number) {
  let scale = Math.min(
    1,
    budget.maxDimension / Math.max(width, height),
    Math.sqrt((budget.maxPatches * budget.patchSize ** 2) / (width * height)),
  )
  while (true) {
    const target = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
    const patches = Math.ceil(target.width / budget.patchSize) * Math.ceil(target.height / budget.patchSize)
    if (patches <= budget.maxPatches) return target
    scale *= Math.sqrt(budget.maxPatches / patches) * 0.999
  }
}

function size(result: AttachmentImageInput.Result) {
  return result.ok ? result.data.length * 2 : 0
}

async function processImage(bytes: Uint8Array, signal: AbortSignal): Promise<AttachmentImageInput.Result> {
  signal.throwIfAborted()
  const module = await import("sharp").catch(() => undefined)
  signal.throwIfAborted()
  if (!module) return { ok: false, reason: "unavailable" }
  const sharp = module.default
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const image = sharp(input, { failOn: "warning", limitInputPixels: budget.maxInputPixels, sequentialRead: true })
  try {
    const metadata = await image.metadata()
    signal.throwIfAborted()
    if (!metadata.width || !metadata.height) return { ok: false, reason: "invalid" }
    if (!["png", "jpeg", "webp", "gif", "heif", "tiff"].includes(metadata.format))
      return { ok: false, reason: "invalid" }
    const swapped = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8
    const originalWidth = swapped ? metadata.height : metadata.width
    const originalHeight = swapped ? metadata.width : metadata.height
    let target = dimensions(originalWidth, originalHeight)
    const unchanged = target.width === originalWidth && target.height === originalHeight
    const originalMime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[metadata.format as string]
    const preserve =
      unchanged &&
      originalMime &&
      input.length <= budget.maxBytes &&
      metadata.depth === "uchar" &&
      (!metadata.orientation || metadata.orientation === 1) &&
      (!metadata.pages || metadata.pages === 1) &&
      ["srgb", "b-w"].includes(metadata.space)
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted()
      const pipeline = image
        .clone()
        .rotate()
        .resize(target.width, target.height, { fit: "fill", withoutEnlargement: true })
        .toColourspace("srgb")
        .timeout({ seconds: 10 })
      try {
        const output = await (metadata.format === "jpeg" ? pipeline.jpeg({ quality: 85 }) : pipeline.png()).toBuffer({
          resolveWithObject: true,
        })
        signal.throwIfAborted()
        if (preserve || output.data.length <= budget.maxBytes) {
          return {
            ok: true,
            data: (preserve ? input : output.data).toString("base64"),
            mediaType: preserve ? originalMime : metadata.format === "jpeg" ? "image/jpeg" : "image/png",
            width: output.info.width,
            height: output.info.height,
            originalWidth,
            originalHeight,
          }
        }
        const scale = Math.min(0.8, Math.sqrt(budget.maxBytes / output.data.length) * 0.95)
        target = {
          width: Math.max(1, Math.floor(target.width * scale)),
          height: Math.max(1, Math.floor(target.height * scale)),
        }
      } finally {
        pipeline.destroy()
      }
    }
    return { ok: false, reason: "too-large" }
  } catch {
    signal.throwIfAborted()
    return { ok: false, reason: "invalid" }
  } finally {
    image.destroy()
  }
}

export function registerImageInput() {
  AttachmentImageInput.register((bytes, signal) => {
    const current = state()
    // Serialize native decoding per Runtime so simultaneous turns cannot multiply large raster allocations.
    const pending = current.tail.then(async () => {
      signal.throwIfAborted()
      const key = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const cached = current.cache.get(key)
      if (cached) {
        current.cache.delete(key)
        current.cache.set(key, cached)
        return cached
      }
      const result = await processImage(bytes, signal)
      signal.throwIfAborted()
      if (!result.ok) return result
      current.cache.set(key, Object.freeze(result))
      current.bytes += size(result)
      while (current.cache.size > 32 || current.bytes > CACHE_BYTES) {
        const oldest = current.cache.keys().next().value!
        current.bytes -= size(current.cache.get(oldest)!)
        current.cache.delete(oldest)
      }
      return result
    })
    current.tail = pending.then(
      () => {},
      () => {},
    )
    return pending
  })
}
