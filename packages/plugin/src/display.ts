export interface ToolMediaDisplay {
  type: "image" | "video" | "audio"
  actionLabel?: string
  pendingTitle?: string
  pendingDescription?: string
  aspectRatio?: "1:1" | "4:3" | "16:9" | "auto"
}

export interface ToolDisplay {
  kind?: "default" | "media-generation"
  visibility?: "default" | "media" | "hidden-unless-error"
  presentation?: "default" | "attachment-only"
  media?: ToolMediaDisplay
  primaryAttachmentIds?: string[]
}
