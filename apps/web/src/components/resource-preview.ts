import { OFFICE_INPUT_MAX_BYTES } from "./attachment-workbench/office-contract"

export const ATTACHMENT_TEXT_MAX_BYTES = 4 * 1024 * 1024
export const ATTACHMENT_PDF_MAX_BYTES = 50 * 1024 * 1024

export type ResourcePreviewKind =
  | "docx"
  | "xlsx"
  | "pptx"
  | "svg"
  | "image"
  | "pdf"
  | "markdown"
  | "html"
  | "source"
  | "video"
  | "audio"
  | "unsupported"

export interface ResourcePreviewCapability {
  kind: ResourcePreviewKind
  defaultMode: "preview" | "source"
  dual: boolean
  maxBytes?: number
}

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "text/csv",
  "text/plain",
  "text/xml",
  "text/x-markdown",
  "text/yaml",
])

function extension(filename: string | undefined) {
  return filename?.split(".").at(-1)?.toLowerCase()
}

export function classifyResourcePreview(
  mime: string,
  filename?: string,
  contentKind?: "text" | "image" | "binary",
): ResourcePreviewCapability {
  mime = mime.split(";")[0]!.trim().toLowerCase()
  const ext = extension(filename)
  const officeMime: Record<string, "docx" | "xlsx" | "pptx"> = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  }
  const officeKind =
    officeMime[mime] ?? (["docx", "xlsx", "pptx"].includes(ext ?? "") ? (ext as "docx" | "xlsx" | "pptx") : undefined)
  if (officeKind)
    return {
      kind: officeKind,
      defaultMode: "preview",
      dual: false,
      maxBytes: OFFICE_INPUT_MAX_BYTES,
    }
  if ((mime === "image/svg+xml" || ext === "svg") && contentKind !== "binary")
    return { kind: "svg", defaultMode: "preview", dual: true, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  if (
    contentKind === "image" ||
    ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"].includes(ext ?? "") ||
    mime.startsWith("image/")
  )
    return { kind: "image", defaultMode: "preview", dual: false }
  if (mime === "application/pdf" || ext === "pdf") {
    return { kind: "pdf", defaultMode: "preview", dual: false, maxBytes: ATTACHMENT_PDF_MAX_BYTES }
  }
  if (
    contentKind !== "binary" &&
    (mime === "text/markdown" || mime === "text/x-markdown" || ext === "md" || ext === "markdown")
  ) {
    return { kind: "markdown", defaultMode: "preview", dual: true, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  }
  if (contentKind !== "binary" && (mime === "text/html" || ext === "html" || ext === "htm")) {
    return { kind: "html", defaultMode: "preview", dual: true, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  }
  if (mime.startsWith("video/") || ["mp4", "webm", "mov"].includes(ext ?? ""))
    return { kind: "video", defaultMode: "preview", dual: false }
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext ?? ""))
    return { kind: "audio", defaultMode: "preview", dual: false }
  if (
    contentKind !== "binary" &&
    (contentKind === "text" ||
      mime.startsWith("text/") ||
      TEXT_MIME_TYPES.has(mime) ||
      ["json", "jsonc", "xml", "yaml", "yml", "csv", "ts", "tsx", "js", "jsx", "css", "py", "rs", "go", "sh"].includes(
        ext ?? "",
      ))
  ) {
    return { kind: "source", defaultMode: "source", dual: false, maxBytes: ATTACHMENT_TEXT_MAX_BYTES }
  }
  return { kind: "unsupported", defaultMode: "preview", dual: false }
}
