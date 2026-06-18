import { Patch } from "./input"
import type { Cursor, Edit } from "./types"

export type PatchOp =
  | { type: "replace"; startLine: number; endLine: number; lines: string[] }
  | { type: "delete"; startLine: number; endLine: number }
  | { type: "insert"; position: "before" | "after"; lineNumber: number; lines: string[] }
  | { type: "insert"; position: "head" | "tail"; lines: string[] }
  | { type: "blockSwap"; blockRef: string; lines: string[] }

export interface HashlinePatch {
  path: string
  tag: string
  ops: PatchOp[]
}

function cursorKey(cursor: Cursor): string {
  if (cursor.kind === "bof" || cursor.kind === "eof") return cursor.kind
  return `${cursor.kind}:${cursor.anchor.line}`
}

function cursorToInsertPosition(
  cursor: Cursor,
): { position: "before" | "after"; lineNumber: number } | { position: "head" | "tail" } {
  if (cursor.kind === "bof") return { position: "head" }
  if (cursor.kind === "eof") return { position: "tail" }
  if (cursor.kind === "before_anchor") return { position: "before", lineNumber: cursor.anchor.line }
  return { position: "after", lineNumber: cursor.anchor.line }
}

function editsToPatchOps(edits: readonly Edit[]): PatchOp[] {
  const ops: PatchOp[] = []
  let index = 0

  while (index < edits.length) {
    const edit = edits[index]

    if (edit.kind === "block") {
      if (edit.mode === "insert_after") {
        ops.push({ type: "insert", position: "after", lineNumber: edit.anchor.line, lines: edit.payloads })
      } else if (edit.payloads.length === 0) {
        ops.push({ type: "delete", startLine: edit.anchor.line, endLine: edit.anchor.line })
      } else {
        ops.push({ type: "blockSwap", blockRef: String(edit.anchor.line), lines: edit.payloads })
      }
      index++
      continue
    }

    if (edit.kind === "insert" && edit.mode === "replacement" && edit.cursor.kind === "before_anchor") {
      const startLine = edit.cursor.anchor.line
      const replacementLines: string[] = []
      while (index < edits.length) {
        const candidate = edits[index]
        if (
          candidate.kind !== "insert" ||
          candidate.mode !== "replacement" ||
          candidate.cursor.kind !== "before_anchor" ||
          candidate.cursor.anchor.line !== startLine
        ) {
          break
        }
        replacementLines.push(candidate.text)
        index++
      }

      const deleteLines: number[] = []
      while (index < edits.length && edits[index].kind === "delete") {
        deleteLines.push((edits[index] as Extract<Edit, { kind: "delete" }>).anchor.line)
        index++
      }
      if (deleteLines.length === 0) throw new Error("replacement insert group is missing delete anchors")
      ops.push({
        type: "replace",
        startLine: Math.min(...deleteLines),
        endLine: Math.max(...deleteLines),
        lines: replacementLines,
      })
      continue
    }

    if (edit.kind === "delete") {
      const deleteLines: number[] = []
      while (index < edits.length && edits[index].kind === "delete") {
        deleteLines.push((edits[index] as Extract<Edit, { kind: "delete" }>).anchor.line)
        index++
      }
      ops.push({ type: "delete", startLine: Math.min(...deleteLines), endLine: Math.max(...deleteLines) })
      continue
    }

    if (edit.kind === "insert") {
      const key = cursorKey(edit.cursor)
      const lines: string[] = []
      const position = cursorToInsertPosition(edit.cursor)
      while (index < edits.length) {
        const candidate = edits[index]
        if (candidate.kind !== "insert" || candidate.mode === "replacement" || cursorKey(candidate.cursor) !== key)
          break
        lines.push(candidate.text)
        index++
      }
      if (position.position === "before" || position.position === "after") {
        ops.push({ type: "insert", position: position.position, lineNumber: position.lineNumber, lines })
      } else {
        ops.push({ type: "insert", position: position.position, lines })
      }
      continue
    }
  }

  return ops
}

function sectionToHashlinePatch(section: ReturnType<typeof Patch.parseSingle>): HashlinePatch {
  if (!section.fileHash) throw new Error("Invalid patch header. Expected [path#TAG].")
  return { path: section.path, tag: section.fileHash, ops: editsToPatchOps(section.edits) }
}

/** @deprecated Use `Patch.parse` from `./input` instead. */
export function parseHashlinePatch(input: string): HashlinePatch {
  return sectionToHashlinePatch(Patch.parseSingle(input))
}

/** @deprecated Use `Patch.parse` from `./input` instead. */
export function parseMultiSectionPatch(input: string): { sections: HashlinePatch[] } {
  const patch = Patch.parse(input)
  return { sections: patch.sections.map(sectionToHashlinePatch) }
}
