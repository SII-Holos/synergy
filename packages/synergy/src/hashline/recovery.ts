/**
 * Recover from a stale section snapshot tag by replaying the would-be edit
 * against a cached pre-edit snapshot of the file and 3-way-merging the
 * result onto the current on-disk content.
 */
import * as Diff from "diff"
import { applyEdits } from "./apply"
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_CHAIN_WARNING, RECOVERY_SESSION_REPLAY_WARNING } from "./messages"
import type { Snapshot, SnapshotStore } from "./snapshots"
import type { Anchor, ApplyResult, Cursor, Edit } from "./types"

const RECOVERY_FUZZ_FACTOR = 0
const MAX_CONTEXT_RADIUS = 5

export interface RecoveryArgs {
  path: string
  currentText: string
  fileHash: string
  edits: readonly Edit[]
}

export interface RecoveryResult {
  text: string
  firstChangedLine: number | undefined
  warnings: string[]
}

function applyEditsToSnapshot(
  previousText: string,
  currentText: string,
  edits: readonly Edit[],
  recoveryWarning: string,
): RecoveryResult | null {
  let applied: ApplyResult
  try {
    applied = applyEdits(previousText, [...edits])
  } catch {
    return null
  }
  if (applied.text === previousText) return null
  const patch = Diff.structuredPatch("file", "file", previousText, applied.text, "", "", { context: 3 })
  const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: RECOVERY_FUZZ_FACTOR })
  if (typeof merged !== "string" || merged === currentText) return null
  const firstChangedLine = findFirstChangedLine(currentText, merged) ?? applied.firstChangedLine
  const hasNetChange = firstChangedLine !== undefined
  const warnings = hasNetChange ? [recoveryWarning, ...(applied.warnings ?? [])] : [...(applied.warnings ?? [])]
  return { text: merged, firstChangedLine, warnings }
}

function collectAnchorLines(edits: readonly Edit[]): number[] {
  const lines: number[] = []
  for (const edit of edits) {
    for (const anchor of getEditAnchors(edit)) lines.push(anchor.line)
  }
  return lines
}

function getEditAnchors(edit: Edit): Anchor[] {
  if (edit.kind === "delete") return [edit.anchor]
  if (edit.kind === "block") return [edit.anchor]
  return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor" ? [edit.cursor.anchor] : []
}

function verifyAnchorContent(previousText: string, currentText: string, edits: readonly Edit[]): boolean {
  const lines = collectAnchorLines(edits)
  if (lines.length === 0) return true
  const prev = previousText.split("\n")
  const curr = currentText.split("\n")
  for (const line of lines) {
    const idx = line - 1
    if (idx < 0 || idx >= prev.length || idx >= curr.length) return false
    if (prev[idx] !== curr[idx]) return false
  }
  return true
}

function replaySessionChainOnCurrent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[],
): RecoveryResult | null {
  if (previousText.split("\n").length !== currentText.split("\n").length) return null
  if (!verifyAnchorContent(previousText, currentText, edits)) return null
  let applied: ApplyResult
  try {
    applied = applyEdits(currentText, [...edits])
  } catch {
    return null
  }
  if (applied.text === currentText) return null
  return {
    text: applied.text,
    firstChangedLine: applied.firstChangedLine,
    warnings: [RECOVERY_SESSION_REPLAY_WARNING, ...(applied.warnings ?? [])],
  }
}

// ── Content-based anchor relocation ──

function linesMatchAt(allLines: string[], startIndex: number, needle: string[]): boolean {
  if (startIndex < 0 || startIndex + needle.length > allLines.length) return false
  return needle.every((line, i) => allLines[startIndex + i] === line)
}

function contextMatches(
  snapshotLines: string[],
  liveLines: string[],
  candidateStart: number,
  origStart: number,
  origEnd: number,
  radius: number,
): boolean {
  const targetLen = origEnd - origStart + 1
  for (let d = 1; d <= radius; d++) {
    const before = snapshotLines[origStart - 1 - d]
    if (before !== undefined && liveLines[candidateStart - d] !== before) return false
    const after = snapshotLines[origEnd - 1 + d]
    if (after !== undefined && liveLines[candidateStart + targetLen - 1 + d] !== after) return false
  }
  return true
}

function locateContentRange(
  snapshotLines: string[],
  liveLines: string[],
  startLine: number,
  endLine: number,
): number | null {
  const needle = snapshotLines.slice(startLine - 1, endLine)
  if (needle.length === 0) return null
  const matches: number[] = []
  for (let i = 0; i <= liveLines.length - needle.length; i++) {
    if (linesMatchAt(liveLines, i, needle)) matches.push(i)
  }
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0] + 1
  for (let radius = 1; radius <= MAX_CONTEXT_RADIUS; radius++) {
    const contextual = matches.filter((idx) =>
      contextMatches(snapshotLines, liveLines, idx, startLine, endLine, radius),
    )
    if (contextual.length === 1) return contextual[0] + 1
  }
  return null
}

function relocateEdits(snapshotText: string, currentText: string, edits: readonly Edit[]): Edit[] | null {
  const snapshotLines = snapshotText.split("\n")
  if (snapshotLines.at(-1) === "") snapshotLines.pop()
  const liveLines = currentText.split("\n")
  if (liveLines.at(-1) === "") liveLines.pop()

  const relocated: Edit[] = []
  for (const edit of edits) {
    if (edit.kind === "insert" && (edit.cursor.kind === "bof" || edit.cursor.kind === "eof")) {
      relocated.push(edit)
      continue
    }
    if (edit.kind === "block") {
      const newStart = locateContentRange(snapshotLines, liveLines, edit.anchor.line, edit.anchor.line)
      if (newStart === null) return null
      relocated.push({ ...edit, anchor: { line: newStart } })
      continue
    }
    if (edit.kind === "delete") {
      const origStart = edit.anchor.line
      // For replacement groups, the delete anchor was already set
      const newStart = locateContentRange(snapshotLines, liveLines, origStart, origStart)
      if (newStart === null) return null
      relocated.push({ ...edit, anchor: { line: newStart } })
      continue
    }
    // insert with before_anchor or after_anchor (or replacement inserts)
    if (edit.kind !== "insert") {
      relocated.push(edit)
      continue
    }
    const anchorLine =
      edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor" ? edit.cursor.anchor.line : null
    if (anchorLine === null) {
      relocated.push(edit)
      continue
    }
    const newAnchor = locateContentRange(snapshotLines, liveLines, anchorLine, anchorLine)
    if (newAnchor === null) return null
    const newCursor: Cursor =
      edit.cursor.kind === "before_anchor"
        ? { kind: "before_anchor", anchor: { line: newAnchor } }
        : { kind: "after_anchor", anchor: { line: newAnchor } }
    relocated.push({ ...edit, cursor: newCursor })
  }
  return relocated
}

function findFirstChangedLine(a: string, b: string): number | undefined {
  if (a === b) return undefined
  const aLines = a.split("\n")
  const bLines = b.split("\n")
  const max = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) return i + 1
  }
  return undefined
}

function isHeadSnapshot(head: Snapshot | null, snapshot: Snapshot): boolean {
  return head === snapshot
}

export class Recovery {
  constructor(readonly store: SnapshotStore) {}

  tryRecover(args: RecoveryArgs): RecoveryResult | null {
    const { path, currentText, fileHash, edits } = args
    const snapshot = this.store.byHash(path, fileHash)
    if (!snapshot) return null
    const isHead = isHeadSnapshot(this.store.head(path), snapshot)
    const recoveryWarning = isHead ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING

    // Guard: refuse if any anchor content is ambiguous in the live file
    if (hasAmbiguousAnchor(snapshot.text, currentText, edits)) return null

    // Strategy 1: diff-based 3-way merge (handles most cases)
    const merged = applyEditsToSnapshot(snapshot.text, currentText, edits, recoveryWarning)
    if (merged !== null) return merged

    // Strategy 2: session-chain replay (non-head, same line count, anchor content unchanged)
    if (!isHead) {
      const replayed = replaySessionChainOnCurrent(snapshot.text, currentText, edits)
      if (replayed !== null) return replayed
    }

    // Strategy 3: content-based anchor relocation (handles external insertions shifting anchors)
    const relocated = relocateEdits(snapshot.text, currentText, edits)
    if (relocated !== null) {
      let applied: ApplyResult
      try {
        applied = applyEdits(currentText, [...relocated])
      } catch {
        return null
      }
      if (applied.text !== currentText) {
        return {
          text: applied.text,
          firstChangedLine: applied.firstChangedLine,
          warnings: [recoveryWarning, ...(applied.warnings ?? [])],
        }
      }
    }

    return null
  }
}

function hasAmbiguousAnchor(snapshotText: string, currentText: string, edits: readonly Edit[]): boolean {
  const snapshotLines = snapshotText.split("\n")
  if (snapshotLines.at(-1) === "") snapshotLines.pop()
  const liveLines = currentText.split("\n")
  if (liveLines.at(-1) === "") liveLines.pop()

  for (const edit of edits) {
    const anchorLine = getEditAnchorLine(edit)
    if (anchorLine === null) continue
    const result = locateContentRange(snapshotLines, liveLines, anchorLine, anchorLine)
    // null means either not found (fail) or ambiguous (refuse)
    if (result === null) {
      // Check if it's ambiguous (found multiple times) vs not found at all
      const needle = snapshotLines.slice(anchorLine - 1, anchorLine)
      if (needle.length === 0) continue
      const simpleMatches: number[] = []
      for (let i = 0; i <= liveLines.length - needle.length; i++) {
        if (linesMatchAt(liveLines, i, needle)) simpleMatches.push(i)
      }
      if (simpleMatches.length === 0) return false // not found at all, let other strategies handle
      return true // found multiple times, cannot safely disambiguate
    }
  }
  return false
}

function getEditAnchorLine(edit: Edit): number | null {
  if (edit.kind === "delete") return edit.anchor.line
  if (edit.kind === "block") return edit.anchor.line
  if (edit.kind === "insert" && (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor"))
    return edit.cursor.anchor.line
  return null
}
