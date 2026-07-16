interface ImageMediaTypeModel {
  capabilities: {
    input: {
      supportedImageMediaTypes?: readonly string[]
    }
  }
}

export function normalizeImageMediaTypes(mediaTypes: readonly string[] | undefined): string[] | undefined {
  if (mediaTypes === undefined) return
  const normalized = mediaTypes
    .map((mimeType) => mimeType.trim().toLowerCase())
    .filter((mimeType) => mimeType.startsWith("image/"))
  return normalized.length > 0 ? [...new Set(normalized)] : undefined
}

export function supportsImageMediaType(model: ImageMediaTypeModel, mimeType: string): boolean {
  const supported = normalizeImageMediaTypes(model.capabilities.input.supportedImageMediaTypes)
  if (!supported) return true
  return supported.includes(mimeType.trim().toLowerCase())
}
