/**
 * Pure data types shared across the hashline parser, applier, and patcher.
 * Nothing in this file references a filesystem, agent runtime, or schema
 * library — keep it that way.
 */

/** A line-number anchor (1-indexed). */
export interface Anchor {
  line: number
}

/** Where an `insert` edit should land relative to existing content. */
export type Cursor =
  | { kind: "bof" }
  | { kind: "eof" }
  | { kind: "before_anchor"; anchor: Anchor }
  | { kind: "after_anchor"; anchor: Anchor }

/**
 * A single low-level edit produced by the parser and consumed by the applier.
 * Multi-line replacements decompose to one `insert` per replacement line plus
 * one `delete` per consumed line.
 */
export type Edit =
  | {
      kind: "insert"
      cursor: Cursor
      text: string
      lineNum: number
      index: number
      mode?: "replacement"
      blockStart?: number
    }
  | { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string }
  | {
      kind: "block"
      anchor: Anchor
      payloads: string[]
      mode?: "insert_after"
      lineNum: number
      index: number
    }

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
  /** Post-edit text body. */
  text: string
  /** First line number (1-indexed) that changed, or `undefined` for a no-op apply. */
  firstChangedLine?: number
  /** Diagnostic warnings collected by the parser, patcher, or recovery. */
  warnings?: string[]
  blockResolutions?: BlockResolution[]
}

/** A parsed `[A.=B]` line range. */
export interface ParsedRange {
  start: Anchor
  end: Anchor
}

/** Optional hints for `splitPatchInput`. */
export interface SplitOptions {
  cwd?: string
  path?: string
}

/** Streaming-formatter knobs for `streamHashLines`. */
export interface StreamOptions {
  startLine?: number
  maxChunkLines?: number
  maxChunkBytes?: number
}

/** Result of `buildCompactDiffPreview`. */
export interface CompactDiffPreview {
  preview: string
  addedLines: number
  removedLines: number
}

/** Optional knobs for `buildCompactDiffPreview`. */
export interface CompactDiffOptions {
  maxAddedRunContext?: number
  maxUnchangedRun?: number
}

/** Resolved 1-indexed inclusive line span of a `replace_block N:` target. */
export interface BlockSpan {
  start: number
  end: number
}

/** One resolved block edit. */
export interface BlockResolution {
  anchorLine: number
  start: number
  end: number
  op: "replace" | "delete" | "insert_after"
}

/** Request handed to a BlockResolver. */
export interface BlockResolverRequest {
  path: string
  text: string
  line: number
}

/** Resolves a `replace_block N:` anchor to a line span. */
export type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null
