#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import * as sqliteVec from "sqlite-vec"
import { embed } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { parse as parseJsonc } from "jsonc-parser"
import path from "path"
import os from "os"

interface MemoryRow {
  id: string
  title: string
  content: string
  category: string
  embedding_model: string | null
}

interface Args {
  apply: boolean
  dbPath: string
  configPath: string
  limit?: number
}

interface EmbeddingConfig {
  baseURL?: string
  apiKey?: string
  model?: string
}

interface GeneratedEmbedding {
  id: string
  vector: number[]
  model: string
}

const DEFAULT_DB_PATH = path.join(os.homedir(), ".synergy", "data", "library.db")
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".synergy", "config", "synergy.jsonc")
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
const DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B"
const TIMEOUT_MS = 10_000

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let apply = false
  let dbPath = DEFAULT_DB_PATH
  let configPath = DEFAULT_CONFIG_PATH
  let limit: number | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--apply") {
      apply = true
      continue
    }
    if (arg === "--db") {
      const value = args[++i]
      if (!value) throw new Error("--db requires a path")
      dbPath = path.resolve(value)
      continue
    }
    if (arg === "--config") {
      const value = args[++i]
      if (!value) throw new Error("--config requires a path")
      configPath = path.resolve(value.replace(/^~(?=\/)/, os.homedir()))
      continue
    }
    if (arg === "--limit") {
      const value = args[++i]
      if (!value) throw new Error("--limit requires a number")
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer")
      limit = parsed
      continue
    }
    if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (apply && limit !== undefined) {
    throw new Error(
      "--limit is only allowed in dry-run mode; partial --apply would drop vec_memory and repopulate only part of it",
    )
  }

  return { apply, dbPath, configPath, limit }
}

function printHelp() {
  console.log(`Repair library memory vectors.

Usage:
  bun script/library-repair-memory-vectors.ts [--apply] [--db PATH] [--config PATH] [--limit N]

Default mode is dry-run: it prints current DB health and exits without network calls or DB writes.
Use --apply only after Synergy is stopped and library.db, library.db-wal, and library.db-shm are backed up.
`)
}

function loadSqliteVec(db: Database) {
  sqliteVec.load(db)
}

function tableSQL(db: Database, tableName: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1").get(tableName) as {
    sql: string | null
  } | null
  return row?.sql ?? null
}

function tableDimensions(db: Database, tableName: string): number | null {
  const sql = tableSQL(db, tableName)
  if (!sql) return null
  const dimensions = [...sql.matchAll(/\bfloat\s*\[\s*(\d+)\s*\]/gi)].map((match) => Number(match[1]))
  if (dimensions.length === 0) return null
  const unique = new Set(dimensions)
  return unique.size === 1 ? dimensions[0] : null
}

function countTable(db: Database, tableName: string): number | null {
  if (!tableSQL(db, tableName)) return null
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }
    return row.count
  } catch {
    return null
  }
}

function memoryRows(db: Database, limit?: number): MemoryRow[] {
  const suffix = limit ? " LIMIT ?1" : ""
  const sql = `SELECT id, title, content, category, embedding_model FROM memory ORDER BY created_at ASC${suffix}`
  return limit ? (db.prepare(sql).all(limit) as MemoryRow[]) : (db.prepare(sql).all() as MemoryRow[])
}

function missingMemoryVectorCount(db: Database): number | null {
  if (!tableSQL(db, "vec_memory")) return null
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM memory m
         LEFT JOIN vec_memory v ON v.memory_id = m.id
         WHERE v.memory_id IS NULL`,
      )
      .get() as { count: number }
    return row.count
  } catch {
    return null
  }
}

function printHealth(db: Database) {
  const schema = db.prepare("SELECT version, embedding_dimensions FROM schema_version LIMIT 1").get() as {
    version: number
    embedding_dimensions: number | null
  } | null
  const memoryCount = countTable(db, "memory") ?? 0
  const vecMemoryCount = countTable(db, "vec_memory")
  const missing = missingMemoryVectorCount(db)

  console.log("\nLibrary memory vector health")
  console.log("─".repeat(80))
  console.log(`schema_version: ${schema ? JSON.stringify(schema) : "missing"}`)
  console.log(`vec_memory dimensions: ${tableDimensions(db, "vec_memory") ?? "missing/unknown"}`)
  console.log(`memory rows: ${memoryCount}`)
  console.log(`vec_memory rows: ${vecMemoryCount ?? "missing/unreadable"}`)
  console.log(`missing memory vectors: ${missing ?? "unknown"}`)
  console.log("─".repeat(80))
}

function createVecMemory(db: Database, dimensions: number) {
  db.exec("DROP TABLE IF EXISTS vec_memory")
  db.exec(`
    CREATE VIRTUAL TABLE vec_memory USING vec0(
      memory_id TEXT PRIMARY KEY,
      category TEXT,
      embedding float[${dimensions}] distance_metric=cosine
    )
  `)
}

function toFloat32(vector: number[]): Float32Array {
  return new Float32Array(vector)
}

async function loadEmbeddingConfig(configPath: string): Promise<Required<EmbeddingConfig>> {
  let text = await Bun.file(configPath).text()
  const configDir = path.dirname(configPath)

  text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] ?? "")
  const fileMatches = text.match(/\{file:[^}]+\}/g)
  if (fileMatches) {
    for (const match of fileMatches) {
      let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
      if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2))
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
      const fileContent = await Bun.file(resolved).text()
      text = text.replace(match, JSON.stringify(fileContent.trim()).slice(1, -1))
    }
  }

  const parsed = parseJsonc(text) as { identity?: { embedding?: EmbeddingConfig } }
  const embedding = parsed.identity?.embedding ?? {}
  const baseURL = embedding.baseURL ?? DEFAULT_BASE_URL
  const apiKey = embedding.apiKey ?? ""
  const model = embedding.model ?? DEFAULT_MODEL
  if (!apiKey) throw new Error(`Embedding API key is missing in ${configPath}`)
  return { baseURL, apiKey, model }
}

function createEmbeddingGenerator(config: Required<EmbeddingConfig>) {
  const provider = createOpenAICompatible({
    name: "embedding-repair",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  })
  const model = provider.textEmbeddingModel(config.model)

  return async (input: { id: string; text: string }): Promise<GeneratedEmbedding> => {
    const { embedding } = await embed({
      model,
      value: input.text,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { id: input.id, vector: embedding, model: config.model }
  }
}

async function main() {
  const args = parseArgs()
  const file = Bun.file(args.dbPath)
  if (!(await file.exists())) throw new Error(`Database not found: ${args.dbPath}`)

  const db = args.apply ? new Database(args.dbPath, { readwrite: true }) : new Database(args.dbPath, { readonly: true })
  loadSqliteVec(db)

  console.log(`Database: ${args.dbPath}`)
  console.log(`Mode: ${args.apply ? "APPLY" : "dry-run"}`)
  printHealth(db)

  const rows = memoryRows(db, args.limit)
  console.log(`Memories selected for ${args.apply ? "repair" : "repair plan"}: ${rows.length}`)

  if (!args.apply) {
    console.log(
      "\nDry-run only. Re-run with --apply after stopping Synergy and backing up library.db, library.db-wal, and library.db-shm.",
    )
    db.close()
    return
  }

  const embeddingConfig = await loadEmbeddingConfig(args.configPath)
  const generateEmbedding = createEmbeddingGenerator(embeddingConfig)
  console.log(`Embedding config: ${embeddingConfig.model} @ ${embeddingConfig.baseURL}`)

  const generated: Array<{ row: MemoryRow; embedding: GeneratedEmbedding }> = []
  let dimensions: number | undefined
  for (const row of rows) {
    const embedding = await generateEmbedding({ id: row.id, text: `${row.title}\n${row.content}` })
    dimensions ??= embedding.vector.length
    if (embedding.vector.length !== dimensions) {
      throw new Error(
        `Embedding dimension changed during repair for ${row.id}: ${embedding.vector.length} != ${dimensions}`,
      )
    }
    generated.push({ row, embedding })
    if (generated.length % 10 === 0) console.log(`Generated ${generated.length}/${rows.length}`)
  }

  if (dimensions === undefined) throw new Error("No memory rows selected for repair")
  const experienceDimensions = tableDimensions(db, "vec_experience")
  if (experienceDimensions !== null && experienceDimensions !== dimensions) {
    throw new Error(
      `Refusing to repair only memory: vec_experience is ${experienceDimensions}d but memory embeddings are ${dimensions}d`,
    )
  }

  createVecMemory(db, dimensions)
  const insert = db.prepare("INSERT INTO vec_memory (memory_id, category, embedding) VALUES (?1, ?2, ?3)")
  const updateModel = db.prepare("UPDATE memory SET embedding_model = ?1 WHERE id = ?2")

  for (const { row, embedding } of generated) {
    insert.run(row.id, row.category, toFloat32(embedding.vector))
    if (row.embedding_model !== embedding.model) updateModel.run(embedding.model, row.id)
  }

  db.prepare("UPDATE schema_version SET embedding_dimensions = ?1").run(dimensions)
  printHealth(db)
  console.log(`\nRepair complete. Repaired vectors: ${generated.length}`)
  db.close()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
