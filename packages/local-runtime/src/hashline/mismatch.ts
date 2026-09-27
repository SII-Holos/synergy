/**
 * Error type raised when a section's snapshot tag does not match the live file
 * content and recovery is unavailable / has failed.
 */
import { HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./format"
import { formatAnchoredContext } from "./messages"

const LINE_REF_RE = /^\s*[>+\-*]*\s*(\d+)(?::.*)?\s*$/

/** Format the required-shape diagnostic shown when a line reference is malformed. */
export function formatFullAnchorRequirement(raw?: string): string {
  const received = raw === undefined ? "" : ` Received ${JSON.stringify(raw)}.`
  return (
    `a bare line number from read/search output plus the section header content-hash tag ` +
    `(for example ${HL_FILE_PREFIX}src/foo.ts${HL_FILE_HASH_SEP}${HL_FILE_HASH_EXAMPLES[0]}${HL_FILE_SUFFIX} and line "160")${received}`
  )
}

/** Parse a decorated bare line-number anchor like `42`, `*42:foo`, ` > 7`. */
export function parseTag(ref: string): { line: number } {
  const match = ref.match(LINE_REF_RE)
  if (!match) {
    throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`)
  }
  const line = Number.parseInt(match[1], 10)
  if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`)
  return { line }
}

export interface MismatchDetails {
  path?: string
  expectedFileHash: string
  actualFileHash: string
  fileLines: string[]
  anchorLines?: readonly number[]
  hashRecognized?: boolean
}

/**
 * Raised when a hashline section's snapshot tag doesn't match the live file's content.
 */
export class MismatchError extends Error {
  readonly path: string | undefined
  readonly expectedFileHash: string
  readonly actualFileHash: string
  readonly fileLines: string[]
  readonly anchorLines: readonly number[]
  readonly hashRecognized: boolean

  constructor(details: MismatchDetails) {
    super(MismatchError.formatMessage(details))
    this.name = "MismatchError"
    this.path = details.path
    this.expectedFileHash = details.expectedFileHash
    this.actualFileHash = details.actualFileHash
    this.fileLines = details.fileLines
    this.anchorLines = details.anchorLines ?? []
    this.hashRecognized = details.hashRecognized ?? true
  }

  get displayMessage(): string {
    return MismatchError.formatDisplayMessage({
      path: this.path,
      expectedFileHash: this.expectedFileHash,
      actualFileHash: this.actualFileHash,
      fileLines: this.fileLines,
      anchorLines: this.anchorLines,
      hashRecognized: this.hashRecognized,
    })
  }

  static rejectionHeader(details: MismatchDetails): string[] {
    const pathText = details.path ? ` for ${details.path}` : ""
    const hashRecognized = details.hashRecognized ?? true
    if (!hashRecognized) {
      return [
        `Edit rejected${pathText}: hash ${HL_FILE_HASH_SEP}${details.expectedFileHash} is not from this session.`,
        `The current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}. Do not retry the same patch. Do not adjust line numbers from memory. Re-read the file with \`view_file\` to copy a current ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX} header — never invent the tag and never reuse one from a prior session.`,
      ]
    }
    return [
      `Edit rejected${pathText}: file changed between read and edit.`,
      `Section is bound to ${HL_FILE_HASH_SEP}${details.expectedFileHash}, but the current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}. Do not retry the same patch. Do not adjust line numbers from memory. If a prior edit in this session modified this file, copy the ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}newhash${HL_FILE_SUFFIX} header from that edit's response; otherwise re-read the file with \`view_file\` to refresh the tag before retrying.`,
    ]
  }

  static formatDisplayMessage(details: MismatchDetails): string {
    return MismatchError.formatMessage(details)
  }

  static formatMessage(details: MismatchDetails): string {
    const lines = MismatchError.rejectionHeader(details)
    const context = formatAnchoredContext(details.anchorLines ?? [], details.fileLines)
    if (context.length > 0) {
      lines.push("", ...context)
    }
    lines.push(
      "",
      "After re-reading, produce a completely new patch from the fresh tag. Do not reuse any part of the old patch.",
    )
    return lines.join("\n")
  }
}

/** Throws when the line reference is out of bounds for the given file. */
export function validateLineRef(ref: { line: number }, fileLines: string[]): void {
  if (ref.line < 1 || ref.line > fileLines.length) {
    throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`)
  }
}
