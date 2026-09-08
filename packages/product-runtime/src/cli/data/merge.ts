import {
  getLibraryInfo,
  resolveLibraryDB,
  mergeLibraryDB,
  type LibraryConflictStrategy,
} from "@ericsanchezok/synergy-library/cli/data"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import fs from "fs/promises"
import path from "path"
import os from "os"
import * as prompts from "@clack/prompts"
import { cmd } from "@ericsanchezok/synergy-cli/cli/cmd/cmd"
import { UI } from "@ericsanchezok/synergy-cli/util/ui"
import {
  archiveExclusions,
  CATEGORIES,
  scanCategories,
  formatSize,
  shortenPath,
  dirExists,
  copyDirSkipExisting,
  dataRoot,
} from "@ericsanchezok/synergy-cli/cli/cmd/data/shared"

interface SourceInfo {
  type: "directory" | "archive"
  path: string
  /** For archives: extracted temp directory. For directory: same as path. */
  dataDir: string
  manifest: PackManifest | null
  cleanup?: () => Promise<void>
}

interface PackManifest {
  version: number
  createdAt: string
  library: {
    dimensions: number | null
    embeddingModel: string | null
    memoryCount: number
    experienceCount: number
  } | null
  engram?: PackManifest["library"]
}

export const DataMergeCommand = cmd({
  command: "merge <source>",
  describe: "merge data from another synergy directory or zip archive",
  builder: (yargs) =>
    yargs.positional("source", {
      type: "string",
      describe: "source directory path, zip, or tar.gz archive",
      demandOption: true,
    }),
  handler: async (args) => {
    const sourceArg = args.source as string
    const targetRoot = dataRoot()

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Merge Synergy Data")

    // Prepare source
    const source = await prepareSource(sourceArg)
    if (!source) {
      prompts.outro("Merge aborted")
      return
    }

    try {
      const srcCatStats = await scanCategories(source.dataDir)
      const tgtCatStats = await scanCategories(targetRoot)

      let srcTotal = 0
      for (const stats of srcCatStats.values()) srcTotal += stats.size

      prompts.log.info(`Source: ${shortenPath(source.path)} (${formatSize(srcTotal)})`)
      prompts.log.info(`Target: ${shortenPath(targetRoot)} (current)`)

      // Check library compatibility from manifest or direct scan
      const srcLibrary = await resolveLibraryDB(source.dataDir)
      const tgtLibrary = path.join(targetRoot, "data", "library.db")
      let srcLibraryInfo = await getLibraryInfo(srcLibrary)
      let libraryStrategy: LibraryConflictStrategy = "text_only"

      // If we have a manifest, show it
      if (source.manifest) {
        const m = source.manifest
        prompts.log.info(`Archive created: ${m.createdAt}`)
        const manifestLibrary = m.library ?? m.engram
        if (manifestLibrary) {
          prompts.log.info(
            `Source library: ${manifestLibrary.dimensions ?? "no"} dimensions${manifestLibrary.embeddingModel ? ` (${manifestLibrary.embeddingModel})` : ""}, ${manifestLibrary.memoryCount} memories`,
          )
        }
      }

      // Step 1: Select categories
      const selectable = CATEGORIES.filter((c) => !c.required)
      const selected = await prompts.multiselect({
        message: "What should be merged? (Space to toggle, Enter to confirm)",
        options: selectable.map((cat) => ({
          value: cat.key,
          label: cat.label,
          hint: formatSize(srcCatStats.get(cat.key)?.size ?? 0),
        })),
        initialValues: selectable.filter((c) => c.defaultValue).map((c) => c.key),
        required: false,
      })
      if (prompts.isCancel(selected)) {
        prompts.cancel("Cancelled")
        return
      }

      const selectedKeys = new Set([
        ...(selected as string[]),
        ...CATEGORIES.filter((c) => c.required).map((c) => c.key),
      ])
      const selectedCategories = CATEGORIES.filter((c) => selectedKeys.has(c.key))

      // Step 2: Confirm
      const confirm = await prompts.confirm({
        message: `Merge data into ${shortenPath(targetRoot)}?`,
        initialValue: true,
      })
      if (confirm !== true || prompts.isCancel(confirm)) {
        prompts.cancel("Cancelled")
        return
      }

      // Step 3: Handle library dimension mismatch
      if (selectedKeys.has("core") && srcLibraryInfo.exists) {
        const tgtLibraryInfo = await getLibraryInfo(tgtLibrary)

        if (
          tgtLibraryInfo.exists &&
          srcLibraryInfo.dimensions &&
          tgtLibraryInfo.dimensions &&
          srcLibraryInfo.dimensions !== tgtLibraryInfo.dimensions
        ) {
          prompts.log.warn("Vector dimension mismatch:")
          prompts.log.info(
            `  Source: ${srcLibraryInfo.dimensions}d${srcLibraryInfo.embeddingModel ? ` (${srcLibraryInfo.embeddingModel})` : ""}`,
          )
          prompts.log.info(
            `  Target: ${tgtLibraryInfo.dimensions}d${tgtLibraryInfo.embeddingModel ? ` (${tgtLibraryInfo.embeddingModel})` : ""}`,
          )

          const choice = await prompts.select({
            message: "How should library data be handled?",
            options: [
              {
                value: "text_only" as const,
                label: "Merge text only, discard source vectors",
                hint: "Source memories added without vector search until re-embedded",
              },
              { value: "skip" as const, label: "Skip library entirely", hint: "Source memories are not imported" },
              {
                value: "replace_vectors" as const,
                label: "Replace: use source vectors, drop target vectors",
                hint: "Your existing memories lose vector search",
              },
            ],
          })
          if (prompts.isCancel(choice)) {
            prompts.cancel("Cancelled")
            return
          }
          libraryStrategy = choice as LibraryConflictStrategy
        } else {
          libraryStrategy = "text_only"
        }
      }

      await using homes = await SnapshotArchive.lockHomes([source.dataDir, targetRoot])

      // Step 4: Execute merge
      UI.empty()
      const errors: string[] = []
      let libraryMerged = false

      for (const cat of selectedCategories) {
        for (const subdir of cat.subdirs) {
          const src = path.join(source.dataDir, subdir)
          const dst = path.join(targetRoot, subdir)

          if (!(await dirExists(src))) continue

          // Special: library.db merge
          if (subdir === "data" && libraryStrategy !== "skip" && !libraryMerged) {
            const targetLibraryExists = await dirExists(tgtLibrary)

            if (targetLibraryExists && srcLibraryInfo.exists) {
              const librarySpinner = prompts.spinner()
              librarySpinner.start("Merging library.db...")

              try {
                const result = await mergeLibraryDB(srcLibrary, tgtLibrary, libraryStrategy)
                librarySpinner.stop(
                  `Library: ${result.memoriesMerged} memories merged, ${result.experiencesMerged} experiences merged${result.memoriesSkipped > 0 ? `, ${result.memoriesSkipped} duplicates skipped` : ""}`,
                )
                libraryMerged = true
              } catch (e) {
                librarySpinner.stop("Failed to merge library.db", 1)
                errors.push(`library.db: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          }

          const spinner = prompts.spinner()
          spinner.start(`Merging ${subdir}/...`)

          try {
            if (subdir === "data") await SnapshotArchive.merge(src, dst)
            const result = await copyDirSkipExisting(
              src,
              dst,
              (p) => {
                const pct = Math.round(((p.copied + p.skipped) / p.total) * 100)
                spinner.message(`Merging ${subdir}/ ${pct}% — ${shortenPath(p.currentFile)}`)
              },
              undefined,
              undefined,
              archiveExclusions(subdir),
            )
            const skippedNote = result.skipped > 0 ? ` (${result.skipped} existing files kept)` : ""
            spinner.stop(`Merged ${subdir}/${skippedNote}`)
          } catch (e) {
            spinner.stop(`Failed to merge ${subdir}/`, 1)
            errors.push(`${subdir}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      // Report
      UI.empty()
      if (errors.length > 0) {
        prompts.log.warn("Merge completed with errors:")
        for (const err of errors) prompts.log.error(`  ${err}`)
      } else {
        prompts.log.success("Merge complete")
      }

      prompts.outro("Done")
    } finally {
      await source.cleanup?.()
    }
  },
})

async function prepareSource(sourceArg: string): Promise<SourceInfo | null> {
  const resolved = path.resolve(sourceArg)

  if (resolved.endsWith(".zip") || resolved.endsWith(".tar.gz") || resolved.endsWith(".tgz")) {
    if (!(await dirExists(resolved))) {
      prompts.log.error(`File not found: ${shortenPath(resolved)}`)
      return null
    }

    const spinner = prompts.spinner()
    spinner.start("Extracting archive...")

    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-merge-"))
      const command = resolved.endsWith(".zip")
        ? ["unzip", "-o", "-q", resolved, "-d", tmpDir]
        : ["tar", "-xzf", resolved, "-C", tmpDir]
      const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" })
      const errors = new Response(child.stderr).text()
      if ((await child.exited) !== 0) {
        await fs.rm(tmpDir, { recursive: true, force: true })
        throw new Error(await errors)
      }
      await errors

      // Read manifest if it exists
      const manifestPath = path.join(tmpDir, "manifest.json")
      let manifest: PackManifest | null = null
      if (
        await Bun.file(manifestPath)
          .exists()
          .catch(() => false)
      ) {
        manifest = await Bun.file(manifestPath)
          .json()
          .catch(() => null)
      }

      spinner.stop("Archive extracted")
      return {
        type: "archive",
        path: resolved,
        dataDir: tmpDir,
        manifest,
        cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
      }
    } catch (e) {
      spinner.stop("Failed to extract archive", 1)
      prompts.log.error(`Extraction failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  // Directory source
  if (!(await dirExists(resolved))) {
    prompts.log.error(`Directory not found: ${shortenPath(resolved)}`)
    return null
  }

  // Check for manifest (if merging from a previously packed+extracted dir)
  const manifestPath = path.join(resolved, "manifest.json")
  let manifest: PackManifest | null = null
  if (
    await Bun.file(manifestPath)
      .exists()
      .catch(() => false)
  ) {
    manifest = await Bun.file(manifestPath)
      .json()
      .catch(() => null)
  }

  return {
    type: "directory",
    path: resolved,
    dataDir: resolved,
    manifest,
  }
}
