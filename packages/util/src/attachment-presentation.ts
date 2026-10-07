import { z } from "zod"

export const AttachmentPresentation = z.object({
  purpose: z.enum(["evidence", "deliverable"]).optional(),
  hidden: z.boolean().optional(),
  renderer: z.enum(["image", "video", "audio", "thumbnail", "file"]).optional(),
  size: z.enum(["original", "small", "medium", "large"]).optional(),
  crop: z.boolean().optional(),
})
export type AttachmentPresentation = z.infer<typeof AttachmentPresentation>

export function attachmentPurpose(attachment: { presentation?: AttachmentPresentation }) {
  return attachment.presentation?.purpose === "evidence" ? "evidence" : "deliverable"
}
