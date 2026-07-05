export interface ToolMediaDisplay {
  type: "image" | "video" | "audio"
  actionLabel?: string
  pendingTitle?: string
  pendingDescription?: string
  aspectRatio?: "1:1" | "4:3" | "16:9" | "auto"
  size?: "small" | "medium" | "large"
}

export interface ToolDisplay {
  kind?: "default" | "media-generation"
  toolCard?: "visible" | "hidden"
  media?: ToolMediaDisplay
}
