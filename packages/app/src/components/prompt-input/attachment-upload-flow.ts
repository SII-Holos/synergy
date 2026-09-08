import type { UploadedAttachmentPart } from "@/context/prompt"
import type { UploadedPromptAttachment } from "@/utils/prompt-attachment"
import type { PendingAttachmentTracker } from "./pending-attachments"

export interface PendingAttachmentUploadInput {
  file: File
  id: string
  tracker: PendingAttachmentTracker
  upload: (file: File) => Promise<UploadedPromptAttachment>
  insertAttachment: (attachment: UploadedAttachmentPart) => void
  /** False once the destination changed mid-flight (e.g. session switch). */
  isDestinationCurrent: () => boolean
}

/**
 * Optimistic composer attachment upload: the pending card appears the moment
 * a file is chosen, the upload runs in the background, and the settled result
 * is inserted as a real prompt part under the same id so the flash card hands
 * over to the normal attachment card without a visible jump. Cancellation and
 * destination changes drop the result instead of inserting it.
 */
export async function runPendingAttachmentUpload(input: PendingAttachmentUploadInput): Promise<void> {
  const { file, id, tracker } = input
  tracker.begin({ id, filename: file.name, mime: file.type || "application/octet-stream", size: file.size })
  try {
    const uploaded = await input.upload(file)
    if (tracker.isCancelled(id)) return
    if (!input.isDestinationCurrent()) {
      tracker.end(id)
      return
    }
    input.insertAttachment({
      type: "attachment",
      id,
      filename: file.name,
      mime: uploaded.mime,
      url: uploaded.url,
      size: uploaded.size,
      metadata: uploaded.metadata,
      presentation: uploaded.presentation,
    })
    tracker.markUploaded(id)
  } catch (error) {
    tracker.end(id)
    throw error
  }
}
