interface ImageMediaTypeModel {
  capabilities: {
    input: {
      supportedImageMediaTypes?: readonly string[]
    }
  }
}

/** Image MIME types safe to forward to any provider without an explicit
 *  capability declaration. Formats outside this set (TIFF, HEIC, BMP, ...)
 *  are downgraded to a local-path hint unless the model explicitly lists
 *  them, so an unlisted catalog never silently forwards an exotic format. */
export const PROVIDER_SAFE_IMAGE_MEDIA_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"]

export function normalizeImageMediaTypes(mediaTypes: readonly string[] | undefined): string[] | undefined {
  if (mediaTypes === undefined) return
  const normalized = mediaTypes
    .map((mimeType) => mimeType.trim().toLowerCase())
    .filter((mimeType) => mimeType.startsWith("image/"))
  return normalized.length > 0 ? [...new Set(normalized)] : undefined
}

export function supportsImageMediaType(model: ImageMediaTypeModel, mimeType: string): boolean {
  const supported = normalizeImageMediaTypes(model.capabilities.input.supportedImageMediaTypes)
  if (!supported) return PROVIDER_SAFE_IMAGE_MEDIA_TYPES.includes(mimeType.trim().toLowerCase())
  return supported.includes(mimeType.trim().toLowerCase())
}
