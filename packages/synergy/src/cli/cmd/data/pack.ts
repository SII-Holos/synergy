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
  dataRoot,
  getEngramInfo,
} from "./shared"

export const DataPackCommand = cmd({
  command: "pack [output]",
  describe: "pack synergy data into a zip archive",
  builder: (yargs) =>
    yargs.positional("output", {
      type: "string",
      describe: "output zip file path",
      default: "",
    }),
  handler: async (args) => {
    const root = dataRoot()
    const outputArg = args.output as string

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Pack Synergy Data")

    const catStats = await scanCategories(root)
    let totalSize = 0
    for (const stats of catStats.values()) totalSize += stats.size

    prompts.log.info(`Location: ${shortenPath(root)} (${formatSize(totalSize)})`)

    // Step 1: Select categories
    const selectable = CATEGORIES.filter((c) => !c.required)
    const selected = await prompts.multiselect({
      message: "What should be packed?",
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

    // Step 2: Determine output path
    const dateStr = new Date().toISOString().slice(0, 10)
    const defaultName = `synergy-data-${dateStr}.zip`
    const outputPath = outputArg
      ? path.resolve(outputArg.endsWith(".zip") ? outputArg : `${outputArg}.zip`)
      : path.join(os.homedir(), defaultName)

    // Step 3: Build manifest
    const engramInfo = await getEngramInfo(path.join(root, "data", "engram.db"))
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      engram: engramInfo.exists
        ? {
            dimensions: engramInfo.dimensions,
            embeddingModel: engramInfo.embeddingModel,
            memoryCount: engramInfo.memoryCount,
            experienceCount: engramInfo.experienceCount,
          }
        : null,
    }

    // Step 4: Pack
    const spinner = prompts.spinner()
    spinner.start("Packing data...")

    try {
      // Write manifest to a temp location
      const tmpDir = path.join(os.tmpdir(), `synergy-pack-${Date.now()}`)
      await fs.mkdir(tmpDir, { recursive: true })
      await Bun.write(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2))

      // Build the list of paths to include
      const includePaths: string[] = ["manifest.json"]
      for (const cat of selectedCategories) {
        for (const subdir of cat.subdirs) {
          const full = path.join(root, subdir)
          if (await fs.access(full).then(() => true).catch(() => false)) {
            includePaths.push(subdir)
          }
        }
      }

      // Use Bun.zip or fall back to a manual approach
      // Bun doesn't have a built-in zip, so we use the `zip` CLI or archiver
      const { execSync } = await import("child_process")

      // Check if zip is available
      try {
        execSync("which zip", { stdio: "pipe" })
      } catch {
        // Fall back: use tar.gz
        const tarPath = outputPath.replace(/\.zip$/, ".tar.gz")
        spinner.message(`Packing to ${shortenPath(tarPath)}...`)

        const dirsToTar = includePaths.filter((p) => p !== "manifest.json")
        const cmd = `tar -czf "${tarPath}" -C "${tmpDir}" manifest.json ${dirsToTar.map((d) => `-C "${root}" "${d}"`).join(" ")}`

        try {
          execSync(cmd, { stdio: "pipe" })
        } catch {
          // Simpler approach: tar each separately
          execSync(`tar -czf "${tarPath}" -C "${tmpDir}" manifest.json`, { stdio: "pipe" })
          for (const d of dirsToTar) {
            execSync(`tar -rf "${tarPath}" -C "${root}" "${d}"`, { stdio: "pipe" })
          }
        }

        await fs.rm(tmpDir, { recursive: true, force: true })
        spinner.stop(`Packed to ${shortenPath(tarPath)}`)
        prompts.outro("Done")
        return
      }

      spinner.message(`Packing to ${shortenPath(outputPath)}...`)

      // Use zip CLI
      const dirsToZip = includePaths.filter((p) => p !== "manifest.json")

      // Create zip with manifest first
      execSync(`zip -j "${outputPath}" "${path.join(tmpDir, "manifest.json")}"`, { stdio: "pipe" })

      // Add each directory
      for (const d of dirsToZip) {
        const full = path.join(root, d)
        spinner.message(`Packing ${d}/...`)
        execSync(`zip -r -u "${outputPath}" "${d}" -C "${root}"`, { stdio: "pipe" })
      }

      await fs.rm(tmpDir, { recursive: true, force: true })

      const packedSize = (await fs.stat(outputPath)).size
      spinner.stop(`Packed to ${shortenPath(outputPath)} (${formatSize(packedSize)})`)
    } catch (e) {
      spinner.stop("Packing failed", 1)
      prompts.log.error(`Failed to pack: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Failed")
      return
    }

    prompts.outro("Done")
  },
})
