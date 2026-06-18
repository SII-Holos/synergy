/**
 * High-level patch orchestrator. Reads each section's target file via the
 * configured Filesystem, strips BOM and normalizes line endings, validates
 * the section snapshot tag (with Recovery), applies the result back through
 * the same Filesystem.
 */
import { applyEdits } from "./apply"
import { hasBlockEdit, resolveBlockEdits } from "./block"
import { computeFileHash, formatHashlineHeader } from "./format"
import type { Filesystem, WriteResult } from "./fs"
import { isNotFound } from "./fs"
import type { Patch, PatchSection } from "./input"
import { HEADTAIL_DRIFT_WARNING, missingSnapshotTagMessage, unseenLinesMessage } from "./messages"
import { MismatchError } from "./mismatch"
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize"
import { Recovery, type RecoveryResult } from "./recovery"
import type { SnapshotStore } from "./snapshots"
import type { ApplyResult, BlockResolution, BlockResolver, Edit } from "./types"

export interface PatcherOptions {
  fs: Filesystem
  snapshots: SnapshotStore
  blockResolver?: BlockResolver
}

export interface PatchSectionResult {
  path: string
  canonicalPath: string
  op: "create" | "update" | "noop"
  before: string
  after: string
  persisted: string
  written: string
  fileHash: string
  header: string
  firstChangedLine?: number
  warnings: string[]
  blockResolutions?: BlockResolution[]
}

export interface PatcherApplyResult {
  sections: PatchSectionResult[]
}

export class PreparedSection {
  constructor(
    readonly section: PatchSection,
    readonly canonicalPath: string,
    readonly exists: boolean,
    readonly rawContent: string,
    readonly bom: string,
    readonly lineEnding: LineEnding,
    readonly normalized: string,
    readonly applyResult: ApplyResult,
    readonly parseWarnings: readonly string[],
  ) {}

  get isNoop(): boolean {
    return this.applyResult.text === this.normalized
  }
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
  return edits.some((edit) => {
    if (edit.kind === "delete") return true
    if (edit.kind === "block") return true
    return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor"
  })
}

function assertSectionHashPresent(sectionPath: string, fileHash: string | undefined): void {
  if (fileHash !== undefined) return
  throw new Error(missingSnapshotTagMessage(sectionPath))
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
  return { text: result.text, firstChangedLine: result.firstChangedLine, warnings: result.warnings }
}

function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
  const out: string[] = []
  for (const source of sources) {
    if (!source) continue
    for (const warning of source) out.push(warning)
  }
  return out
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
  const seen = new Map<string, string>()
  for (const entry of prepared) {
    const previous = seen.get(entry.canonicalPath)
    if (previous !== undefined)
      throw new Error(
        `Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
      )
    seen.set(entry.canonicalPath, entry.section.path)
  }
}

export class Patcher {
  readonly fs: Filesystem
  readonly snapshots: SnapshotStore
  readonly recovery: Recovery
  readonly blockResolver: BlockResolver | undefined

  constructor(options: PatcherOptions) {
    if (!options.snapshots)
      throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.")
    this.fs = options.fs
    this.snapshots = options.snapshots
    this.recovery = new Recovery(options.snapshots)
    this.blockResolver = options.blockResolver
  }

  async apply(patch: Patch): Promise<PatcherApplyResult> {
    if (patch.sections.length === 1) {
      const prepared = await this.prepare(patch.sections[0])
      return { sections: [await this.commit(prepared)] }
    }
    const prepared: PreparedSection[] = []
    for (const section of patch.sections) prepared.push(await this.prepare(section))
    assertUniqueCanonicalPaths(prepared)
    for (const entry of prepared) {
      if (entry.isNoop) throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`)
    }
    const results: PatchSectionResult[] = []
    for (let index = 0; index < prepared.length; index++) {
      try {
        results.push(await this.commit(prepared[index]))
      } catch (error) {
        const written = prepared.slice(0, index).map((entry) => entry.section.path)
        const notWritten = prepared.slice(index + 1).map((entry) => entry.section.path)
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Failed to write ${prepared[index].section.path}: ${message}` +
            (written.length > 0 ? ` Sections already written: ${written.join(", ")}.` : "") +
            (notWritten.length > 0 ? ` Sections not written: ${notWritten.join(", ")}.` : ""),
          { cause: error },
        )
      }
    }
    return { sections: results }
  }

  async preflight(patch: Patch): Promise<void> {
    const prepared: PreparedSection[] = []
    for (const section of patch.sections) prepared.push(await this.prepare(section))
    assertUniqueCanonicalPaths(prepared)
    for (const entry of prepared) {
      if (entry.isNoop) throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`)
    }
  }

  async prepare(section: PatchSection): Promise<PreparedSection> {
    const { edits, warnings: parseWarnings } = section.parse()
    assertSectionHashPresent(section.path, section.fileHash)

    const canonicalPath = this.fs.canonicalPath(section.path)
    await this.fs.preflightWrite(section.path)
    const { exists, rawContent } = await this.#tryRead(section.path)
    if (!exists) throw new Error(`File not found: ${section.path}. Use the write tool to create new files.`)

    const { bom, text } = stripBom(rawContent)
    const lineEnding = detectLineEnding(text)
    const normalized = normalizeToLF(text)

    const applyResult = this.#applyWithRecovery({ section, canonicalPath, exists, normalized, edits })

    return new PreparedSection(
      section,
      canonicalPath,
      exists,
      rawContent,
      bom,
      lineEnding,
      normalized,
      applyResult,
      parseWarnings,
    )
  }

  async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
    const { section, normalized, bom, lineEnding, parseWarnings, exists, applyResult, canonicalPath } = prepared
    const after = applyResult.text
    const warnings = mergeWarnings(parseWarnings, applyResult.warnings)

    if (after === normalized) {
      const hash = this.#recordFullSnapshot(canonicalPath, normalized)
      return {
        path: section.path,
        canonicalPath,
        op: "noop",
        before: normalized,
        after: normalized,
        persisted: prepared.rawContent,
        written: prepared.rawContent,
        fileHash: hash,
        header: formatHashlineHeader(section.path, hash),
        warnings,
      }
    }

    const persisted = bom + restoreLineEndings(after, lineEnding)
    const write: WriteResult = await this.fs.writeText(section.path, persisted)
    const fileHash = this.#recordFullSnapshot(canonicalPath, after)
    const op = exists ? "update" : "create"

    return {
      path: section.path,
      canonicalPath,
      op,
      before: normalized,
      after,
      persisted,
      written: write.text,
      fileHash,
      header: formatHashlineHeader(section.path, fileHash),
      firstChangedLine: applyResult.firstChangedLine,
      blockResolutions: applyResult.blockResolutions,
      warnings,
    }
  }

  async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
    try {
      const content = await this.fs.readText(path)
      return { exists: true, rawContent: content }
    } catch (error) {
      if (isNotFound(error)) return { exists: false, rawContent: "" }
      throw error
    }
  }

  #recordFullSnapshot(canonicalPath: string, normalized: string): string {
    return this.snapshots.record(canonicalPath, normalized)
  }

  #assertSeenLines(section: PatchSection, canonicalPath: string, expected: string): void {
    const seen = this.snapshots.byHash(canonicalPath, expected)?.seenLines
    if (!seen || seen.size === 0) return
    const unseen = section.collectAnchorLines().filter((line) => !seen.has(line))
    if (unseen.length === 0) return
    throw new Error(unseenLinesMessage(section.path, unseen, expected))
  }

  #mismatchError(
    section: PatchSection,
    canonicalPath: string,
    normalized: string,
    expected: string,
    hashRecognized: boolean,
  ): MismatchError {
    const actualFileHash = this.#recordFullSnapshot(canonicalPath, normalized)
    return new MismatchError({
      path: section.path,
      expectedFileHash: expected,
      actualFileHash,
      fileLines: normalized.split("\n"),
      anchorLines: section.collectAnchorLines(),
      hashRecognized,
    })
  }

  #applyWithRecovery(args: {
    section: PatchSection
    canonicalPath: string
    exists: boolean
    normalized: string
    edits: readonly Edit[]
  }): ApplyResult {
    const { section, canonicalPath, exists, normalized, edits } = args
    const expected = exists ? section.fileHash : undefined
    const liveMatches = expected !== undefined && computeFileHash(normalized) === expected

    const blockResolutions: BlockResolution[] = []
    const resolveWarnings: string[] = []
    let resolved: readonly Edit[] = edits
    if (hasBlockEdit(edits)) {
      const baseText =
        expected === undefined || liveMatches ? normalized : this.snapshots.byHash(canonicalPath, expected)?.text
      if (baseText === undefined) throw this.#mismatchError(section, canonicalPath, normalized, expected ?? "", false)
      resolved = resolveBlockEdits(edits, baseText, section.path, this.blockResolver, {
        onUnresolved: "throw",
        onResolved: (resolution) => blockResolutions.push(resolution),
        onWarning: (warning) => resolveWarnings.push(warning),
      })
    }
    const withResolveWarnings = (result: ApplyResult): ApplyResult =>
      resolveWarnings.length === 0 ? result : { ...result, warnings: [...resolveWarnings, ...(result.warnings ?? [])] }

    if (expected === undefined || liveMatches) {
      if (expected !== undefined) this.#assertSeenLines(section, canonicalPath, expected)
      const result = applyEdits(normalized, resolved)
      return withResolveWarnings(blockResolutions.length > 0 ? { ...result, blockResolutions } : result)
    }
    if (!hasAnchorScopedEdit(resolved)) {
      const result = applyEdits(normalized, resolved)
      return withResolveWarnings({ ...result, warnings: [HEADTAIL_DRIFT_WARNING, ...(result.warnings ?? [])] })
    }
    const recovered = this.recovery.tryRecover({
      path: canonicalPath,
      currentText: normalized,
      fileHash: expected,
      edits: resolved,
    })
    if (recovered) return withResolveWarnings(recoveryToApplyResult(recovered))
    const hashRecognized = this.snapshots.byHash(canonicalPath, expected) !== null
    throw this.#mismatchError(section, canonicalPath, normalized, expected, hashRecognized)
  }
}
