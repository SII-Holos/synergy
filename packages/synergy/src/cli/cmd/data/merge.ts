import fs from "fs/promises"
import path from "path"
import os from "os"
import * as prompts from "@clack/prompts"
import { cmd } from "../cmd"
import { UI } from "../../ui"
import {
  CATEGORIES,
  scanCategories,
  formatSize,
  shortenPath,
  dirExists,
  copyDirSkipExisting,
  getEngramInfo,
  mergeEngramDB,
  dataRoot,
  type EngramConflictStrategy,
} from "./shared"

interface SourceInfo {
  type: "directory" | "zip"
  path: string
  /** For zip: extracted temp directory. For directory: same as path. */
  dataDir: string
  manifest: PackManifest | null
  cleanup?: () => Promise<void>
}

interface PackManifest {
  version: number
  createdAt: string
  engram: {
    dimensions: number | null
    embeddingModel: string | null
    memoryCount: number
    experienceCount: number
  } | null
}

export const DataMergeCommand = cmd({
  command: "merge <source>",
  describe: "merge data from another synergy directory or zip archive",
  builder: (yargs) =>
    yargs.positional("source", {
      type: "string",
      describe: "source directory path or zip file",
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

      // Check engram compatibility from manifest or direct scan
      const srcEngram = path.join(source.dataDir, "data", "engram.db")
      const tgtEngram = path.join(targetRoot, "data", "engram.db")
      let srcEngramInfo = await getEngramInfo(srcEngram)
      let engramStrategy: EngramConflictStrategy = "text_only"

      // If we have a manifest, show it
      if (source.manifest) {
        const m = source.manifest
        prompts.log.info(`Archive created: ${m.createdAt}`)
        if (m.engram) {
          prompts.log.info(`Source engram: ${m.engram.dimensions ?? "no"} dimensions${m.engram.embeddingModel ? ` (${m.engram.embeddingModel})` : ""}, ${m.engram.memoryCount} memories`)
        }
      }

      // Step 1: Select categories
      const selectable = CATEGORIES.filter((c) => !c.required)
      const selected = await prompts.multiselect({
        message: "What should be merged?",
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

      const selectedKeys = new Set([...(selected as string[]), ...CATEGORIES.filter((c) => c.required).map((c) => c.key)])
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

      // Step 3: Handle engram dimension mismatch
      if (selectedKeys.has("core") && srcEngramInfo.exists) {
        const tgtEngramInfo = await getEngramInfo(tgtEngram)

        if (tgtEngramInfo.exists && srcEngramInfo.dimensions && tgtEngramInfo.dimensions && srcEngramInfo.dimensions !== tgtEngramInfo.dimensions) {
          prompts.log.warn("Vector dimension mismatch:")
          prompts.log.info(`  Source: ${srcEngramInfo.dimensions}d${srcEngramInfo.embeddingModel ? ` (${srcEngramInfo.embeddingModel})` : ""}`)
          prompts.log.info(`  Target: ${tgtEngramInfo.dimensions}d${tgtEngramInfo.embeddingModel ? ` (${tgtEngramInfo.embeddingModel})` : ""}`)

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
          engramStrategy = "text_only"
        }
      }

      // Step 4: Execute merge
      UI.empty()
      const errors: string[] = []
      let engramMerged = false

      for (const cat of selectedCategories) {
        for (const subdir of cat.subdirs) {
          const src = path.join(source.dataDir, subdir)
          const dst = path.join(targetRoot, subdir)

          if (!(await dirExists(src))) continue

          // Special: engram.db merge
          if (subdir === "data" && engramStrategy !== "skip" && !engramMerged) {
            const targetEngExists = await dirExists(tgtEngram)

            if (targetEngExists && srcEngramInfo.exists) {
              const engSpinner = prompts.spinner()
              engSpinner.start("Merging engram.db...")

              try {
                const result = await mergeEngramDB(srcEngram, tgtEngram, engramStrategy)
                engSpinner.stop(
                  `Engram: ${result.memoriesMerged} memories merged, ${result.experiencesMerged} experiences merged${result.memoriesSkipped > 0 ? `, ${result.memoriesSkipped} duplicates skipped` : ""}`,
                )
                engramMerged = true
              } catch (e) {
                engSpinner.stop("Failed to merge engram.db", 1)
                errors.push(`engram.db: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          }

          const spinner = prompts.spinner()
          spinner.start(`Merging ${subdir}/...`)

          try {
            const catFileCount = srcCatStats.get(cat.key)?.fileCount ?? 0
            const result = await copyDirSkipExisting(src, dst, (p) => {
              const pct = Math.round(((p.copied + p.skipped) / p.total) * 100)
              spinner.message(`Merging ${subdir}/ ${pct}% — ${shortenPath(p.currentFile)}`)
            }, undefined, catFileCount)
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

  // Check if it's a zip file
  if (resolved.endsWith(".zip")) {
    if (!(await dirExists(resolved))) {
      prompts.log.error(`File not found: ${shortenPath(resolved)}`)
      return null
    }

    const spinner = prompts.spinner()
    spinner.start("Extracting archive...")

    try {
      const tmpDir = path.join(os.tmpdir(), `synergy-merge-${Date.now()}`)
      await fs.mkdir(tmpDir, { recursive: true })

      const { execSync } = await import("child_process")
      execSync(`unzip -o -q "${resolved}" -d "${tmpDir}"`, { stdio: "pipe" })

      // Read manifest if it exists
      const manifestPath = path.join(tmpDir, "manifest.json")
      let manifest: PackManifest | null = null
      if (await Bun.file(manifestPath).exists().catch(() => false)) {
        manifest = await Bun.file(manifestPath).json().catch(() => null)
      }

      spinner.stop("Archive extracted")
      return {
        type: "zip",
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
  if (await Bun.file(manifestPath).exists().catch(() => false)) {
    manifest = await Bun.file(manifestPath).json().catch(() => null)
  }

  return {
    type: "directory",
    path: resolved,
    dataDir: resolved,
    manifest,
  }
}
