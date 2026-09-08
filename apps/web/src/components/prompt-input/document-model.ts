import type { Prompt } from "@/context/prompt"
import type { ComposerEdit, TextRange } from "./composer-document"

export function promptDocumentMapping(prompt: Prompt) {
  const segments: Array<{ index: number; text: TextRange; dom: TextRange }> = []
  let textOffset = 0
  let domOffset = 0
  prompt.forEach((part, index) => {
    if (part.type !== "text" && part.type !== "file") return
    const length = part.content.length
    if (part.type === "text") {
      segments.push({
        index,
        text: { start: textOffset, end: textOffset + length },
        dom: { start: domOffset, end: domOffset + length },
      })
      textOffset += length
    }
    domOffset += length
  })
  return { segments, textLength: textOffset }
}

export function applyPromptDocumentEdits(prompt: Prompt, edits: ComposerEdit[]): Prompt {
  const mapping = promptDocumentMapping(prompt)
  const ordered = edits.toSorted((a, b) => b.range.start - a.range.start || b.range.end - a.range.end)
  const changes = ordered.map((edit, index) => {
    const segment = mapping.segments.find(
      (part) => edit.range.start >= part.text.start && edit.range.end <= part.text.end,
    )
    if (
      !Number.isInteger(edit.range.start) ||
      !Number.isInteger(edit.range.end) ||
      edit.range.end < edit.range.start ||
      !segment
    ) {
      throw new Error("Composer edit range is not editable")
    }
    if (index > 0 && edit.range.end > ordered[index - 1]!.range.start) throw new Error("Composer edits overlap")
    return { edit, segment }
  })
  const next = prompt.slice()
  for (const { edit, segment } of changes) {
    const part = next[segment.index]!
    if (part.type !== "text") throw new Error("Composer edit target is not text")
    next[segment.index] = {
      ...part,
      content:
        part.content.slice(0, edit.range.start - segment.text.start) +
        edit.text +
        part.content.slice(edit.range.end - segment.text.start),
    }
  }
  let offset = 0
  return next.map((part) => {
    if (part.type !== "text" && part.type !== "file") return part
    const start = offset
    offset += part.content.length
    return part.start === start && part.end === offset ? part : { ...part, start, end: offset }
  })
}
