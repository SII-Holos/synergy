import type { WorkspaceFileReadResult } from "@ericsanchezok/synergy-sdk"

export function filePreviewModel(content: WorkspaceFileReadResult | undefined) {
  const isImage = content?.kind === "image"
  const isSvg = content?.kind === "text" && content.mimeType === "image/svg+xml"
  const textContent = content?.kind === "text" ? content.content : ""
  const imageDataUrl = isImage ? `data:${content.mimeType};base64,${content.content}` : undefined
  const svgPreviewUrl = isSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(textContent)}` : undefined
  const binaryReason = content?.kind === "binary" ? content.unsupportedReason : undefined
  return {
    textContent,
    isImage,
    isSvg,
    imageDataUrl,
    svgPreviewUrl,
    binaryReason,
  }
}
