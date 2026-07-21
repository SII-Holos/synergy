import type { UploadedAttachmentPart } from "@/context/prompt"
import { Identifier } from "@/utils/id"

export function createUploadedAttachmentInputPart(attachment: UploadedAttachmentPart) {
  return {
    id: Identifier.ascending("part"),
    type: "attachment" as const,
    mime: attachment.mime,
    url: attachment.url,
    filename: attachment.filename,
    metadata: attachment.metadata,
    presentation: attachment.presentation,
    model: attachment.mime.startsWith("image/")
      ? { mode: "provider-file" as const, summary: `${attachment.filename} (${attachment.mime})` }
      : { mode: "summary" as const, summary: `${attachment.filename} (${attachment.mime})` },
  }
}
