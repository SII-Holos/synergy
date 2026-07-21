export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
export const ACCEPTED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]
export const ACCEPTED_TEXT_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".log",
  ".lua",
  ".m",
  ".md",
  ".mjs",
  ".patch",
  ".php",
  ".pl",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svg",
  ".svelte",
  ".swift",
  ".tex",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]
export const ACCEPTED_TEXT_MIME_PATTERNS = [
  "text/*",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]
export const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_DOCUMENT_TYPES]
export const FILE_INPUT_ACCEPT = [
  ...ACCEPTED_FILE_TYPES,
  ...ACCEPTED_TEXT_MIME_PATTERNS,
  ...ACCEPTED_TEXT_EXTENSIONS,
].join(",")

export const SUPPORTED_ATTACHMENT_DESCRIPTION = "Supported: images, PDF/Office documents, and text/code files."

const ACCEPTED_FILE_TYPE_SET = new Set<string>(ACCEPTED_FILE_TYPES)
const ACCEPTED_TEXT_EXTENSION_SET = new Set(ACCEPTED_TEXT_EXTENSIONS)
const ACCEPTED_TEXT_MIME_TYPES = new Set(ACCEPTED_TEXT_MIME_PATTERNS.filter((pattern) => !pattern.endsWith("/*")))

function fileExtension(file: File) {
  const filename = file.name.split(/[\\/]/).pop() ?? file.name
  const index = filename.lastIndexOf(".")
  if (index <= 0) return ""
  return filename.slice(index).toLowerCase()
}

export function isPromptAttachmentTextFile(file: File): boolean {
  const normalizedMime = file.type.toLowerCase()
  if (normalizedMime.startsWith("text/")) return true
  if (ACCEPTED_TEXT_MIME_TYPES.has(normalizedMime)) return true
  if (
    normalizedMime.endsWith("+json") ||
    normalizedMime.endsWith("+xml") ||
    normalizedMime.endsWith("+yaml") ||
    normalizedMime.endsWith("+yml")
  ) {
    return true
  }
  if (normalizedMime && normalizedMime !== "application/octet-stream") return false
  return ACCEPTED_TEXT_EXTENSION_SET.has(fileExtension(file))
}

export function isPromptAttachmentFileAccepted(file: File): boolean {
  return ACCEPTED_FILE_TYPE_SET.has(file.type.toLowerCase()) || isPromptAttachmentTextFile(file)
}

export function partitionPromptAttachmentFiles(files: Iterable<File>) {
  const accepted: File[] = []
  const rejected: File[] = []
  for (const file of files) {
    if (isPromptAttachmentFileAccepted(file)) {
      accepted.push(file)
    } else {
      rejected.push(file)
    }
  }
  return { accepted, rejected }
}

function formatRejectedFileNames(rejected: File[]) {
  const shown = rejected.slice(0, 3).map((file) => file.name || "unnamed file")
  const extra = rejected.length - shown.length
  const suffix = extra > 0 ? `, and ${extra} more` : ""
  return `${shown.join(", ")}${suffix}`
}

export function formatUnsupportedAttachmentToast(rejected: File[], acceptedCount: number) {
  if (rejected.length === 0) return
  const title =
    rejected.length === 1
      ? "Unsupported file type"
      : acceptedCount > 0
        ? "Some files were not attached"
        : "No supported files attached"
  return {
    type: "warning" as const,
    title,
    description: `Unsupported: ${formatRejectedFileNames(rejected)}. ${SUPPORTED_ATTACHMENT_DESCRIPTION}`,
  }
}
