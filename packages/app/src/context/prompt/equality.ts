import type { FileSelection } from "@/context/file"
import type {
  FileAttachmentPart,
  NoteAttachmentPart,
  Prompt,
  SessionAttachmentPart,
  TextPart,
  UploadedAttachmentPart,
} from "./index"

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    const partA = promptA[i]
    const partB = promptB[i]
    if (partA.type !== partB.type) return false
    if (partA.type === "text" && partA.content !== (partB as TextPart).content) {
      return false
    }
    if (partA.type === "file") {
      const fileA = partA as FileAttachmentPart
      const fileB = partB as FileAttachmentPart
      if (fileA.path !== fileB.path) return false
      if (!isSelectionEqual(fileA.selection, fileB.selection)) return false
    }
    if (partA.type === "attachment" && partA.id !== (partB as UploadedAttachmentPart).id) {
      return false
    }
    if (partA.type === "note" && partA.id !== (partB as NoteAttachmentPart).id) {
      return false
    }
    if (partA.type === "session" && partA.id !== (partB as SessionAttachmentPart).id) {
      return false
    }
  }
  return true
}
