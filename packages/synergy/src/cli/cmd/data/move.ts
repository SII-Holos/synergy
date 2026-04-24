import fs from "fs/promises"
import path from "path"
import os from "os"
import * as prompts from "@clack/prompts"
import { cmd } from "../cmd"
import { UI } from "../../ui"
import { Global } from "../../../global"
import { SingleInstance } from "../../../daemon/single-instance"
import {
  CATEGORIES,
  scanCategories,
  formatSize,
  shortenPath,
  dirExists,
  checkDiskSpace,
  isDirEmpty,
  copyDirSkipExisting,
  updateShellProfile,
  getEngramInfo,
  mergeEngramDB,
  dataRoot,
  type EngramConflictStrategy,
} from "./shared"

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

  // Step 4: Check running server
  const lock = await SingleInstance.read().catch(() => undefined)
  if (lock && isPidAlive(lock.pid)) {
    prompts.log.warn(
      `Synergy server is running (pid ${lock.pid}). Moving data while running may produce inconsistent results.`,
    )
    const stopFirst = await prompts.confirm({
      message: "Stop the running server before continuing?",
      initialValue: true,
    })
    if (stopFirst === true) {
      try {
        process.kill(lock.pid, "SIGTERM")
        await Bun.sleep(2000)
        prompts.log.info("Server stopped")
      } catch {
        prompts.log.error("Failed to stop server. Please stop it manually and retry.")
        prompts.outro("Move aborted")
        return
      }
    }
  }

  // Step 5: Handle engram.db if core is selected
  let engramStrategy: EngramConflictStrategy = "skip"
  const sourceEngram = path.join(sourceRoot, "data", "engram.db")
  const targetEngram = path.join(targetPath, "data", "engram.db")

  if (selectedKeys.has("core") && (await dirExists(sourceEngram))) {
    const targetEngramExists = await dirExists(targetEngram)

    if (targetEngramExists) {
      const srcInfo = await getEngramInfo(sourceEngram)
      const tgtInfo = await getEngramInfo(targetEngram)

      if (srcInfo.dimensions && tgtInfo.dimensions && srcInfo.dimensions !== tgtInfo.dimensions) {
        prompts.log.warn("Vector dimension mismatch between source and target engram:")
        prompts.log.info(
          `  Source: ${srcInfo.dimensions}d${srcInfo.embeddingModel ? ` (${srcInfo.embeddingModel})` : ""}`,
        )
        prompts.log.info(
          `  Target: ${tgtInfo.dimensions}d${tgtInfo.embeddingModel ? ` (${tgtInfo.embeddingModel})` : ""}`,
        )

        const choice = await prompts.select({
          message: "How should engram data be handled?",
          options: [
            {
              value: "text_only" as const,
              label: "Merge text only, discard source vectors",
              hint: "Source memories added without vector search until re-embedded",
            },
            { value: "skip" as const, label: "Skip engram entirely", hint: "Source memories are not imported" },
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
        engramStrategy = choice as EngramConflictStrategy
      } else {
        engramStrategy = "text_only" // dimensions match or one side has no vec tables
      }
    }
    // If target has no engram.db, the file copy will handle it
  }

  // Step 6: Execute move
  UI.empty()
  const errors: string[] = []
  let engramMerged = false

  for (const cat of selectedCategories) {
    for (const subdir of cat.subdirs) {
      const src = path.join(sourceRoot, subdir)
      const dst = path.join(targetPath, subdir)

      if (!(await dirExists(src))) continue

      // Special handling for engram.db inside data/
      if (subdir === "data" && engramStrategy !== "skip") {
        const targetEngExists = await dirExists(targetEngram)

        if (targetEngExists && selectedKeys.has("core")) {
          // Merge engram via SQL, then copy the rest of data/ skipping engram
          const engSpinner = prompts.spinner()
          engSpinner.start("Merging engram.db...")

          try {
            const result = await mergeEngramDB(sourceEngram, targetEngram, engramStrategy)
            engSpinner.stop(
              `Merged engram: ${result.memoriesMerged} memories, ${result.experiencesMerged} experiences${result.vecDropped ? " (vectors handled per strategy)" : ""}`,
            )
            engramMerged = true
          } catch (e) {
            engSpinner.stop("Failed to merge engram.db", 1)
            errors.push(`engram.db: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      const catSize = catStats.get(cat.key)?.size ?? 0
      const spinner = prompts.spinner()
      spinner.start(`Moving ${subdir}/ (${formatSize(catSize)})...`)

      try {
        const result = await copyDirSkipExisting(src, dst, (p) => {
          const pct = Math.round(((p.copied + p.skipped) / p.total) * 100)
          spinner.message(`Moving ${subdir}/ ${pct}% — ${shortenPath(p.currentFile)}`)
        })
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
