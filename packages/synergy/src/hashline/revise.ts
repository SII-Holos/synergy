import { applyEdits } from "./apply"
import type { PatchOp } from "./patch"
import type { Cursor, Edit } from "./types"

function patchOpsToEdits(ops: readonly PatchOp[]): Edit[] {
  const edits: Edit[] = []
  let index = 0

  const pushInsert = (cursor: Cursor, text: string, mode?: "replacement") => {
    edits.push({ kind: "insert", cursor, text, lineNum: 0, index: index++, ...(mode ? { mode } : {}) })
  }

  for (const op of ops) {
    if (op.type === "replace") {
      const cursor: Cursor = { kind: "before_anchor", anchor: { line: op.startLine } }
      for (const line of op.lines) pushInsert(cursor, line, "replacement")
      for (let line = op.startLine; line <= op.endLine; line++) {
        edits.push({ kind: "delete", anchor: { line }, lineNum: 0, index: index++ })
      }
      continue
    }

    if (op.type === "delete") {
      for (let line = op.startLine; line <= op.endLine; line++) {
        edits.push({ kind: "delete", anchor: { line }, lineNum: 0, index: index++ })
      }
      continue
    }

    if (op.type === "insert") {
      let cursor: Cursor
      if (op.position === "head") cursor = { kind: "bof" }
      else if (op.position === "tail") cursor = { kind: "eof" }
      else if ("lineNumber" in op && op.position === "before")
        cursor = { kind: "before_anchor", anchor: { line: op.lineNumber } }
      else if ("lineNumber" in op) cursor = { kind: "after_anchor", anchor: { line: op.lineNumber } }
      else throw new Error(`Invalid insert position: ${op.position}`)
      for (const line of op.lines) pushInsert(cursor, line)
      continue
    }

    const anchor = Number(op.blockRef)
    if (!Number.isInteger(anchor) || anchor < 1)
      throw new Error("SWAP.BLK compatibility ops require a numeric blockRef")
    edits.push({ kind: "block", anchor: { line: anchor }, payloads: op.lines, lineNum: 0, index: index++ })
  }

  return edits
}

/** @deprecated Use `applyEdits` from `./apply` with `Patch.parse` from `./input` instead. */
export function applyPatchOps(content: string, ops: readonly PatchOp[]): string {
  return applyEdits(content, patchOpsToEdits(ops)).text
}
