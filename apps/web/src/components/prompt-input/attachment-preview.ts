import type { UploadedAttachmentPart } from "@/context/prompt"
import type { AttachmentFile } from "@ericsanchezok/synergy-ui/attachment-card"
import type { ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import { uploadedPromptAttachmentToFile } from "./attachment-files"

export interface PromptUploadEntry {
  attachment: UploadedAttachmentPart
  file: AttachmentFile
  imagePreview?: ImagePreviewImage
  imagePreviewIndex?: number
}

export type PromptImagePreviewResolver = (
  serverUrl: string,
  file: AttachmentFile,
  index: number,
) => ImagePreviewImage | undefined

export function buildPromptUploadEntries(
  serverUrl: string,
  uploads: UploadedAttachmentPart[],
  resolveImagePreviewImage: PromptImagePreviewResolver,
): PromptUploadEntry[] {
  let previewIndex = 0
  return uploads.map((attachment, index) => {
    const file = uploadedPromptAttachmentToFile(attachment)
    const imagePreview = resolveImagePreviewImage(serverUrl, file, index)
    if (!imagePreview) return { attachment, file }
    return { attachment, file, imagePreview, imagePreviewIndex: previewIndex++ }
  })
}
