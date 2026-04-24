import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import os from "os"
import { UI } from "../../ui"
import { Global } from "../../../global"

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
    label: "Core data (sessions, notes, agenda, engram, auth, holos)",
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
): Promise<{ copied: number; skipped: number }> {
  let copied = 0
  let skipped = 0

  if (!rootSrc) {
    rootSrc = src
  }
  // Skip expensive file count if caller doesn't need progress
  if (onProgress && !totalFiles) {
    totalFiles = await countFiles(src)
  }

  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)

    if (entry.isDirectory()) {
      const result = await copyDirSkipExisting(srcPath, dstPath, onProgress, rootSrc, totalFiles)
      copied += result.copied
      skipped += result.skipped
    } else if (entry.isFile()) {
      const exists = await fs
        .access(dstPath)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        skipped++
      } else {
        await fs.copyFile(srcPath, dstPath)
        copied++
      }
      if (onProgress && totalFiles) {
        onProgress({
          copied,
          skipped,
          total: totalFiles,
          currentFile: path.relative(rootSrc, srcPath),
        })
      }
    } else if (entry.isSymbolicLink()) {
      const exists = await fs
        .access(dstPath)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        skipped++
      } else {
        const linkTarget = await fs.readlink(srcPath)
        await fs.symlink(linkTarget, dstPath).catch(() => {})
        copied++
      }
      if (onProgress && totalFiles) {
        onProgress({
          copied,
          skipped,
          total: totalFiles,
          currentFile: path.relative(rootSrc, srcPath),
        })
      }
    }
  }

  return { copied, skipped }
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

export async function getEngramInfo(dbPath: string): Promise<{
  exists: boolean
  dimensions: number | null
  embeddingModel: string | null
  memoryCount: number
  experienceCount: number
}> {
  const exists = await Bun.file(dbPath)
    .exists()
    .catch(() => false)
  if (!exists) {
    return { exists: false, dimensions: null, embeddingModel: null, memoryCount: 0, experienceCount: 0 }
  }

  try {
    const { Database } = await import("bun:sqlite")
    const conn = new Database(dbPath, { readonly: true })

    const schemaRow = conn.prepare("SELECT embedding_dimensions FROM schema_version LIMIT 1").get() as {
      embedding_dimensions: number | null
    } | null

    const dimensions = schemaRow?.embedding_dimensions ?? null

    const memCount = (conn.prepare("SELECT COUNT(*) as c FROM memory").get() as { c: number }).c
    const expCount = (conn.prepare("SELECT COUNT(*) as c FROM experience").get() as { c: number }).c

    const memRow = conn
      .prepare("SELECT embedding_model FROM memory WHERE embedding_model IS NOT NULL LIMIT 1")
      .get() as { embedding_model: string } | null

    conn.close()

    return {
      exists: true,
      dimensions,
      embeddingModel: memRow?.embedding_model ?? null,
      memoryCount: memCount,
      experienceCount: expCount,
    }
  } catch {
    return { exists: true, dimensions: null, embeddingModel: null, memoryCount: 0, experienceCount: 0 }
  }
}

export interface EngramMergeResult {
  memoriesMerged: number
  memoriesSkipped: number
  experiencesMerged: number
  experiencesSkipped: number
  vecDropped: boolean
}

export type EngramConflictStrategy = "text_only" | "skip" | "replace_vectors"

/** Merge source engram.db into target engram.db. */
export async function mergeEngramDB(
  sourceDbPath: string,
  targetDbPath: string,
  strategy: EngramConflictStrategy,
): Promise<EngramMergeResult> {
  const { Database } = await import("bun:sqlite")

  const result: EngramMergeResult = {
    memoriesMerged: 0,
    memoriesSkipped: 0,
    experiencesMerged: 0,
    experiencesSkipped: 0,
    vecDropped: false,
  }

  const target = new Database(targetDbPath)
  target.exec("PRAGMA journal_mode=WAL")
  target.exec("PRAGMA busy_timeout=5000")

  const source = new Database(sourceDbPath, { readonly: true })

  type MemoryRow = {
    id: string
    title: string
    content: string
    category: string
    recall_mode: string
    embedding_model: string | null
    created_at: number
    updated_at: number
  }

  type ExperienceRow = {
    id: string
    session_id: string
    scope_id: string
    intent: string
    intent_embedding_model: string | null
    script_embedding_model: string | null
    source_provider_id: string | null
    source_model_id: string | null
    reward: number | null
    rewards: string
    q_values: string
    q_visits: number
    q_updated_at: number | null
    q_history: string
    retrieved_experience_ids: string
    reward_status: string
    turns_remaining: number | null
    created_at: number
    updated_at: number
  }

  type ContentRow = {
    id: string
    session_id: string
    scope_id: string
    script: string | null
    raw: string | null
    metadata: string
    created_at: number
    updated_at: number
  }

  // Merge memories
  const memories = source.prepare("SELECT * FROM memory").all() as MemoryRow[]
  const insertMemory = target.prepare(
    "INSERT OR IGNORE INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )

  for (const mem of memories) {
    const changes = target.prepare("SELECT changes() as c").get() as { c: number }
    insertMemory.run(
      mem.id,
      mem.title,
      mem.content,
      mem.category,
      mem.recall_mode,
      mem.embedding_model,
      mem.created_at,
      mem.updated_at,
    )
    const after = target.prepare("SELECT changes() as c").get() as { c: number }
    if (after.c > changes.c) {
      result.memoriesMerged++
    } else {
      result.memoriesSkipped++
    }
  }

  // Merge experiences
  const experiences = source.prepare("SELECT * FROM experience").all() as ExperienceRow[]
  const insertExperience = target.prepare(
    "INSERT OR IGNORE INTO experience (id, session_id, scope_id, intent, intent_embedding_model, script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits, q_updated_at, q_history, retrieved_experience_ids, reward_status, turns_remaining, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
  )

  for (const exp of experiences) {
    const changes = target.prepare("SELECT changes() as c").get() as { c: number }
    insertExperience.run(
      exp.id,
      exp.session_id,
      exp.scope_id,
      exp.intent,
      exp.intent_embedding_model,
      exp.script_embedding_model,
      exp.source_provider_id,
      exp.source_model_id,
      exp.reward,
      exp.rewards,
      exp.q_values,
      exp.q_visits,
      exp.q_updated_at,
      exp.q_history,
      exp.retrieved_experience_ids,
      exp.reward_status,
      exp.turns_remaining,
      exp.created_at,
      exp.updated_at,
    )
    const after = target.prepare("SELECT changes() as c").get() as { c: number }
    if (after.c > changes.c) {
      result.experiencesMerged++
    } else {
      result.experiencesSkipped++
    }
  }

  // Merge experience_content
  const contents = source.prepare("SELECT * FROM experience_content").all() as ContentRow[]
  const insertContent = target.prepare(
    "INSERT OR IGNORE INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
  for (const c of contents) {
    insertContent.run(c.id, c.session_id, c.scope_id, c.script, c.raw, c.metadata, c.created_at, c.updated_at)
  }

  // Handle vector tables based on strategy
  if (strategy === "text_only") {
    // Skip vector merge entirely — text data already merged above
    result.vecDropped = true
  } else if (strategy === "replace_vectors") {
    // Drop target vec tables and recreate from source
    const sourceSchema = source.prepare("SELECT embedding_dimensions FROM schema_version LIMIT 1").get() as {
      embedding_dimensions: number | null
    } | null

    const dimensions = sourceSchema?.embedding_dimensions
    if (dimensions) {
      target.exec("DROP TABLE IF EXISTS vec_experience")
      target.exec("DROP TABLE IF EXISTS vec_memory")

      target.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_experience USING vec0(
          experience_id TEXT PRIMARY KEY,
          scope_id TEXT partition key,
          reward_status TEXT,
          intent_embedding float[${dimensions}] distance_metric=cosine,
          script_embedding float[${dimensions}] distance_metric=cosine
        )
      `)
      target.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
          memory_id TEXT PRIMARY KEY,
          category TEXT,
          embedding float[${dimensions}] distance_metric=cosine
        )
      `)

      target.prepare("UPDATE schema_version SET embedding_dimensions = ?1").run(dimensions)
      result.vecDropped = true
    }
  }
  // strategy === "skip" → do nothing with vec tables

  source.close()
  target.close()

  return result
}

export function dataRoot(): string {
  return Global.Path.root
}
