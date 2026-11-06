import type { ImagePreviewImage } from "./image-preview-model"

export type ImageViewerActionResult = "completed" | "dispatched" | "cancelled"
export type ImageViewerAction = (
  image: Readonly<ImagePreviewImage>,
  signal: AbortSignal,
) => Promise<ImageViewerActionResult>
export interface ImageViewerActions {
  copy?: ImageViewerAction
  save?: ImageViewerAction
  copyLink?: ImageViewerAction
  openExternal?: ImageViewerAction
}
