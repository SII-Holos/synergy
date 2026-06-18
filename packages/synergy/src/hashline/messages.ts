/** Centralized error/warning text for the hashline parser, applier, and patcher. */
import { formatNumberedLine, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_RANGE_SEP } from "./format"

/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2

/** Format numbered context rows around anchor lines. */
export function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
  const displayLines = new Set<number>()
  for (const line of anchorLines) {
    if (line < 1 || line > fileLines.length) continue
    const lo = Math.max(1, line - MISMATCH_CONTEXT)
    const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT)
    for (let ln = lo; ln <= hi; ln++) displayLines.add(ln)
  }
  const anchorSet = new Set(anchorLines)
  const rows: string[] = []
  let previous = -1
  for (const lineNum of [...displayLines].sort((a, b) => a - b)) {
    if (previous !== -1 && lineNum > previous + 1) rows.push("...")
    previous = lineNum
    const marker = anchorSet.has(lineNum) ? "*" : " "
    rows.push(`${marker}${formatNumberedLine(lineNum, fileLines[lineNum - 1] ?? "")}`)
  }
  return rows
}

export const BEGIN_PATCH_MARKER = "*** Begin Patch"
export const END_PATCH_MARKER = "*** End Patch"
export const ABORT_MARKER = "*** Abort"

export const REPLACE_PAIR_COALESCED_WARNING = `Two hunks targeted the same range; kept only the second. One \`SWAP N${HL_RANGE_SEP}M:\` hunk per range — the body is the final content, never old+new.`
export const BARE_BODY_AUTO_PIPED_WARNING =
  "Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines."
export const MINUS_ROW_REJECTED =
  "`-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`."
export const EMPTY_REPLACE = `\`SWAP N${HL_RANGE_SEP}M:\` needs at least one \`+TEXT\` body row. To delete lines, use \`DEL N${HL_RANGE_SEP}M\`.`
export const EMPTY_BLOCK = "`SWAP.BLK N:` needs at least one `+TEXT` body row. To delete a block, use `DEL.BLK N`."

export function blockUnresolvedMessage(
  line: number,
  op: "replace" | "delete" = "replace",
  fileLines?: readonly string[],
): string {
  const phrase = op === "delete" ? `DEL.BLK ${line}` : `SWAP.BLK ${line}:`
  const fallback = op === "delete" ? `DEL ${line}${HL_RANGE_SEP}M` : `SWAP ${line}${HL_RANGE_SEP}M:`
  let message = `\`${phrase}\` could not resolve a syntactic block beginning on line ${line} (unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`
  if (fileLines) {
    const context = formatAnchoredContext([line], fileLines)
    if (context.length > 0) message += `\n\n${context.join("\n")}`
  }
  return message
}

export const BLOCK_RESOLVER_UNAVAILABLE =
  "`SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` are not available here (no block resolver configured). Use a concrete line range."

export function insertAfterBlockCloserLoweredWarning(line: number): string {
  return `\`INS.BLK.POST ${line}:\` anchors on a closing delimiter, so it was applied as plain \`INS.POST ${line}:\`. Anchor on the line that OPENS the construct.`
}

export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
  return `\`INS.BLK.POST ${line}:\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`INS.POST ${line}:\`. Verify the landing line; anchor on a line that OPENS a construct.`
}

export const UNRESOLVED_BLOCK_INTERNAL =
  "internal error: unresolved `SWAP.BLK` edit reached the applier (resolveBlockEdits was not run)."
export const DELETE_TAKES_NO_BODY = `\`DEL N${HL_RANGE_SEP}M\` does not take body rows. Remove the body, or use \`SWAP N${HL_RANGE_SEP}M:\`.`
export const DELETE_BLOCK_TAKES_NO_BODY = "`DEL.BLK N` does not take body rows. Remove the body, or use `SWAP.BLK N:`."
export const EMPTY_INSERT = "`INS` needs at least one `+TEXT` body row."

export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
  return `INS.POST ${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${crossed === 1 ? "" : "s"} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`
}

export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
  return `INS.BLK.POST ${blockStart}: body indented deeper than closing line ${closerLine}, so it was placed inside the block, after line ${landingLine}. \`INS.BLK.POST\` lands AFTER the block at sibling depth — if inside was intended, use plain \`INS.POST ${closerLine}:\`.`
}

export const RECOVERY_EXTERNAL_WARNING =
  "Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit)."
export const RECOVERY_SESSION_CHAIN_WARNING =
  "Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash)."
export const RECOVERY_SESSION_REPLAY_WARNING =
  "Recovered by replaying your edits onto the current file content (a prior in-session edit changed the lines you re-targeted with a stale hash). Verify the diff matches your intent."
export const HEADTAIL_DRIFT_WARNING =
  "Applied the `INS.HEAD:`/`INS.TAIL:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected."

export function missingSnapshotTagMessage(sectionPath: string): string {
  return `Missing hashline snapshot tag for ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}\` from your latest read/search output. To create a new file, use the write tool.`
}

function formatLineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  if (sorted.length === 0) return ""
  const parts: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i]
    if (current === prev + 1) {
      prev = current
      continue
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = current
    prev = current
  }
  return parts.join(", ")
}

export function unseenLinesMessage(sectionPath: string, unseenLines: readonly number[], tag: string): string {
  const ranges = formatLineRanges(unseenLines)
  const selector = ranges.replace(/, /g, ",")
  return (
    `This edit anchors to lines ${ranges} of ${sectionPath} that ` +
    `${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} never displayed (it showed a ` +
    `partial range, a search hit, or a folded summary). Re-read them in full first with a ranged read like ` +
    `\`${sectionPath}:${selector}\` — it skips summarization and mints a fresh tag (a plain re-read just re-folds ` +
    `them) — then re-issue the edit.`
  )
}

export type BlockOp = "replace" | "delete" | "insert_after"

export function blockSingleLineMessage(line: number, op: BlockOp): string {
  const blockForm = op === "insert_after" ? "INS.BLK.POST" : op === "delete" ? "DEL.BLK" : "SWAP.BLK"
  const plainForm =
    op === "insert_after"
      ? `INS.POST ${line}:`
      : op === "delete"
        ? `DEL ${line}`
        : `SWAP ${line}${HL_RANGE_SEP}${line}:`
  return (
    `\`${blockForm} ${line}\` resolved a single-line block — line ${line} is a bare statement, not the opening line ` +
    `of a multi-line construct. For that one line use \`${plainForm}\`; to act on an enclosing construct, anchor ${blockForm} ` +
    `on the line that OPENS it (e.g. its \`function\`/\`if\`/\`case\` header), never a statement inside it.`
  )
}
