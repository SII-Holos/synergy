import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import os from "os"
import { UI } from "../../../util/ui"
import { Global } from "@ericsanchezok/synergy-harness/global"

export interface Category {
  key: string
  label: string
  subdirs: string[]
  required: boolean
  defaultValue: boolean
}

export const CATEGORIES: Category[] = [
  {
    key: "core",
    label: "Core data (sessions, notes, agenda, library, auth, holos)",
    subdirs: ["data"],
    required: true,
    defaultValue: true,
  },
  {
    key: "config",
    label: "Config (global config, agents, skills)",
    subdirs: ["config"],
    required: true,
    defaultValue: true,
  },
  {
    key: "media",
    label: "Media & assets",
    subdirs: ["media", "assets"],
    required: false,
    defaultValue: true,
  },
  {
    key: "bin",
    label: "Binaries (LSP servers)",
    subdirs: ["bin"],
    required: false,
    defaultValue: false,
  },
  {
    key: "schema",
    label: "Schema",
    subdirs: ["schema"],
    required: false,
    defaultValue: false,
  },
  {
    key: "cache",
    label: "Cache (rebuildable)",
    subdirs: ["cache"],
    required: false,
    defaultValue: false,
  },
  {
    key: "logs",
    label: "Logs",
    subdirs: ["log"],
    required: false,
    defaultValue: false,
  },
  {
    key: "state",
    label: "State (regenerated on restart)",
    subdirs: ["state"],
    required: false,
    defaultValue: false,
  },
]

export interface DirStats {
  size: number
  fileCount: number
}

export async function scanDir(dir: string): Promise<DirStats> {
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

export async function scanCategories(root: string): Promise<Map<string, DirStats>> {
  const result = new Map<string, DirStats>()
  for (const cat of CATEGORIES) {
    let size = 0
    let fileCount = 0
    for (const subdir of cat.subdirs) {
      const stats = await scanDir(path.join(root, subdir)).catch(() => ({ size: 0, fileCount: 0 }))
      size += stats.size
      fileCount += stats.fileCount
    }
    result.set(cat.key, { size, fileCount })
  }
  return result
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) return p.replace(home, "~")
  return p
}

export async function dirExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

export async function checkDiskSpace(
  target: string,
  needed: number,
): Promise<{ ok: boolean; available: number | null }> {
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

export async function isDirEmpty(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir).catch(() => [])
  return entries.length === 0
}

export function archiveExclusions(directory: string): string[] {
  if (directory === "data") return ["snapshot", "snapshot-v2"]
  if (directory === "cache") return ["snapshot-index"]
  if (directory === "state") return [path.join("daemon", "runtime-lock.json")]
  return []
}

export interface CopyProgress {
  copied: number
  skipped: number
  total: number
  currentFile: string
}

/** Copy src into dst. Skips files that already exist in dst. */
export async function copyDirSkipExisting(
  src: string,
  dst: string,
  onProgress?: (progress: CopyProgress) => void,
  rootSrc?: string,
  totalFiles?: number,
  exclude: string[] = [],
): Promise<{ copied: number; skipped: number }> {
  if (!rootSrc) {
    rootSrc = src
  }
  // Skip expensive file count if caller doesn't need progress
  if (onProgress && !totalFiles) {
    totalFiles = await countFiles(src)
  }

  // Shared mutable counters so recursive calls accumulate correctly
  const acc = { copied: 0, skipped: 0 }

  async function walk(currentSrc: string, currentDst: string) {
    await fs.mkdir(currentDst, { recursive: true })
    const entries = await fs.readdir(currentSrc, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(currentSrc, entry.name)
      const dstPath = path.join(currentDst, entry.name)
      if (exclude.includes(path.relative(src, srcPath))) continue

      if (entry.isDirectory()) {
        await walk(srcPath, dstPath)
      } else if (entry.isFile()) {
        const exists = await fs
          .access(dstPath)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          acc.skipped++
        } else {
          await fs.copyFile(srcPath, dstPath)
          acc.copied++
        }
        if (onProgress && totalFiles) {
          onProgress({
            copied: acc.copied,
            skipped: acc.skipped,
            total: totalFiles,
            currentFile: path.relative(rootSrc!, srcPath),
          })
        }
      } else if (entry.isSymbolicLink()) {
        const exists = await fs
          .access(dstPath)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          acc.skipped++
        } else {
          const linkTarget = await fs.readlink(srcPath)
          await fs.symlink(linkTarget, dstPath).catch(() => {})
          acc.copied++
        }
        if (onProgress && totalFiles) {
          onProgress({
            copied: acc.copied,
            skipped: acc.skipped,
            total: totalFiles,
            currentFile: path.relative(rootSrc!, srcPath),
          })
        }
      }
    }
  }

  await walk(src, dst)
  return { copied: acc.copied, skipped: acc.skipped }
}

async function countFiles(dir: string): Promise<number> {
  let count = 0
  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name))
      } else {
        count++
      }
    }
  }
  await walk(dir)
  return count
}

export async function updateShellProfile(targetPath: string): Promise<{ updated: boolean; file: string | null }> {
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

export async function removeShellProfile(): Promise<{ removed: boolean; file: string | null }> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const candidates: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [path.join(home, ".zshenv"), path.join(home, ".zshrc"), path.join(xdgConfig, "zsh", ".zshenv")],
    bash: [path.join(home, ".bashrc"), path.join(home, ".bash_profile"), path.join(home, ".profile")],
  }

  const files = candidates[shell] ?? candidates.bash

  for (const file of files) {
    const content = await Bun.file(file)
      .text()
      .catch(() => "")
    if (!content.includes("SYNERGY_HOME")) continue

    const lines = content.split("\n")
    const filtered: string[] = []
    let skip = false

    for (const line of lines) {
      const trimmed = line.trim()

      if (trimmed === "# synergy") {
        skip = true
        continue
      }

      if (skip) {
        skip = false
        if (trimmed.includes("SYNERGY_HOME")) continue
      }

      if (trimmed.includes("SYNERGY_HOME")) continue

      filtered.push(line)
    }

    while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
      filtered.pop()
    }

    await Bun.write(file, filtered.join("\n") + "\n")
    return { removed: true, file }
  }

  return { removed: false, file: null }
}

export function dataRoot(): string {
  return Global.Path.root
}
