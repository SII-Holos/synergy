export interface ToolIconSource {
  src: string
  mimeType?: string
  sizes?: string[]
  theme?: "light" | "dark"
}

export const MAX_TOOL_ICON_BYTES = 64 * 1024

export function toolIconSources(value: unknown): ToolIconSource[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 3).flatMap((item) => {
    if (!item || typeof item !== "object" || typeof item.src !== "string") return []
    if (item.src.length > Math.ceil(MAX_TOOL_ICON_BYTES / 3) * 4 + 64) return []
    if (!/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.src)) return []
    if (item.theme !== undefined && item.theme !== "light" && item.theme !== "dark") return []
    return [
      {
        src: item.src,
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(item.theme ? { theme: item.theme } : {}),
      },
    ]
  })
}

export interface ToolMediaDisplay {
  type: "image" | "video" | "audio"
  actionLabel?: string
  pendingTitle?: string
  pendingDescription?: string
  aspectRatio?: "1:1" | "4:3" | "16:9" | "auto"
  size?: "small" | "medium" | "large"
}

export interface ToolDisplay {
  /** A registered host/plugin glyph or bounded image data from the tool owner. */
  icon?: string | ToolIconSource[]
  kind?: "default" | "media-generation"
  toolCard?: "visible" | "hidden"
  media?: ToolMediaDisplay
}
