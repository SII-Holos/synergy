import z from "zod"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./revise-file.txt"
import { Tool } from "./tool"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileTime } from "../file/time"
import { detectConflicts } from "../conflict/detect"
import { RuntimeReload } from "../runtime/reload"
import { computeFileHash, formatHashlineBlock, formatHashlineHeader } from "../hashline/format"
import { Patch, PatchSection } from "../hashline/input"
import { normalizeToLF } from "../hashline/normalize"
import { Patcher, type PreparedSection, type PatchSectionResult } from "../hashline/patcher"
import { BunFilesystem, type WriteResult } from "../hashline/fs"
import { SessionHashlineStore } from "../hashline/store"
import { diffStats, displayPath, resolveFilePath } from "./anchored-file"
import { collectWriteDiagnostics } from "./write-quality"

/**
 * Synergy-aware Filesystem that resolves paths using Instance.directory
 * (consistent with anchored-file.ts resolveFilePath) so that snapshot
 * keys and file operations all agree on canonical paths.
 */
class SynergyFilesystem extends BunFilesystem {
  override canonicalPath(p: string): string {
    return resolveFilePath(p)
  }
  override async readText(p: string): Promise<string> {
    return super.readText(resolveFilePath(p))
  }
  override async writeText(p: string, content: string): Promise<WriteResult> {
    return super.writeText(resolveFilePath(p), content)
  }
  override async exists(p: string): Promise<boolean> {
    return super.exists(resolveFilePath(p))
  }
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
  const seen = new Map<string, string>()
  for (const entry of prepared) {
    const prev = seen.get(entry.canonicalPath)
    if (prev !== undefined)
      throw new Error(
        `Multiple hashline sections resolve to the same file (${prev} and ${entry.section.path}). Merge their ops under one header before applying.`,
      )
    seen.set(entry.canonicalPath, entry.section.path)
  }
}

function summarizeOperations(section: PatchSection): string[] {
  const { edits } = section.parse()
  return edits.map((edit) => {
    if (edit.kind === "delete") return `delete ${edit.anchor.line}`
    if (edit.kind === "block")
      return edit.mode === "insert_after" ? `insert_after_block ${edit.anchor.line}` : `blockSwap ${edit.anchor.line}`
    if (edit.cursor.kind === "bof") return `insert head`
    if (edit.cursor.kind === "eof") return `insert tail`
    if (edit.cursor.kind === "before_anchor") return `insert before ${edit.cursor.anchor.line}`
    if (edit.cursor.kind === "after_anchor") return `insert after ${edit.cursor.anchor.line}`
    return `unknown`
  })
}

function buildSectionDiff(before: string, after: string): string {
  return trimDiff(createTwoFilesPatch("file", "file", before, after))
}

const noRuntimeReload = undefined as Awaited<ReturnType<typeof RuntimeReload.reload>> | undefined

export const ReviseFileTool = Tool.define("revise_file", {
  description: DESCRIPTION,
  parameters: z.object({
    input: z
      .string()
      .describe(
        "Patch text beginning with a real [path#TAG] header returned by an anchored tool; body rows must be final +TEXT lines",
      ),
  }),
  async execute(params, ctx) {
    // ── 1. Parse input ──
    let patch: Patch
    try {
      patch = Patch.parse(params.input)
    } catch (parseErr) {
      throw parseErr
    }

    const sections = patch.sections
    if (sections.length === 0) {
      throw new Error("Patch input must contain at least one [path#TAG] section")
    }

    // ── 2. Set up Patcher with Synergy-adapted filesystem ──
    const fs = new SynergyFilesystem()
    const snapshots = SessionHashlineStore.get(ctx.sessionID)
    const patcher = new Patcher({ fs, snapshots })

    // ── 3. Pre-check each file for conflicts, existence, and stale tags ──
    for (const section of sections) {
      const resolvedPath = resolveFilePath(section.path)
      const stored = snapshots.byHash(resolvedPath, section.fileHash ?? "")
      if (!stored) {
        throw new Error(
          `Unknown or out-of-date [path#TAG] header for ${section.path}. STOP: do not stack additional edits. Use view_file, scan_files, parse_code, or save_file to get a current header, then retry with that header.`,
        )
      }

      const file = Bun.file(resolvedPath)
      const stats = await file.stat().catch(() => undefined)
      if (!stats) throw new Error(`File not found: ${section.path}`)
      if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${section.path}`)

      const rawContent = await file.text()
      const conflict = detectConflicts(rawContent)
      if (conflict.hasConflicts) {
        const ranges = conflict.conflicts.map((item) => `${item.startLine}-${item.endLine}`).join(", ")
        throw new Error(
          `Refusing revise_file on ${section.path} because it contains unresolved merge conflict markers at lines ${ranges}. Resolve the conflict first, or use save_file only for an intentional full-file resolution.`,
        )
      }
    }

    // ── 4. Prepare all sections (validates tags, applies recovery, checks seen lines) ──
    const prepared: PreparedSection[] = []
    for (const section of sections) {
      prepared.push(await patcher.prepare(section))
    }
    assertUniqueCanonicalPaths(prepared)

    // ── 5. Check for no-ops and collect warnings ──
    const allWarnings: string[] = []
    for (const entry of prepared) {
      for (const w of entry.parseWarnings) allWarnings.push(`[${displayPath(entry.canonicalPath)}] ${w}`)
      for (const w of entry.applyResult.warnings ?? []) allWarnings.push(`[${displayPath(entry.canonicalPath)}] ${w}`)
    }

    const allNoop = prepared.every((p) => p.isNoop)
    if (allNoop && prepared.length === 1) {
      const p = prepared[0]
      const displayTitle = displayPath(p.canonicalPath)
      const block = formatHashlineBlock(displayTitle, snapshots.head(p.canonicalPath)?.hash ?? "????", p.normalized)
      const diagnostics = await collectWriteDiagnostics(p.canonicalPath)
      return {
        title: displayTitle,
        output: `${block}\nNo-op: patch parsed cleanly but produced no change. The targeted body rows already match the current file. Do not widen ranges; verify the header and line numbers before retrying.${diagnostics.output}`,
        metadata: {
          filepath: p.canonicalPath,
          path: displayTitle,
          tag: snapshots.head(p.canonicalPath)?.hash ?? "????",
          applied: false,
          sections: [],
          operations: 0,
          diff: "",
          filediff: {
            file: displayTitle,
            path: displayTitle,
            before: p.normalized,
            after: p.normalized,
            additions: 0,
            deletions: 0,
          },
          operationSummary: summarizeOperations(p.section),
          changeSummary: { additions: 0, deletions: 0 },
          recovered: false,
          recoveryMode: undefined,
          diagnostics: diagnostics.diagnostics,
          runtimeReload: noRuntimeReload,
          builtinSourceWarning: undefined as string | undefined,
          warnings: allWarnings,
        },
      }
    }
    if (allNoop) throw new Error("All sections produced no changes. Verify headers and line numbers before retrying.")

    // ── 6. Build diff for permission ask ──
    const combinedBefore = prepared.map((p) => `=== ${displayPath(p.canonicalPath)} ===\n${p.normalized}`).join("\n")
    const combinedAfter = prepared
      .map((p) => `=== ${displayPath(p.canonicalPath)} ===\n${p.applyResult.text}`)
      .join("\n")
    const diff = buildSectionDiff(combinedBefore, combinedAfter)
    const changeSummary = diffStats(diff)
    const allPaths = prepared.map((p) => displayPath(p.canonicalPath))
    const allOpsSummaries = prepared.flatMap((p) => summarizeOperations(p.section))

    await ctx.ask({
      permission: "revise_file",
      patterns: allPaths,
      metadata: {
        sections: allPaths,
        diff,
        filediff: {
          file: allPaths.join(", "),
          path: allPaths.join(", "),
          before: combinedBefore,
          after: combinedAfter,
          ...changeSummary,
        },
        operationSummary: allOpsSummaries,
        changeSummary,
      },
    })

    // ── 7. Commit each section (with file locking, Bus events) ──
    const committedResults: PatchSectionResult[] = []
    let firstError: Error | undefined

    for (const p of prepared) {
      if (p.isNoop) {
        const head = snapshots.head(p.canonicalPath)?.hash ?? "????"
        committedResults.push({
          path: displayPath(p.canonicalPath),
          canonicalPath: p.canonicalPath,
          op: "noop",
          before: p.normalized,
          after: p.normalized,
          persisted: p.rawContent,
          written: p.rawContent,
          fileHash: head,
          header: formatHashlineHeader(displayPath(p.canonicalPath), head),
          warnings: [...p.parseWarnings, ...(p.applyResult.warnings ?? [])],
        })
        continue
      }

      try {
        let result: PatchSectionResult | undefined
        await FileTime.withLock(
          p.canonicalPath,
          async () => {
            result = await patcher.commit(p)

            // Fire format-on-write before recording final hash
            await Bus.publish(File.Event.Edited, { file: p.canonicalPath })

            // Re-read to pick up format-on-write changes (the formatter may have
            // rewritten the file asynchronously). Re-record the snapshot with
            // the final formatted content so returned tags and diffs are accurate.
            const formattedContent = await fs.readText(p.section.path)
            const formattedNormalized = normalizeToLF(formattedContent)
            const formattedHash = snapshots.record(p.canonicalPath, formattedNormalized)
            result = {
              ...result,
              after: formattedNormalized,
              written: formattedContent,
              fileHash: formattedHash,
              header: formatHashlineHeader(result.path, formattedHash),
            }

            FileTime.read(ctx.sessionID, p.canonicalPath)
          },
          { signal: ctx.abort },
        )
        if (result) committedResults.push(result)
      } catch (error) {
        firstError = error instanceof Error ? error : new Error(String(error))
        break
      }
    }

    if (firstError) {
      const written = committedResults.filter((r) => r.op !== "noop").map((r) => r.path)
      const notWritten = prepared.slice(committedResults.length).map((p) => displayPath(p.canonicalPath))
      throw new Error(
        `Failed to write section: ${firstError.message}` +
          (written.length > 0 ? ` Sections already written: ${written.join(", ")}.` : "") +
          (notWritten.length > 0 ? ` Sections not written: ${notWritten.join(", ")}.` : ""),
        { cause: firstError },
      )
    }

    // ── 8. Format output ──
    const primary = committedResults[0]
    const outputBlocks: string[] = []

    if (allWarnings.length > 0) {
      outputBlocks.push(`Warnings:\n${allWarnings.map((w) => `  ${w}`).join("\n")}`)
    }
    for (const r of committedResults) {
      outputBlocks.push(formatHashlineBlock(r.path, r.fileHash, r.after))
    }

    const primaryCanonical = committedResults.find((r) => r.op !== "noop")?.canonicalPath ?? primary.canonicalPath
    const diagnostics = await collectWriteDiagnostics(primaryCanonical)
    if (diagnostics.output) outputBlocks.push(diagnostics.output.trim())

    const reloadTargets = RuntimeReload.detectTargetsForFile(primaryCanonical)
    const reloadScope = RuntimeReload.detectScopeForFile(primaryCanonical) ?? "auto"
    const runtimeReload = reloadTargets.length
      ? await RuntimeReload.reload({
          targets: reloadTargets,
          scope: reloadScope,
          reason: `revise_file:${displayPath(primaryCanonical)}`,
        })
      : undefined
    const builtinSourceWarning = RuntimeReload.builtinSourceEditWarning(primaryCanonical)
    if (runtimeReload) outputBlocks.push(`Runtime reload applied: ${runtimeReload.executed.join(",")}`)
    if (builtinSourceWarning) outputBlocks.push(builtinSourceWarning)

    const output = outputBlocks.join("\n")

    const filediffBefore =
      committedResults.length === 1
        ? committedResults[0].before
        : committedResults
            .map(
              (r) => `=== ${r.path} ===
${r.before}`,
            )
            .join("\n")
    const filediffAfter =
      committedResults.length === 1
        ? committedResults[0].after
        : committedResults
            .map(
              (r) => `=== ${r.path} ===
${r.after}`,
            )
            .join("\n")
    const finalDiff = buildSectionDiff(filediffBefore, filediffAfter)
    const finalChangeSummary = diffStats(finalDiff)

    const appliedCount = committedResults.filter((r) => r.op !== "noop").length
    const totalOps = prepared.reduce((sum, p) => sum + p.section.edits.length, 0)
    const recovered = committedResults.some((r) => r.warnings.some((w) => /recover/i.test(w)))

    return {
      title: committedResults.length === 1 ? committedResults[0].path : `${committedResults.length} files`,
      output,
      metadata: {
        filepath: primaryCanonical,
        path: committedResults.length === 1 ? committedResults[0].path : committedResults.map((r) => r.path).join(", "),
        tag: primary.fileHash,
        applied: appliedCount > 0,
        sections: committedResults.map((r, i) => ({
          path: r.path,
          tag: r.fileHash,
          applied: r.op !== "noop",
          operationSummary: r.op === "noop" ? [] : summarizeOperations(prepared[i].section),
          recovered,
          recoveryMode: recovered ? ("three-way-merge" as const) : undefined,
        })),
        operations: totalOps,
        diff: finalDiff,
        filediff: {
          file: committedResults.map((r) => r.path).join(", "),
          path: committedResults.map((r) => r.path).join(", "),
          before: filediffBefore,
          after: filediffAfter,
          ...finalChangeSummary,
        },
        operationSummary: allOpsSummaries,
        changeSummary: finalChangeSummary,
        diagnostics: diagnostics.diagnostics,
        recovered,
        recoveryMode: recovered ? ("three-way-merge" as const) : undefined,
        runtimeReload,
        builtinSourceWarning,
        warnings: allWarnings,
      },
    }
  },
})
