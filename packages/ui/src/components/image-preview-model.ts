import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
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
  referenceContext?: ResourceReference.Context
  sourcePath?: string
}

export interface ImagePreviewDimensions {
  width: number
  height: number
}

export function clampImageIndex(index: number | undefined, length: number): number {
  if (length <= 0) return 0
  if (index === undefined || !Number.isFinite(index)) return 0
  return Math.min(length - 1, Math.max(0, Math.trunc(index)))
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
