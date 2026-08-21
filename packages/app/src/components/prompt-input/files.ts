import type { I18n, MessageDescriptor } from "@lingui/core"

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

/** Lingui runtime descriptors for prompt-attachment limit feedback. Translate
 *  at the call site via `i18n._(descriptor)` so toasts follow the locale. */
export const FILE_LIMIT_MESSAGES = {
  tooManyFilesTitle: { id: "prompt.files.tooManyFiles.title", message: "Too many files" },
  tooManyFilesDescription: { id: "prompt.files.tooManyFiles.description", message: "Choose at most {count} files." },
  tooLargeTotalTitle: { id: "prompt.files.tooLargeTotal.title", message: "Files too large" },
  tooLargeTotalDescription: {
    id: "prompt.files.tooLargeTotal.description",
    message: "Choose files totaling at most {total} MB.",
  },
  fileTooLargeTitle: { id: "prompt.files.fileTooLarge.title", message: "File too large" },
  someFilesNotAttachedTitle: { id: "prompt.files.someFilesNotAttached.title", message: "Some files were not attached" },
  noFilesAttachedTitle: { id: "prompt.files.noFilesAttached.title", message: "No files attached" },
  tooLargeNamesDescription: {
    id: "prompt.files.tooLargeNames.description",
    message: "Too large: {names}. Files must be {limit} MB or smaller.",
  },
} as const satisfies Record<string, MessageDescriptor>

export type AttachmentLimitScope = { count: number; bytes: number }

export function isPromptAttachmentOversized(file: File): boolean {
  return file.size > MAX_ATTACHMENT_FILE_BYTES
}
/** Split newly selected files into accepted/rejected by the per-file size
 *  limit only. Batch count/total limits (including capacity already consumed
 *  by composer attachments) are owned by `formatAttachmentBatchToast`. */
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
  existing: AttachmentLimitScope = { count: 0, bytes: 0 },
  i18n?: I18n,
): { type: "warning"; title: string; description: string } | undefined {
  if (files.length + existing.count > MAX_ATTACHMENT_FILES) {
    return warningToast(i18n, FILE_LIMIT_MESSAGES.tooManyFilesTitle, FILE_LIMIT_MESSAGES.tooManyFilesDescription, {
      count: MAX_ATTACHMENT_FILES,
    })
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) + existing.bytes
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    return warningToast(i18n, FILE_LIMIT_MESSAGES.tooLargeTotalTitle, FILE_LIMIT_MESSAGES.tooLargeTotalDescription, {
      total: MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024),
    })
  }
  return undefined
}

function warningToast(
  i18n: I18n | undefined,
  title: MessageDescriptor,
  description: MessageDescriptor,
  values: Record<string, unknown>,
) {
  return {
    type: "warning" as const,
    title: i18n ? i18n._(title) : interpolate(title.message!, values),
    description: i18n ? i18n._({ ...description, values }) : interpolate(description.message!, values),
  }
}

function interpolate(message: string, values: Record<string, unknown>): string {
  return message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""))
}

function formatRejectedFileNames(rejected: File[]) {
  const shown = rejected.slice(0, 3).map((file) => file.name || "unnamed file")
  const extra = rejected.length - shown.length
  const suffix = extra > 0 ? `, and ${extra} more` : ""
  return `${shown.join(", ")}${suffix}`
}

export function formatOversizedAttachmentToast(
  rejected: File[],
  acceptedCount: number,
  i18n?: I18n,
): { type: "warning"; title: string; description: string } | undefined {
  if (rejected.length === 0) return undefined
  const titleDescriptor =
    rejected.length === 1
      ? FILE_LIMIT_MESSAGES.fileTooLargeTitle
      : acceptedCount > 0
        ? FILE_LIMIT_MESSAGES.someFilesNotAttachedTitle
        : FILE_LIMIT_MESSAGES.noFilesAttachedTitle
  const values = {
    names: formatRejectedFileNames(rejected),
    limit: MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024),
  }
  return {
    type: "warning" as const,
    title: i18n ? i18n._(titleDescriptor) : titleDescriptor.message,
    description: i18n
      ? i18n._({ ...FILE_LIMIT_MESSAGES.tooLargeNamesDescription, values })
      : interpolate(FILE_LIMIT_MESSAGES.tooLargeNamesDescription.message!, values),
  }
}
