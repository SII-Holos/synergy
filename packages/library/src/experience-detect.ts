/**
 * Pure-DB experience candidate detection for re-encode.
 *
 * Runs entirely against library.db — no server, no LLM, no session messages
 * required. Uses the shared sanitize guards from intent.ts / script.ts to
 * apply the same heuristics at read time that the real encode path uses at
 * write time.
 */

import { Database } from "bun:sqlite"
import { INTENT_MAX_CHARS, INTENT_MIN_CHARS } from "./encoder-constants"
import { Intent } from "./intent"
import { Script } from "./script"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectionReason = "encoding_failed" | "empty" | "too-long" | "intent-in-raw" | "invalid" | "no-content"

export interface Candidate {
  id: string
  sessionID: string
  scopeID: string
  reason: DetectionReason
  detail: string
  intent?: string
  intentLen?: number
  script?: string
  /** True when `raw` contains `intent` as a substring (fallback detected). */
  intentInRaw?: boolean
}

export interface DetectionResult {
  dbPath: string
  intent: Candidate[]
  script: Candidate[]
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

function detectIntentCandidates(db: Database): Candidate[] {
  const candidates: Candidate[] = []

  // 1 — encoding_failed
  const failed = db
    .query(
      `SELECT id, session_id AS sessionID, scope_id AS scopeID
       FROM experience WHERE reward_status = 'encoding_failed'`,
    )
    .all() as Candidate[]
  for (const c of failed) {
    c.reason = "encoding_failed"
    c.detail = "whole encode pipeline failed"
  }
  candidates.push(...failed)

  // 2 — empty intent (non-failed)
  const empty = db
    .query(
      `SELECT id, session_id AS sessionID, scope_id AS scopeID, intent
       FROM experience
       WHERE reward_status != 'encoding_failed'
         AND (intent = '' OR intent IS NULL)`,
    )
    .all() as Candidate[]
  for (const c of empty) {
    c.reason = "empty"
    c.detail = "intent is empty"
  }
  candidates.push(...empty)

  // 3 — too long
  const tooLong = db
    .query(
      `SELECT id, session_id AS sessionID, scope_id AS scopeID, intent,
              length(intent) AS intentLen
       FROM experience
       WHERE reward_status != 'encoding_failed'
         AND length(intent) > ?`,
    )
    .all(INTENT_MAX_CHARS) as Candidate[]
  for (const c of tooLong) {
    c.reason = "too-long"
    c.detail = `intent is ${c.intentLen} chars (max ${INTENT_MAX_CHARS})`
  }
  candidates.push(...tooLong)

  // 4 — intent-in-raw: fallback to userText detected
  //    (intent text appears as a substring inside raw)
  const inRaw = db
    .query(
      `SELECT e.id, e.session_id AS sessionID, e.scope_id AS scopeID,
              e.intent, length(e.intent) AS intentLen, 1 AS intentInRaw
       FROM experience e
       JOIN experience_content ec ON e.id = ec.id
       WHERE e.reward_status != 'encoding_failed'
         AND length(e.intent) > ?
         AND instr(ec.raw, e.intent) > 0`,
    )
    .all(INTENT_MIN_CHARS) as Candidate[]
  for (const c of inRaw) {
    c.reason = "intent-in-raw"
    c.detail = `intent (${c.intentLen} chars) found inside raw — likely fallback to userText`
  }
  candidates.push(...inRaw)

  // De-duplicate by id (a single row may match multiple conditions)
  const seen = new Map<string, Candidate>()
  for (const c of candidates) {
    const existing = seen.get(c.id)
    if (!existing) {
      seen.set(c.id, c)
    } else {
      existing.detail += `; also ${c.reason}: ${c.detail}`
    }
  }

  // 5 — run local Intent.isValid on each candidate's intent
  const deduped = [...seen.values()]
  for (const c of deduped) {
    if (c.intent && !Intent.isValid(c.intent)) {
      if (c.reason === "intent-in-raw" || c.reason === "too-long" || c.reason === "empty") continue
      c.reason = "invalid"
      c.detail = `Intent.isValid returned false: ${c.intentLen ?? 0} chars`
    }
  }

  return deduped
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

function detectScriptCandidates(db: Database): Candidate[] {
  const candidates: Candidate[] = []

  // 1 — no content row at all (encoding_failed or never created)
  const noContent = db
    .query(
      `SELECT e.id, e.session_id AS sessionID, e.scope_id AS scopeID
       FROM experience e
       LEFT JOIN experience_content ec ON e.id = ec.id
       WHERE ec.id IS NULL`,
    )
    .all() as Candidate[]
  for (const c of noContent) {
    c.reason = "no-content"
    c.detail = "no experience_content row"
  }
  candidates.push(...noContent)

  // 2 — empty script (has content row but script is null/empty)
  const empty = db
    .query(
      `SELECT ec.id, ec.session_id AS sessionID, ec.scope_id AS scopeID
       FROM experience_content ec
       WHERE ec.script = '' OR ec.script IS NULL`,
    )
    .all() as Candidate[]
  for (const c of empty) {
    c.reason = "empty"
    c.detail = "script is empty"
  }
  candidates.push(...empty)

  // 3 — load script text for remaining rows and run Script.sanitizeWithReason
  const skipIDs = new Set(candidates.map((c) => c.id))
  const remaining = db
    .query(
      `SELECT ec.id, ec.session_id AS sessionID, ec.scope_id AS scopeID,
              ec.script
       FROM experience_content ec
       WHERE ec.script IS NOT NULL AND ec.script != ''`,
    )
    .all() as Candidate[]
  for (const c of remaining) {
    if (skipIDs.has(c.id)) continue
    const result = Script.sanitizeWithReason(c.script!, "")
    if (result.reason !== "ok") {
      c.reason = "invalid"
      c.detail = `Script.sanitizeWithReason reason=${result.reason}`
      candidates.push(c)
    }
  }

  return candidates
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function detect(dbPath: string): DetectionResult {
  const db = new Database(dbPath, { readonly: true })
  try {
    return {
      dbPath,
      intent: detectIntentCandidates(db),
      script: detectScriptCandidates(db),
    }
  } finally {
    db.close()
  }
}
