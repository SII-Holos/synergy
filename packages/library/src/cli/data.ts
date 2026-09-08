import path from "node:path"
import { UI } from "@ericsanchezok/synergy-cli/util/ui"
async function dirExists(file: string) {
  return Bun.file(file).exists()
}
export async function getLibraryInfo(dbPath: string): Promise<{
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

export async function resolveLibraryDB(root: string): Promise<string> {
  const libraryPath = path.join(root, "data", "library.db")
  if (await dirExists(libraryPath)) return libraryPath
  return path.join(root, "data", "engram.db")
}

export interface LibraryMergeResult {
  memoriesMerged: number
  memoriesSkipped: number
  experiencesMerged: number
  experiencesSkipped: number
  vecDropped: boolean
}

export type LibraryConflictStrategy = "text_only" | "skip" | "replace_vectors"

/** Merge source library.db into target library.db. */
export async function mergeLibraryDB(
  sourceDbPath: string,
  targetDbPath: string,
  strategy: LibraryConflictStrategy,
): Promise<LibraryMergeResult> {
  const { Database } = await import("bun:sqlite")

  const result: LibraryMergeResult = {
    memoriesMerged: 0,
    memoriesSkipped: 0,
    experiencesMerged: 0,
    experiencesSkipped: 0,
    vecDropped: false,
  }

  const target = new Database(targetDbPath)
  target.exec("PRAGMA journal_mode=WAL")
  target.exec("PRAGMA busy_timeout=5000")

  // Targets created before the retrieval_count migration lack the column the
  // experience INSERT below references; add it idempotently so merging into
  // an older library.db keeps working.
  const experienceColumns = target.prepare("PRAGMA table_info(experience)").all() as { name: string }[]
  if (!experienceColumns.some((column) => column.name === "retrieval_count")) {
    target.exec("ALTER TABLE experience ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0")
  }

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
    retrieval_count?: number
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
    user_input?: string | null
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
    "INSERT OR IGNORE INTO experience (id, session_id, scope_id, intent, intent_embedding_model, script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits, retrieval_count, q_updated_at, q_history, retrieved_experience_ids, reward_status, turns_remaining, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
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
      // A pre-retrieval_count source has no pull evidence; mirror the
      // migration's approximation and seed from q_visits so imported rows
      // are not ranked as never-pulled.
      exp.retrieval_count ?? exp.q_visits,
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
    "INSERT OR IGNORE INTO experience_content (id, session_id, scope_id, user_input, script, raw, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
  for (const c of contents) {
    insertContent.run(
      c.id,
      c.session_id,
      c.scope_id,
      c.user_input ?? null,
      c.script,
      c.raw,
      c.metadata,
      c.created_at,
      c.updated_at,
    )
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
