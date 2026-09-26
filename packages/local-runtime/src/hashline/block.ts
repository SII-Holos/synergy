/**
 * Expand deferred block edits (`replace_block N:` / `delete_block N` /
 * `insert_after_block N:`) into concrete inserts + deletes.
 */
import { STRUCTURAL_CLOSER_RE } from "./apply"
import {
  BLOCK_RESOLVER_UNAVAILABLE,
  blockSingleLineMessage,
  blockUnresolvedMessage,
  insertAfterBlockCloserLoweredWarning,
  insertAfterBlockUnresolvedLoweredWarning,
} from "./messages"
import type { BlockResolution, BlockResolver, Cursor, Edit } from "./types"

export interface ResolveBlockEditsOptions {
  onUnresolved?: "throw" | "drop"
  onResolved?: (resolution: BlockResolution) => void
  onWarning?: (message: string) => void
}

/** True when at least one edit is an unresolved deferred block edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
  return edits.some((edit) => edit.kind === "block")
}

/** Resolve every deferred block edit in `edits` against `text`. */
export function resolveBlockEdits(
  edits: readonly Edit[],
  text: string,
  path: string,
  resolver: BlockResolver | undefined,
  options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
  if (!hasBlockEdit(edits)) return edits
  const onUnresolved = options.onUnresolved ?? "throw"
  const resolved: Edit[] = []
  let synthIndex = 0
  for (const edit of edits) {
    if (edit.kind !== "block") {
      resolved.push(edit)
      continue
    }
    const op = edit.mode === "insert_after" ? "insert_after" : edit.payloads.length === 0 ? "delete" : "replace"
    const span = resolver ? resolver({ path, text, line: edit.anchor.line }) : null
    if (span === null) {
      if (op === "insert_after") {
        const anchorText = text.split("\n")[edit.anchor.line - 1]
        const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText)
        options.onWarning?.(
          isCloser
            ? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
            : insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
        )
        for (const payload of edit.payloads) {
          const cursor: Cursor = { kind: "after_anchor", anchor: { line: edit.anchor.line } }
          resolved.push({ kind: "insert", cursor, text: payload, lineNum: edit.lineNum, index: synthIndex++ })
        }
        continue
      }
      if (onUnresolved === "drop") continue
      throw new Error(
        `line ${edit.lineNum}: ${resolver ? blockUnresolvedMessage(edit.anchor.line, op, text.split("\n")) : BLOCK_RESOLVER_UNAVAILABLE}`,
      )
    }
    if (span.start === span.end) {
      if (onUnresolved === "drop") continue
      throw new Error(`line ${edit.lineNum}: ${blockSingleLineMessage(edit.anchor.line, op)}`)
    }
    options.onResolved?.({ anchorLine: edit.anchor.line, start: span.start, end: span.end, op })
    if (op === "insert_after") {
      for (const payload of edit.payloads) {
        const cursor: Cursor = { kind: "after_anchor", anchor: { line: span.end } }
        resolved.push({
          kind: "insert",
          cursor,
          text: payload,
          lineNum: edit.lineNum,
          index: synthIndex++,
          blockStart: span.start,
        })
      }
      continue
    }
    for (const payload of edit.payloads) {
      const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } }
      resolved.push({
        kind: "insert",
        cursor,
        text: payload,
        lineNum: edit.lineNum,
        index: synthIndex++,
        mode: "replacement",
      })
    }
    for (let line = span.start; line <= span.end; line++) {
      resolved.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: synthIndex++ })
    }
  }
  return resolved
}
