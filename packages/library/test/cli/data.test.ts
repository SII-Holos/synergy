import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { getLibraryInfo, resolveLibraryDB, mergeLibraryDB } from "../../src/cli/data"
test("resolveLibraryDB prefers library.db over the legacy engram name", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "data", "engram.db"), "legacy")
    },
  })
  expect(await resolveLibraryDB(tmp.path)).toBe(path.join(tmp.path, "data", "engram.db"))
  await Bun.write(path.join(tmp.path, "data", "library.db"), "current")
  expect(await resolveLibraryDB(tmp.path)).toBe(path.join(tmp.path, "data", "library.db"))
})

test("getLibraryInfo reports missing databases without touching them", async () => {
  await using tmp = await tmpdir()
  expect(await getLibraryInfo(path.join(tmp.path, "missing.db"))).toEqual({
    exists: false,
    dimensions: null,
    embeddingModel: null,
    memoryCount: 0,
    experienceCount: 0,
  })
})

test("getLibraryInfo reads schema and counts from a real library database", async () => {
  await using tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "library.db")
  const { Database } = await import("bun:sqlite")
  const conn = new Database(dbPath, { create: true })
  conn.exec(`CREATE TABLE schema_version (embedding_dimensions INTEGER)`)
  conn.exec(
    `CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER)`,
  )
  conn.exec(
    `CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, retrieval_count INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER)`,
  )
  conn.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  conn.exec(
    `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', 'xenova', 1, 2), ('m2', 't2', 'c2', 'coding', 'always', 'xenova', 1, 2)`,
  )
  conn.close()

  const info = await getLibraryInfo(dbPath)
  expect(info).toMatchObject({
    exists: true,
    dimensions: 384,
    embeddingModel: "xenova",
    memoryCount: 2,
    experienceCount: 0,
  })
})

test("mergeLibraryDB merges text rows and drops vectors under text_only", async () => {
  await using tmp = await tmpdir()
  const { Database } = await import("bun:sqlite")
  const schema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, retrieval_count INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
  const sourcePath = path.join(tmp.path, "source.db")
  const targetPath = path.join(tmp.path, "target.db")
  const source = new Database(sourcePath, { create: true })
  source.exec(schema)
  source.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  source.exec(
    `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2)`,
  )
  source.exec(
    `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model, script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits, q_updated_at, q_history, retrieved_experience_ids, reward_status, turns_remaining, created_at, updated_at) VALUES ('e1', 's', 'sc', 'i', NULL, NULL, NULL, NULL, NULL, '{}', '{}', 0, NULL, '{}', '{}', 'pending', NULL, 1, 2)`,
  )
  source.close()
  const target = new Database(targetPath, { create: true })
  target.exec(schema)
  target.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  target.exec(
    `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2), ('m9', 'x', 'y', 'coding', 'always', NULL, 1, 2)`,
  )
  target.close()

  const result = await mergeLibraryDB(sourcePath, targetPath, "text_only")
  expect(result).toEqual({
    memoriesMerged: 0,
    memoriesSkipped: 1,
    experiencesMerged: 1,
    experiencesSkipped: 0,
    vecDropped: true,
  })

  const verify = new Database(targetPath, { readonly: true })
  expect((verify.prepare("SELECT COUNT(*) as c FROM memory").get() as { c: number }).c).toBe(2)
  expect((verify.prepare("SELECT COUNT(*) as c FROM experience").get() as { c: number }).c).toBe(1)
  verify.close()
})

test("mergeLibraryDB counts conflicts as skipped under the skip strategy", async () => {
  await using tmp = await tmpdir()
  const { Database } = await import("bun:sqlite")
  const schema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, retrieval_count INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
  const sourcePath = path.join(tmp.path, "source.db")
  const targetPath = path.join(tmp.path, "target.db")
  const source = new Database(sourcePath, { create: true })
  source.exec(schema)
  source.exec(
    `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2)`,
  )
  source.close()
  const target = new Database(targetPath, { create: true })
  target.exec(schema)
  target.exec(
    `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at) VALUES ('m1', 't', 'c', 'coding', 'always', NULL, 1, 2)`,
  )
  target.close()

  const result = await mergeLibraryDB(sourcePath, targetPath, "skip")
  expect(result.memoriesSkipped).toBe(1)
  expect(result.memoriesMerged).toBe(0)
  expect(result.vecDropped).toBe(false)
})

test("mergeLibraryDB merges into a pre-retrieval_count target by adding the column", async () => {
  await using tmp = await tmpdir()
  const { Database } = await import("bun:sqlite")
  const sourceSchema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, retrieval_count INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
  const legacyTargetSchema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
  const sourcePath = path.join(tmp.path, "source.db")
  const targetPath = path.join(tmp.path, "target.db")
  const source = new Database(sourcePath, { create: true })
  source.exec(sourceSchema)
  source.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  source.exec(
    `INSERT INTO experience (id, session_id, scope_id, intent, q_values, q_visits, retrieval_count, q_history, retrieved_experience_ids, reward_status, created_at, updated_at) VALUES ('e1', 's', 'sc', 'Handle the flow', '{}', 0, 5, '[]', '[]', 'pending', 1, 2)`,
  )
  source.close()
  const target = new Database(targetPath, { create: true })
  target.exec(legacyTargetSchema)
  target.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  target.close()

  const result = await mergeLibraryDB(sourcePath, targetPath, "text_only")
  expect(result.experiencesMerged).toBe(1)

  const verify = new Database(targetPath, { readonly: true })
  const columns = verify.prepare("PRAGMA table_info(experience)").all() as { name: string }[]
  expect(columns.some((column) => column.name === "retrieval_count")).toBe(true)
  const row = verify.prepare("SELECT retrieval_count FROM experience WHERE id = 'e1'").get() as {
    retrieval_count: number
  }
  expect(row.retrieval_count).toBe(5)
  verify.close()
})

test("mergeLibraryDB seeds retrieval_count from q_visits for a legacy source without the column", async () => {
  await using tmp = await tmpdir()
  const { Database } = await import("bun:sqlite")
  const legacySourceSchema = `
      CREATE TABLE schema_version (embedding_dimensions INTEGER);
      CREATE TABLE memory (id TEXT PRIMARY KEY, title TEXT, content TEXT, category TEXT, recall_mode TEXT, embedding_model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, intent TEXT, intent_embedding_model TEXT, script_embedding_model TEXT, source_provider_id TEXT, source_model_id TEXT, reward REAL, rewards TEXT, q_values TEXT, q_visits INTEGER, q_updated_at INTEGER, q_history TEXT, retrieved_experience_ids TEXT, reward_status TEXT, turns_remaining INTEGER, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE experience_content (id TEXT PRIMARY KEY, session_id TEXT, scope_id TEXT, user_input TEXT, script TEXT, raw TEXT, metadata TEXT, created_at INTEGER, updated_at INTEGER);
    `
  const targetSchema = legacySourceSchema.replace(
    "q_visits INTEGER, q_updated_at",
    "q_visits INTEGER, retrieval_count INTEGER, q_updated_at",
  )
  const sourcePath = path.join(tmp.path, "source.db")
  const targetPath = path.join(tmp.path, "target.db")
  const source = new Database(sourcePath, { create: true })
  source.exec(legacySourceSchema)
  source.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  source.exec(
    `INSERT INTO experience (id, session_id, scope_id, intent, q_values, q_visits, q_history, retrieved_experience_ids, reward_status, created_at, updated_at) VALUES ('e1', 's', 'sc', 'Handle the flow', '{}', 7, '[]', '[]', 'pending', 1, 2)`,
  )
  source.close()
  const target = new Database(targetPath, { create: true })
  target.exec(targetSchema)
  target.exec(`INSERT INTO schema_version (embedding_dimensions) VALUES (384)`)
  target.close()

  const result = await mergeLibraryDB(sourcePath, targetPath, "text_only")
  expect(result.experiencesMerged).toBe(1)

  const verify = new Database(targetPath, { readonly: true })
  const row = verify.prepare("SELECT retrieval_count FROM experience WHERE id = 'e1'").get() as {
    retrieval_count: number
  }
  // Legacy source has no pull evidence; mirror the migration's q_visits
  // approximation so imported rows are not ranked as never-pulled.
  expect(row.retrieval_count).toBe(7)
  verify.close()
})
