import { formatAttachmentSize } from "./attachment-card-utils"

export interface ImagePreviewImage {
  id: string
  src: string
  filename: string
  mime: string
  size?: number
  alt?: string
  downloadUrl?: string
  externalUrl?: string
}

export interface ImagePreviewDimensions {
  width: number
  height: number
}

export const MIN_IMAGE_SCALE = 0.25
export const MAX_IMAGE_SCALE = 4
export const IMAGE_SCALE_STEP = 0.25

export function clampImageScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, value))
}

export function nextImageScale(current: number, direction: "in" | "out"): number {
  const delta = direction === "in" ? IMAGE_SCALE_STEP : -IMAGE_SCALE_STEP
  return clampImageScale(current + delta)
}

export function clampImageIndex(index: number | undefined, length: number): number {
  if (length <= 0) return 0
  if (index === undefined || !Number.isFinite(index)) return 0
  return Math.min(length - 1, Math.max(0, Math.trunc(index)))
}

export function nextImageIndex(current: number, direction: "previous" | "next", length: number): number {
  const delta = direction === "next" ? 1 : -1
  return clampImageIndex(current + delta, length)
}

export function imagePreviewMetadata(input: {
  image: Pick<ImagePreviewImage, "mime" | "size">
  dimensions?: ImagePreviewDimensions
  index?: number
  count?: number
}): string[] {
  const dimensions = input.dimensions ? `${input.dimensions.width} × ${input.dimensions.height}` : undefined
  const size = formatAttachmentSize(input.image.size)
  const position =
    input.index !== undefined && input.count !== undefined && input.count > 1
      ? `${input.index + 1} / ${input.count}`
      : undefined
  return [dimensions, size, input.image.mime, position].filter((item): item is string => Boolean(item))
}
