import type { UploadedAttachmentPart } from "@/context/prompt"
import { Identifier } from "@/utils/id"

export function createUploadedAttachmentInputPart(
  attachment: UploadedAttachmentPart,
  id = Identifier.ascending("part"),
) {
  return {
    id,
    type: "attachment" as const,
    mime: attachment.mime,
    url: attachment.url,
    filename: attachment.filename,
    metadata: attachment.metadata,
    presentation: attachment.presentation,
  }
}
