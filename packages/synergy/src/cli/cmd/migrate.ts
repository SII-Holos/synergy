import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import os from "os"
import { cmd } from "./cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Global } from "../../global"
import { SingleInstance } from "../../daemon/single-instance"

interface MigrateCategory {
  key: string
  label: string
  subdirs: string[]
  required: boolean
  defaultValue: boolean
}

const CATEGORIES: MigrateCategory[] = [
  {
    key: "core",
    label: "Core data (sessions, notes, agenda, engram, auth)",
    subdirs: ["data"],
    required: true,
    defaultValue: true,
  },
  {
    key: "config",
    label: "Configuration (global config, agents, skills, commands)",
    subdirs: ["config"],
    required: true,
    defaultValue: true,
  },
  {
    key: "media",
    label: "Media & assets (attachments, images)",
    subdirs: ["media", "assets"],
    required: false,
    defaultValue: true,
  },
  {
    key: "bin",
    label: "Binaries (LSP servers, tools)",
    subdirs: ["bin"],
    required: false,
    defaultValue: true,
  },
  {
    key: "schema",
    label: "Schema (config schema)",
    subdirs: ["schema"],
    required: false,
    defaultValue: true,
  },
  {
    key: "cache",
    label: "Cache (can be rebuilt)",
    subdirs: ["cache"],
    required: false,
    defaultValue: false,
  },
  {
    key: "logs",
    label: "Logs (historical logs)",
    subdirs: ["log"],
    required: false,
    defaultValue: false,
  },
  {
    key: "state",
    label: "State (runtime state, regenerated on restart)",
    subdirs: ["state"],
    required: false,
    defaultValue: false,
  },
]

interface DirStats {
  size: number
  fileCount: number
}

export const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate synergy data to a new location",
  builder: (yargs) =>
    yargs
      .option("target", {
        type: "string",
        describe: "target directory path",
      })
      .option("remove-original", {
        type: "boolean",
        default: false,
        describe: "remove original data after successful migration",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "show migration plan without executing",
      }),
  handler: async (args) => {
    const target = args.target as string | undefined
    const removeOriginal = args.removeOriginal as boolean
    const dryRun = args.dryRun as boolean
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Migrate Synergy Data")

    const sourceRoot = Global.Path.root

    if (!(await dirExists(sourceRoot))) {
      prompts.log.error(`No synergy data found at ${shortenPath(sourceRoot)}`)
      prompts.outro("Nothing to migrate")
      return
    }

    // Scan source directory sizes
    const spinner = prompts.spinner()
    spinner.start("Scanning data...")
    const categoryStats = new Map<string, DirStats>()
    let totalSize = 0
    let totalFiles = 0

    for (const cat of CATEGORIES) {
      let catSize = 0
      let catFiles = 0
      for (const subdir of cat.subdirs) {
        const stats = await scanDir(path.join(sourceRoot, subdir)).catch(() => ({ size: 0, fileCount: 0 }))
        catSize += stats.size
        catFiles += stats.fileCount
      }
      categoryStats.set(cat.key, { size: catSize, fileCount: catFiles })
      totalSize += catSize
      totalFiles += catFiles
    }
    spinner.stop(`Scanned ${formatSize(totalSize)} across ${totalFiles.toLocaleString()} files`)

    prompts.log.info(`Current location: ${shortenPath(sourceRoot)} (${formatSize(totalSize)})`)

    // Step 1: Target directory
    let targetPath: string
    if (target) {
      targetPath = path.resolve(target)
    } else {
      const input = await prompts.text({
        message: "Where would you like to move your data?",
        placeholder: path.join(os.homedir(), ".local", "share", "synergy-data"),
        validate: (v) => {
          if (!v?.trim()) return "Please enter a path"
          return undefined
        },
      })
      if (prompts.isCancel(input)) {
        prompts.cancel("Migration cancelled")
        return
      }
      targetPath = path.resolve(input)
    }

    if (targetPath === sourceRoot) {
      prompts.log.error("Target path is the same as current location")
      prompts.outro("Nothing to migrate")
      return
    }

    // Check disk space
    const diskOk = await checkDiskSpace(targetPath, totalSize)
    const availStr = diskOk.available != null ? formatSize(diskOk.available) : "unknown"
    if (!diskOk.ok) {
      prompts.log.error(`Insufficient disk space at target (${availStr} available, ${formatSize(totalSize)} needed)`)
      prompts.outro("Migration aborted")
      return
    }
    prompts.log.info(`Target: ${shortenPath(targetPath)} (disk: ${availStr} available)`)

    // Step 2: Select categories
    const selectable = CATEGORIES.filter((c) => !c.required)
    const selected = await prompts.multiselect({
      message: "What should be migrated?",
      options: selectable.map((cat) => ({
        value: cat.key,
        label: cat.label,
        hint: formatSize(categoryStats.get(cat.key)?.size ?? 0),
      })),
      initialValues: selectable.filter((c) => c.defaultValue).map((c) => c.key),
      required: false,
    })
    if (prompts.isCancel(selected)) {
      prompts.cancel("Migration cancelled")
      return
    }

    const selectedKeys = new Set([...(selected as string[]), ...CATEGORIES.filter((c) => c.required).map((c) => c.key)])
    const selectedCategories = CATEGORIES.filter((c) => selectedKeys.has(c.key))
    const selectedSize = selectedCategories.reduce((sum, c) => sum + (categoryStats.get(c.key)?.size ?? 0), 0)

    // Show plan
    UI.empty()
    prompts.log.message("Migration plan:")
    for (const cat of CATEGORIES) {
      const included = selectedKeys.has(cat.key)
      const size = categoryStats.get(cat.key)?.size ?? 0
      const icon = included ? "●" : "○"
      const dim = included ? "" : UI.Style.TEXT_DIM
      for (const subdir of cat.subdirs) {
        const subSize = await scanDir(path.join(sourceRoot, subdir)).catch(() => ({ size: 0 }))
        prompts.log.info(
          `  ${icon} ${dim}${subdir.padEnd(12)}${UI.Style.TEXT_NORMAL} → ${shortenPath(path.join(targetPath, subdir))}  ${UI.Style.TEXT_DIM}(${formatSize(subSize.size)})`,
        )
      }
    }

    if (dryRun) {
      prompts.outro("Dry run — no changes made")
      return
    }

    // Step 3: Confirm
    const confirm = await prompts.confirm({
      message: `Migrate ${formatSize(selectedSize)} to ${shortenPath(targetPath)}?`,
      initialValue: true,
    })
    if (confirm !== true || prompts.isCancel(confirm)) {
      prompts.cancel("Migration cancelled")
      return
    }

    // Step 4: Check running processes
    const lock = await SingleInstance.read().catch(() => undefined)
    if (lock && (await isPidAlive(lock.pid))) {
      prompts.log.warn(`Synergy server is running (pid ${lock.pid}). Migration may produce inconsistent data.`)
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
          prompts.outro("Migration aborted")
          return
        }
      }
    }

    // Step 5: Execute migration
    UI.empty()
    const errors: string[] = []

    for (const cat of selectedCategories) {
      for (const subdir of cat.subdirs) {
        const src = path.join(sourceRoot, subdir)
        const dst = path.join(targetPath, subdir)

        if (!(await dirExists(src))) continue

        const catStats = categoryStats.get(cat.key) ?? { size: 0, fileCount: 0 }
        const progressSpinner = prompts.spinner()
        progressSpinner.start(`Migrating ${subdir}/ (${formatSize(catStats.size)})...`)

        try {
          await copyDir(src, dst)
          progressSpinner.stop(`Migrated ${subdir}/`)
        } catch (e) {
          progressSpinner.stop(`Failed to migrate ${subdir}/`, 1)
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`${subdir}: ${msg}`)
        }
      }
    }

    // Step 6: Write SYNERGY_HOME marker
    if (errors.length === 0) {
      const markerPath = path.join(targetPath, ".synergy-home")
      await Bun.write(
        markerPath,
        `# This file marks the directory as a Synergy data root.\n# Created by 'synergy migrate' on ${new Date().toISOString()}\n`,
      )
    }

    // Step 7: Update shell profile
    if (errors.length === 0) {
      const profileResult = await updateShellProfile(targetPath)
      if (profileResult.updated) {
        prompts.log.info(`Added SYNERGY_HOME to ${shortenPath(profileResult.file!)}`)
      } else if (profileResult.file) {
        prompts.log.warn(
          `SYNERGY_HOME already set in ${shortenPath(profileResult.file)} — verify it points to ${shortenPath(targetPath)}`,
        )
      } else {
        prompts.log.warn("Could not find a shell profile to update. Add this line manually:")
        prompts.log.info(`  export SYNERGY_HOME=${targetPath}`)
      }
    }

    // Step 8: Remove original if requested
    if (errors.length === 0 && removeOriginal) {
      const rmSpinner = prompts.spinner()
      rmSpinner.start("Removing original data...")
      try {
        await fs.rm(sourceRoot, { recursive: true, force: true })
        rmSpinner.stop("Original data removed")
      } catch (e) {
        rmSpinner.stop("Failed to remove original data", 1)
        prompts.log.warn("Remove it manually after verification: " + shortenPath(sourceRoot))
      }
    }

    // Report
    UI.empty()
    if (errors.length > 0) {
      prompts.log.warn("Migration completed with errors:")
      for (const err of errors) {
        prompts.log.error(`  ${err}`)
      }
      prompts.log.info("Check the errors above. Original data is preserved at " + shortenPath(sourceRoot))
    } else {
      prompts.log.success("Migration complete!")
    }

    if (!removeOriginal || errors.length > 0) {
      prompts.log.info(`Original data preserved at ${shortenPath(sourceRoot)} (remove manually after verification)`)
    }
    prompts.log.info("Restart any running synergy servers to use the new location")

    prompts.outro("Done")
  },
})

async function dirExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

async function scanDir(dir: string): Promise<DirStats> {
  let size = 0
  let fileCount = 0

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) {
          size += stat.size
          fileCount++
        }
      }
    }
  }

  await walk(dir)
  return { size, fileCount }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath)
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(srcPath)
      await fs.symlink(linkTarget, dstPath).catch(() => {})
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) return p.replace(home, "~")
  return p
}

async function checkDiskSpace(target: string, needed: number): Promise<{ ok: boolean; available: number | null }> {
  try {
    const targetParent = path.dirname(target)
    await fs.mkdir(targetParent, { recursive: true })

    if (process.platform === "darwin" || process.platform === "linux") {
      const stat = await fsSync.promises.statfs(targetParent)
      const available = Number(stat.bavail) * Number(stat.bsize)
      return { ok: available > needed * 1.1, available }
    }
    return { ok: true, available: null }
  } catch {
    return { ok: true, available: null }
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function updateShellProfile(targetPath: string): Promise<{ updated: boolean; file: string | null }> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const candidates: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [path.join(home, ".zshenv"), path.join(home, ".zshrc"), path.join(xdgConfig, "zsh", ".zshenv")],
    bash: [path.join(home, ".bashrc"), path.join(home, ".bash_profile"), path.join(home, ".profile")],
  }

  const files = candidates[shell] ?? candidates.bash

  const exportLine = `export SYNERGY_HOME="${targetPath}"`
  const fishLine = `set -gx SYNERGY_HOME "${targetPath}"`

  for (const file of files) {
    const exists = await Bun.file(file)
      .exists()
      .catch(() => false)
    if (!exists) continue

    const content = await Bun.file(file)
      .text()
      .catch(() => "")

    if (content.includes("SYNERGY_HOME")) {
      return { updated: false, file }
    }

    const line = shell === "fish" ? fishLine : exportLine
    const marker = "# synergy"
    const newContent = content.trimEnd() + `\n\n${marker}\n${line}\n`

    await Bun.write(file, newContent)
    return { updated: true, file }
  }

  return { updated: false, file: null }
}
