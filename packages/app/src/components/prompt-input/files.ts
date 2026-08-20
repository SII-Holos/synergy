export const MAX_ATTACHMENT_FILES = 20
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024

/**
 * Any file type can be attached. Format policy is decided server-side
 * (`Attachment.policy`): readable formats are extracted or sent to the model
 * directly, everything else is attached as-is with a durable local path the
 * agent can inspect through tools.
 */
export const FILE_INPUT_ACCEPT = "*/*"

export function isPromptAttachmentOversized(file: File): boolean {
  return file.size > MAX_ATTACHMENT_FILE_BYTES
}

export function partitionPromptAttachmentFiles(files: Iterable<File>) {
  const accepted: File[] = []
  const rejected: File[] = []
  for (const file of files) {
    if (isPromptAttachmentOversized(file)) {
      rejected.push(file)
    } else {
      accepted.push(file)
    }
  }
  return { accepted, rejected }
}

export function formatAttachmentBatchToast(
  files: File[],
): { type: "warning"; title: string; description: string } | undefined {
  if (files.length > MAX_ATTACHMENT_FILES) {
    return {
      type: "warning",
      title: "Too many files",
      description: `Choose at most ${MAX_ATTACHMENT_FILES} files.`,
    }
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    return {
      type: "warning",
      title: "Files too large",
      description: `Choose files totaling at most ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB.`,
    }
  }
  return undefined
}

function formatRejectedFileNames(rejected: File[]) {
  const shown = rejected.slice(0, 3).map((file) => file.name || "unnamed file")
  const extra = rejected.length - shown.length
  const suffix = extra > 0 ? `, and ${extra} more` : ""
  return `${shown.join(", ")}${suffix}`
}

export function formatOversizedAttachmentToast(rejected: File[], acceptedCount: number) {
  if (rejected.length === 0) return
  const title =
    rejected.length === 1 ? "File too large" : acceptedCount > 0 ? "Some files were not attached" : "No files attached"
  return {
    type: "warning" as const,
    title,
    description: `Too large: ${formatRejectedFileNames(rejected)}. Files must be ${MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)} MB or smaller.`,
  }
}
