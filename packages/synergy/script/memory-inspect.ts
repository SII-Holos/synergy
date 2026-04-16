#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import path from "path"
import os from "os"

const dataDir = path.join(os.homedir(), ".synergy", "data")
const dbPath = path.join(dataDir, "engram.db")

console.log(`\n📂 Database path: ${dbPath}`)

const file = Bun.file(dbPath)
if (!(await file.exists())) {
  console.log("❌ engram.db does not exist yet. Run a conversation first.\n")
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })

// Detect which tables exist
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
const tableNames = new Set(tables.map((t) => t.name))

console.log(`📋 Tables: ${[...tableNames].join(", ") || "(none)"}\n`)

// ── experience + experience_content ─────────────────────────────────────────

if (tableNames.has("experience")) {
  const expCount = db.prepare("SELECT COUNT(*) as cnt FROM experience").get() as { cnt: number }
  const contentCount = tableNames.has("experience_content")
    ? (db.prepare("SELECT COUNT(*) as cnt FROM experience_content").get() as { cnt: number }).cnt
    : 0
  const withEmbed = db.prepare("SELECT COUNT(*) as cnt FROM experience WHERE embedding IS NOT NULL").get() as {
    cnt: number
  }

  console.log(`💬 Experiences: ${expCount.cnt} total, ${contentCount} contents`)
  console.log(`   With embedding: ${withEmbed.cnt}  |  Without: ${expCount.cnt - withEmbed.cnt}`)
  console.log()

  const expCols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('experience')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )

  const rewardSelect = expCols.has("reward") ? "e.reward," : "NULL as reward,"
  const qSelect = expCols.has("q_value")
    ? "e.q_value, e.q_visits, e.q_updated_at,"
    : "NULL as q_value, NULL as q_visits, NULL as q_updated_at,"
  const retrievedCol = expCols.has("retrieved_experience_ids")
    ? "e.retrieved_experience_ids"
    : "NULL as retrieved_experience_ids"

  const rows = db
    .prepare(
      `SELECT e.id, e.session_id, e.scope_id, e.intent, ${rewardSelect}
              ${qSelect}
              ${retrievedCol},
              CASE WHEN e.embedding IS NOT NULL THEN LENGTH(e.embedding) / 4 ELSE 0 END as embedding_dims,
              e.embedding_model, e.created_at,
              c.script, c.reflect, c.raw
       FROM experience e
       LEFT JOIN experience_content c ON c.id = e.id
       ORDER BY e.created_at DESC LIMIT 10`,
    )
    .all() as Array<{
    id: string
    session_id: string
    scope_id: string
    intent: string
    reward: number | null
    q_value: number | null
    q_visits: number | null
    q_updated_at: string | null
    retrieved_experience_ids: string | null
    embedding_dims: number
    embedding_model: string | null
    created_at: number
    script: string | null
    reflect: string | null
    raw: string | null
  }>

  console.log("─".repeat(80))
  for (const row of rows) {
    const created = new Date(row.created_at).toLocaleString()
    const hasEmbed = row.embedding_dims > 0
    const hasContent = row.script || row.reflect || row.raw
    console.log(`  💬 ${row.id}`)
    console.log(`  Intent:    ${row.intent || "(empty)"}`)
    console.log(`  Session:   ${row.session_id}`)
    console.log(`  Scope:     ${row.scope_id}`)
    if (row.script) console.log(`  Script:    ${row.script.length} chars`)
    if (row.reflect) console.log(`  Reflect:   ${row.reflect.length} chars`)
    if (row.raw) console.log(`  Raw:       ${row.raw.length} chars`)
    if (!hasContent) console.log(`  Content:   ❌ missing`)
    console.log(`  Embedding: ${hasEmbed ? `✅ ${row.embedding_dims} dims (${row.embedding_model})` : "❌ none"}`)
    console.log(`  Reward:    ${row.reward != null ? row.reward.toFixed(2) : "—"}`)
    if (row.q_value != null) {
      console.log(
        `  Q-value:   ${row.q_value.toFixed(4)} (visits: ${row.q_visits ?? 0}, last: ${row.q_updated_at ?? "never"})`,
      )
    }
    const retrievedIds: string[] = row.retrieved_experience_ids ? JSON.parse(row.retrieved_experience_ids) : []
    console.log(`  Retrieved: ${retrievedIds.length > 0 ? retrievedIds.join(", ") : "—"}`)
    console.log(`  Created:   ${created}`)
    console.log("─".repeat(80))
  }
} else {
  console.log("💬 Experiences: no experience table found")
}

console.log()

// ── memory (long-term notes) ────────────────────────────────────────────────

if (tableNames.has("memory")) {
  const memCount = db.prepare("SELECT COUNT(*) as cnt FROM memory").get() as { cnt: number }
  const withEmbed = db.prepare("SELECT COUNT(*) as cnt FROM memory WHERE embedding IS NOT NULL").get() as {
    cnt: number
  }

  console.log(`🧠 Memories: ${memCount.cnt} total`)
  console.log(`   With embedding: ${withEmbed.cnt}  |  Without: ${memCount.cnt - withEmbed.cnt}`)
  console.log()

  const rows = db
    .prepare(
      `SELECT id, title, content,
              CASE WHEN embedding IS NOT NULL THEN LENGTH(embedding) / 4 ELSE 0 END as embedding_dims,
              embedding_model, created_at, updated_at
       FROM memory ORDER BY created_at DESC LIMIT 10`,
    )
    .all() as Array<{
    id: string
    title: string
    content: string
    embedding_dims: number
    embedding_model: string | null
    created_at: number
    updated_at: number
  }>

  if (rows.length > 0) {
    console.log("─".repeat(80))
    for (const row of rows) {
      const created = new Date(row.created_at).toLocaleString()
      const updated = new Date(row.updated_at).toLocaleString()
      const hasEmbed = row.embedding_dims > 0
      const contentPreview = row.content.length > 100 ? row.content.slice(0, 100) + "..." : row.content
      console.log(`  🧠 ${row.id}`)
      console.log(`  Title:     ${row.title}`)
      console.log(`  Content:   ${contentPreview}`)
      console.log(`  Embedding: ${hasEmbed ? `✅ ${row.embedding_dims} dims (${row.embedding_model})` : "❌ none"}`)
      console.log(`  Created:   ${created}`)
      if (row.updated_at !== row.created_at) {
        console.log(`  Updated:   ${updated}`)
      }
      console.log("─".repeat(80))
    }
  }
} else {
  console.log("🧠 Memories: no memory table found")
}

console.log()
db.close()
