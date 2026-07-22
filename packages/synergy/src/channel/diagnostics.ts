import z from "zod"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { externalIdentityHash } from "./identity"
import { Log } from "@/util/log"

const log = Log.create({ service: "channel-diagnostics" })

export const MAX_RECORDS = 10_000
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_RECORD_BYTES = 256 * 1024

export const DiagnosticRecord = z.object({
  timestamp: z.number(),
  level: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})
export type DiagnosticRecord = z.infer<typeof DiagnosticRecord>

const DiagnosticRecordInput = z.object({
  level: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})
type DiagnosticRecordInput = z.infer<typeof DiagnosticRecordInput>

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{20,}\b/gi,
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd|auth)\s*[=:]\s*["'\w-]{8,}/gi,
  /\b(?:access[_-]?token|refresh[_-]?token)\s*[=:]\s*["'\w-]{8,}/gi,
]

const SENSITIVE_FIELD_PATTERNS = [
  /^(?:authorization|auth|x-api-key|x-api-secret|token|secret|password|passwd|cookie|set-cookie)$/i,
  /^(?:x-)?(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token)$/i,
]

function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((p) => p.test(key))
}

function containsRedacted(obj: unknown): boolean {
  if (typeof obj === "string") return obj === "[redacted]"
  if (typeof obj !== "object" || obj === null) return false
  if (Array.isArray(obj)) return obj.some(containsRedacted)
  return Object.values(obj as Record<string, unknown>).some(containsRedacted)
}

function redactSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replaceAll(pattern, "[redacted]")
  }
  return result
}

function redactObject(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(redactObject)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveFieldName(key)) {
      result[key] = "[redacted]"
    } else if (typeof value === "string") {
      result[key] = redactSecrets(value)
    } else if (value && typeof value === "object") {
      result[key] = redactObject(value)
    } else {
      result[key] = value
    }
  }
  return result
}

function normalizeRecord(input: DiagnosticRecordInput): DiagnosticRecord {
  const timestamp = Date.now()
  const message = redactSecrets(input.message)
  let data: Record<string, unknown> | undefined

  if (input.data) {
    data = {}
    for (const [key, value] of Object.entries(input.data)) {
      if (isSensitiveFieldName(key)) {
        data[key] = "[redacted]"
      } else if (typeof value === "string") {
        data[key] = redactSecrets(value)
      } else if (value && typeof value === "object") {
        data[key] = redactObject(value)
      } else {
        data[key] = value
      }
    }
    // Tag with redacted metadata if any nested value was redacted
    if (containsRedacted(data)) {
      data["redacted"] = true
    }
  }

  const record: DiagnosticRecord = { timestamp, level: input.level, message, data }
  const bytes = new TextEncoder().encode(JSON.stringify(record)).length
  if (bytes <= MAX_RECORD_BYTES) return record
  return truncateRecord(record)
}

function truncateRecord(record: DiagnosticRecord): DiagnosticRecord {
  const truncated = { ...record, data: record.data ? { ...record.data } : undefined }
  truncated.data = truncated.data ?? {}
  truncated.data["truncated"] = true

  // Find the largest string field and truncate it
  let maxKey = ""
  let maxLen = 0
  for (const [key, value] of Object.entries(truncated.data)) {
    if (typeof value === "string" && value.length > maxLen) {
      maxLen = value.length
      maxKey = key
    }
  }

  let serialized = JSON.stringify(truncated)
  let currentBytes = new TextEncoder().encode(serialized).length
  if (currentBytes <= MAX_RECORD_BYTES) return truncated

  if (maxKey && maxLen > 0) {
    let lo = 0
    let hi = maxLen
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const test = { ...truncated, data: { ...truncated.data } }
      test.data![maxKey] = (truncated.data![maxKey] as string).slice(0, mid) + "…[truncated]"
      serialized = JSON.stringify(test)
      currentBytes = new TextEncoder().encode(serialized).length
      if (currentBytes <= MAX_RECORD_BYTES) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    lo = Math.max(0, lo - 1)
    const finalData = { ...truncated.data }
    finalData[maxKey] = (truncated.data[maxKey] as string).slice(0, lo) + "…[truncated]"
    truncated.data = finalData
  }

  serialized = JSON.stringify(truncated)
  currentBytes = new TextEncoder().encode(serialized).length
  if (currentBytes > MAX_RECORD_BYTES && record.message.length > 100) {
    let lo = 0
    let hi = record.message.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const test = { ...truncated, message: record.message.slice(0, mid) + "…[truncated]" }
      serialized = JSON.stringify(test)
      currentBytes = new TextEncoder().encode(serialized).length
      if (currentBytes <= MAX_RECORD_BYTES) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    lo = Math.max(0, lo - 1)
    truncated.message = record.message.slice(0, lo) + "…[truncated]"
  }

  return truncated
}

function accountHash(channelType: string, accountId: string): string {
  return externalIdentityHash(channelType, accountId)
}

function pruneByAge(records: DiagnosticRecord[], now: number): DiagnosticRecord[] {
  const cutoff = now - RETENTION_MS
  return records.filter((r) => r.timestamp >= cutoff)
}

function pruneByCount(records: DiagnosticRecord[]): DiagnosticRecord[] {
  if (records.length <= MAX_RECORDS) return records
  return records.slice(records.length - MAX_RECORDS)
}

export async function recording(channelType: string, accountId: string, input: DiagnosticRecordInput): Promise<void> {
  const hash = accountHash(channelType, accountId)
  const key = StoragePath.channelDiagnosticsAccount(hash)
  const normalized = normalizeRecord(input)
  const now = normalized.timestamp

  try {
    let existing: DiagnosticRecord[] = []
    try {
      existing = await Storage.read<DiagnosticRecord[]>(key)
    } catch {
      // No existing records — start fresh
    }

    existing = pruneByAge(existing, now)
    existing.push(normalized)
    existing = pruneByCount(existing)

    await Storage.write(key, existing)
  } catch (err) {
    log.error("failed to persist diagnostic record", { error: err })
  }
}

export async function list(channelType: string, accountId: string): Promise<DiagnosticRecord[]> {
  const hash = accountHash(channelType, accountId)
  const key = StoragePath.channelDiagnosticsAccount(hash)

  try {
    const records = await Storage.read<DiagnosticRecord[]>(key)
    return pruneByAge(records, Date.now())
  } catch {
    return []
  }
}

export async function hasData(channelType: string, accountId: string): Promise<boolean> {
  const hash = accountHash(channelType, accountId)
  const key = StoragePath.channelDiagnosticsAccount(hash)
  try {
    await Storage.read(key)
    return true
  } catch {
    return false
  }
}
