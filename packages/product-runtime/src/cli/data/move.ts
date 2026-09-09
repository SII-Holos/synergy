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
import { Global } from "@ericsanchezok/synergy-harness/global"
import {
  archiveExclusions,
  CATEGORIES,
  scanCategories,
  formatSize,
  shortenPath,
  dirExists,
  checkDiskSpace,
  isDirEmpty,
  copyDirSkipExisting,
  updateShellProfile,
  dataRoot,
} from "@ericsanchezok/synergy-cli/cli/cmd/data/shared"

export interface MoveOptions {
  target?: string
  removeOriginal: boolean
  dryRun: boolean
}

export async function executeMove(opts: MoveOptions) {
  const sourceRoot = dataRoot()

  if (!(await dirExists(sourceRoot))) {
    prompts.log.error(`No synergy data found at ${shortenPath(sourceRoot)}`)
    prompts.outro("Nothing to move")
    return
  }

  const catStats = await scanCategories(sourceRoot)
  let totalSize = 0
  let totalFiles = 0
  for (const stats of catStats.values()) {
    totalSize += stats.size
    totalFiles += stats.fileCount
  }

  prompts.log.info(
    `Source: ${shortenPath(sourceRoot)} (${formatSize(totalSize)}, ${totalFiles.toLocaleString()} files)`,
  )

  // Step 1: Target directory
  // User provides a base path (SYNERGY_HOME). The actual data root is basePath/.synergy
  // because root() = path.join(SYNERGY_HOME, ".synergy").
  let homePath: string
  if (opts.target) {
    homePath = path.resolve(opts.target)
  } else {
    const input = await prompts.text({
      message: "Where should the data be moved to?",
      placeholder: path.join(os.homedir(), ".local", "share", "synergy-data"),
      validate: (v) => {
        if (!v?.trim()) return "Please enter a path"
        return undefined
      },
    })
    if (prompts.isCancel(input)) {
      prompts.cancel("Cancelled")
      return
    }
    homePath = path.resolve(input)
  }

  const targetPath = homePath.endsWith(".synergy") ? homePath : path.join(homePath, ".synergy")

  if (targetPath === sourceRoot) {
    prompts.log.error("Target is the same as current location")
    prompts.outro("Nothing to move")
    return
  }

  // Check disk space
  const diskOk = await checkDiskSpace(homePath, totalSize)
  const availStr = diskOk.available != null ? formatSize(diskOk.available) : "unknown"
  if (!diskOk.ok) {
    prompts.log.error(`Insufficient disk space at target (${availStr} available, ${formatSize(totalSize)} needed)`)
    prompts.outro("Move aborted")
    return
  }

  // Check if target has existing data
  const targetExists = await dirExists(targetPath)
  const targetEmpty = targetExists ? await isDirEmpty(targetPath).catch(() => true) : true

  if (targetExists && !targetEmpty) {
    const targetStats = await scanCategories(targetPath)
    let targetSize = 0
    for (const stats of targetStats.values()) targetSize += stats.size
    prompts.log.info(`Target: ${shortenPath(targetPath)} (${formatSize(targetSize)} existing)`)
    prompts.log.warn("Target already contains data. Existing files will be kept — nothing will be overwritten.")
  } else {
    prompts.log.info(`Target: ${shortenPath(targetPath)} (${availStr} available)`)
  }

  // Step 2: Select categories
  const selectable = CATEGORIES.filter((c) => !c.required)
  const selected = await prompts.multiselect({
    message: "What should be moved? (Space to toggle, Enter to confirm)",
    options: selectable.map((cat) => ({
      value: cat.key,
      label: cat.label,
      hint: formatSize(catStats.get(cat.key)?.size ?? 0),
    })),
    initialValues: selectable.filter((c) => c.defaultValue).map((c) => c.key),
    required: false,
  })
  if (prompts.isCancel(selected)) {
    prompts.cancel("Cancelled")
    return
  }

  const selectedKeys = new Set([...(selected as string[]), ...CATEGORIES.filter((c) => c.required).map((c) => c.key)])
  const selectedCategories = CATEGORIES.filter((c) => selectedKeys.has(c.key))
  const selectedSize = selectedCategories.reduce((sum, c) => sum + (catStats.get(c.key)?.size ?? 0), 0)

  // Show plan
  UI.empty()
  prompts.log.message("Move plan:")
  for (const cat of CATEGORIES) {
    const included = selectedKeys.has(cat.key)
    const icon = included ? "●" : "○"
    const dim = included ? "" : UI.Style.TEXT_DIM
    for (const subdir of cat.subdirs) {
      const subStats = await scanDir(path.join(sourceRoot, subdir)).catch(() => ({ size: 0 }))
      prompts.log.info(
        `  ${icon} ${dim}${subdir.padEnd(12)}${UI.Style.TEXT_NORMAL} → ${shortenPath(path.join(targetPath, subdir))}  ${UI.Style.TEXT_DIM}(${formatSize(subStats.size)})`,
      )
    }
  }

  if (opts.dryRun) {
    prompts.outro("Dry run — no changes made")
    return
  }

  // Step 3: Confirm
  const confirm = await prompts.confirm({
    message: `Move ${formatSize(selectedSize)} to ${shortenPath(targetPath)}?`,
    initialValue: true,
  })
  if (confirm !== true || prompts.isCancel(confirm)) {
    prompts.cancel("Cancelled")
    return
  }

  await using homes = await SnapshotArchive.lockHomes([sourceRoot, targetPath])

  // Step 5: Handle library.db if core is selected
  let libraryStrategy: LibraryConflictStrategy = "skip"
  const sourceLibrary = await resolveLibraryDB(sourceRoot)
  const targetLibrary = path.join(targetPath, "data", "library.db")

  if (selectedKeys.has("core") && (await dirExists(sourceLibrary))) {
    const targetLibraryExists = await dirExists(targetLibrary)

    if (targetLibraryExists) {
      const srcInfo = await getLibraryInfo(sourceLibrary)
      const tgtInfo = await getLibraryInfo(targetLibrary)

      if (srcInfo.dimensions && tgtInfo.dimensions && srcInfo.dimensions !== tgtInfo.dimensions) {
        prompts.log.warn("Vector dimension mismatch between source and target library:")
        prompts.log.info(
          `  Source: ${srcInfo.dimensions}d${srcInfo.embeddingModel ? ` (${srcInfo.embeddingModel})` : ""}`,
        )
        prompts.log.info(
          `  Target: ${tgtInfo.dimensions}d${tgtInfo.embeddingModel ? ` (${tgtInfo.embeddingModel})` : ""}`,
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
        libraryStrategy = "text_only" // dimensions match or one side has no vec tables
      }
    }
    // If target has no library.db, the file copy will handle it
  }

  // Step 6: Execute move
  UI.empty()
  const errors: string[] = []
  let libraryMerged = false

  for (const cat of selectedCategories) {
    for (const subdir of cat.subdirs) {
      const src = path.join(sourceRoot, subdir)
      const dst = path.join(targetPath, subdir)

      if (!(await dirExists(src))) continue

      // Special handling for library.db inside data/
      if (subdir === "data" && libraryStrategy !== "skip") {
        const targetLibraryExists = await dirExists(targetLibrary)

        if (targetLibraryExists && selectedKeys.has("core")) {
          // Merge library via SQL, then copy the rest of data/ skipping library
          const librarySpinner = prompts.spinner()
          librarySpinner.start("Merging library.db...")

          try {
            const result = await mergeLibraryDB(sourceLibrary, targetLibrary, libraryStrategy)
            librarySpinner.stop(
              `Merged library: ${result.memoriesMerged} memories, ${result.experiencesMerged} experiences${result.vecDropped ? " (vectors handled per strategy)" : ""}`,
            )
            libraryMerged = true
          } catch (e) {
            librarySpinner.stop("Failed to merge library.db", 1)
            errors.push(`library.db: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      const catSize = catStats.get(cat.key)?.size ?? 0
      const spinner = prompts.spinner()
      spinner.start(`Moving ${subdir}/ (${formatSize(catSize)})...`)

      try {
        if (subdir === "data") await SnapshotArchive.merge(src, dst)
        const result = await copyDirSkipExisting(
          src,
          dst,
          (p) => {
            const pct = Math.round(((p.copied + p.skipped) / p.total) * 100)
            spinner.message(`Moving ${subdir}/ ${pct}% — ${shortenPath(p.currentFile)}`)
          },
          undefined,
          undefined,
          archiveExclusions(subdir),
        )
        const skippedNote = result.skipped > 0 ? ` (${result.skipped} existing files kept)` : ""
        spinner.stop(`Moved ${subdir}/${skippedNote}`)
      } catch (e) {
        spinner.stop(`Failed to move ${subdir}/`, 1)
        errors.push(`${subdir}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // Step 7: Write marker
  if (errors.length === 0) {
    const markerPath = path.join(targetPath, ".synergy-home")
    await Bun.write(markerPath, `# Created by 'synergy data move' on ${new Date().toISOString()}\n`)
  }

  // Step 8: Remove original if requested
  if (errors.length === 0 && opts.removeOriginal) {
    const rmSpinner = prompts.spinner()
    rmSpinner.start("Removing original data...")
    try {
      await fs.rm(sourceRoot, { recursive: true, force: true })
      rmSpinner.stop("Original data removed")
    } catch (e) {
      rmSpinner.stop("Failed to remove original data", 1)
      prompts.log.warn("Remove manually after verification: " + shortenPath(sourceRoot))
    }
  }

  // Report
  UI.empty()
  if (errors.length > 0) {
    prompts.log.warn("Move completed with errors:")
    for (const err of errors) prompts.log.error(`  ${err}`)
    prompts.log.info("Original data preserved at " + shortenPath(sourceRoot))
  } else {
    prompts.log.success("Data moved to " + shortenPath(targetPath))
  }

  if (!opts.removeOriginal || errors.length > 0) {
    prompts.log.info(`Original data preserved at ${shortenPath(sourceRoot)}`)
  }
  prompts.log.info(`Run \`synergy data set-home ${shortenPath(homePath)}\` to switch to the new location`)
  prompts.log.info("Restart any running synergy servers to use the new location")

  prompts.outro("Done")
}

async function scanDir(dir: string): Promise<{ size: number }> {
  let size = 0
  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) size += stat.size
      }
    }
  }
  await walk(dir)
  return { size }
}

export const DataMoveCommand = cmd({
  command: "move <target>",
  describe: "move synergy data to a new location",
  builder: (yargs) =>
    yargs
      .positional("target", {
        type: "string",
        describe: "target directory path",
        demandOption: true,
      })
      .option("remove-original", {
        type: "boolean",
        default: false,
        describe: "remove original data after successful move",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "show plan without executing",
      }),
  handler: async (args) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Move Synergy Data")

    await executeMove({
      target: args.target as string,
      removeOriginal: args.removeOriginal as boolean,
      dryRun: args.dryRun as boolean,
    })
  },
})
