import type { UploadedAttachmentPart } from "@/context/prompt"
import type { AttachmentFile } from "@ericsanchezok/synergy-ui/attachment-card"

export function uploadedPromptAttachmentToFile(attachment: UploadedAttachmentPart): AttachmentFile {
  return {
    mime: attachment.mime,
    filename: attachment.filename,
    url: attachment.url,
    size: attachment.size,
    metadata: attachment.metadata,
    presentation: attachment.presentation ?? { renderer: "file", size: "small" },
  }
}
