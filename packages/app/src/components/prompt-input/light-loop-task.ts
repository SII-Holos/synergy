import type {
  ContextItem,
  FileAttachmentPart,
  NoteAttachmentPart,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"

const MAX_TASK_DESCRIPTION_LENGTH = 1800
const MAX_CONTEXT_LINES = 12

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

function fileSelectionText(selection?: { startLine?: number; endLine?: number }) {
  if (!selection) return ""
  if (selection.startLine === undefined && selection.endLine === undefined) return ""
  if (selection.endLine !== undefined && selection.endLine !== selection.startLine) {
    return ` lines ${selection.startLine ?? "?"}-${selection.endLine}`
  }
  return ` line ${selection.startLine ?? selection.endLine}`
}

export function buildLightLoopTaskDescription(input: {
  text: string
  uploads: UploadedAttachmentPart[]
  notes: NoteAttachmentPart[]
  sessions: SessionAttachmentPart[]
  fileAttachments: FileAttachmentPart[]
  contextItems: ContextItem[]
}) {
  const task = input.text.trim()
  if (!task) return undefined

  const context: string[] = []
  for (const file of input.fileAttachments) {
    context.push(`File: ${file.path}${fileSelectionText(file.selection)}`)
  }
  for (const item of input.contextItems) {
    if (item.type === "file") context.push(`Context file: ${item.path}${fileSelectionText(item.selection)}`)
  }
  for (const upload of input.uploads) {
    context.push(`Attachment: ${upload.filename}${upload.mime ? ` (${upload.mime})` : ""}`)
  }
  for (const note of input.notes) {
    context.push(`Note: ${note.title || "Untitled"} (${note.noteId})`)
  }
  for (const session of input.sessions) {
    context.push(`Session: ${session.title || "Untitled"} (${session.sessionId}, ${session.directory})`)
  }

  const uniqueContext = Array.from(new Set(context)).slice(0, MAX_CONTEXT_LINES)
  if (uniqueContext.length === 0) return truncate(task, MAX_TASK_DESCRIPTION_LENGTH)

  const result = `${task}\n\nContext:\n${uniqueContext.map((line) => `- ${line}`).join("\n")}`
  return truncate(result, MAX_TASK_DESCRIPTION_LENGTH)
}
