import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { PerformanceWriter } from "@/performance/writer"

export namespace Observability {
  const TRACE_DIR = path.join(Global.Path.state, "observability", "traces")
  const DEFAULT_RETENTION_DAYS = 7
  const DEFAULT_MAX_BYTES = 250 * 1024 * 1024
  const MAX_STRING_LENGTH = 4096
  const MAX_OBJECT_KEYS = 48
  const MAX_ARRAY_LENGTH = 32
  const CLEANUP_INTERVAL_MS = 60_000
  let lastCleanupAt = 0
  const SENSITIVE_KEYS = new Set([
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "set-cookie",
    "apikey",
    "api_key",
    "accesstoken",
    "refreshtoken",
    "agentsecret",
  ])

  export interface Event {
    time: number
    iso: string
    type: string
    traceId?: string
    sessionID?: string
    messageID?: string
    callID?: string
    tool?: string
    processId?: string
    pid?: number
    cwd?: string
    scopeID?: string
    rid?: string
    level?: "debug" | "info" | "warn" | "error"
    data?: Record<string, unknown>
  }

  export interface Query {
    traceId?: string
    sessionID?: string
    callID?: string
    since?: number
    limit?: number
    level?: Event["level"]
  }

  export function traceId(prefix = "trc") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  }

  export function dir() {
    return TRACE_DIR
  }

  export function fileForDate(date = new Date()) {
    return path.join(TRACE_DIR, `${date.toISOString().slice(0, 10)}.jsonl`)
  }

  export async function emit(type: string, input: Omit<Event, "type" | "time" | "iso"> = {}) {
    const event: Event = {
      ...input,
      type,
      time: Date.now(),
      iso: new Date().toISOString(),
      data: input.data ? sanitizeRecord(input.data) : undefined,
    }
    PerformanceWriter.append(fileForDate(), JSON.stringify(event) + "\n")
    scheduleCleanup()
    return event
  }

  export async function flush() {
    await PerformanceWriter.flush()
  }
  export async function listFiles() {
    await flush()
    const entries = await fs.readdir(TRACE_DIR).catch((): string[] => [])
    return entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .map((name) => path.join(TRACE_DIR, name))
  }

  export async function query(input: Query = {}) {
    await flush()
    const limit = Math.max(1, Math.min(input.limit ?? 500, 5000))
    const files = (await listFiles()).reverse()
    const result: Event[] = []
    for (const file of files) {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      if (!text) continue
      const lines = text.split(/\r?\n/).filter(Boolean).reverse()
      for (const line of lines) {
        const event = parseLine(line)
        if (!event) continue
        if (input.since && event.time < input.since) continue
        if (input.traceId && event.traceId !== input.traceId) continue
        if (input.sessionID && event.sessionID !== input.sessionID) continue
        if (input.callID && event.callID !== input.callID) continue
        if (input.level && event.level !== input.level) continue
        result.push(event)
        if (result.length >= limit) return result
      }
    }
    return result
  }

  export async function cleanup(opts?: { retentionDays?: number; maxBytes?: number }) {
    await flush()
    const retentionDays = opts?.retentionDays ?? DEFAULT_RETENTION_DAYS
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
    const files = await listFiles()
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const stats = await Promise.all(
      files.map(async (file) => ({
        file,
        stat: await fs.stat(file).catch(() => undefined),
      })),
    )
    for (const item of stats) {
      if (item.stat && item.stat.mtimeMs < cutoff) {
        await fs.rm(item.file, { force: true }).catch(() => {})
      }
    }
    const remaining = stats
      .filter((item) => item.stat && item.stat.mtimeMs >= cutoff)
      .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    let total = 0
    for (const item of remaining) {
      total += item.stat?.size ?? 0
      if (total > maxBytes) {
        await fs.rm(item.file, { force: true }).catch(() => {})
      }
    }
  }

  function scheduleCleanup() {
    const now = Date.now()
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
    lastCleanupAt = now
    cleanup().catch(() => {})
  }

  export function sanitizeRecord(input: Record<string, unknown>): Record<string, unknown> {
    return sanitizeValue(input, 0, new Set()) as Record<string, unknown>
  }

  export function sanitizeText(text: string) {
    return text
      .replace(/(?<=(token|secret|password|authorization|api[_-]?key|cookie)=)[^\s"'&]+/gi, "[redacted]")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
  }

  function parseLine(line: string): Event | undefined {
    try {
      return JSON.parse(line) as Event
    } catch {
      return undefined
    }
  }

  function isSensitiveKey(key: string) {
    return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""))
  }

  function sanitizeValue(value: unknown, depth: number, seen: Set<object>): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === "string") {
      const clean = sanitizeText(value)
      return clean.length > MAX_STRING_LENGTH
        ? `${clean.slice(0, MAX_STRING_LENGTH)}...(truncated ${clean.length - MAX_STRING_LENGTH} chars)`
        : clean
    }
    if (typeof value === "number" || typeof value === "boolean") return value
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "symbol") return value.toString()
    if (typeof value === "function") return "[Function]"
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitizeText(value.message),
        stack: value.stack ? sanitizeText(value.stack).slice(0, MAX_STRING_LENGTH) : undefined,
      }
    }
    if (typeof value !== "object") return String(value)
    if (depth >= 6) return "[depth limit]"
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1, seen))
      if (value.length > MAX_ARRAY_LENGTH) items.push(`...(${value.length - MAX_ARRAY_LENGTH} more)`)
      return items
    }
    const entries = Object.entries(value as Record<string, unknown>)
    const result: Record<string, unknown> = {}
    for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) {
      result[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(val, depth + 1, seen)
    }
    if (entries.length > MAX_OBJECT_KEYS) result["..."] = `${entries.length - MAX_OBJECT_KEYS} more keys`
    return result
  }
}
