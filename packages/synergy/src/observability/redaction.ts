import { ObservabilityConfig } from "@/observability/config"
import { ObservabilitySchema } from "./schema"

export namespace ObservabilityRedaction {
  const MAX_OBJECT_KEYS = 48
  const MAX_ARRAY_LENGTH = 32
  const MAX_DEPTH = 6
  const DEFAULT_MAX_STRING_LENGTH = 4096
  const COMMAND_KEYS = new Set(["command", "cmd"])
  const COMMAND_ARG_KEYS = new Set(["args", "argv", "arguments"])
  const STANDALONE_SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9._-]{8,}\b/g,
    /\bghp_[A-Za-z0-9_]{8,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
    /\bhf_[A-Za-z0-9_]{8,}\b/g,
    /\bglpat-[A-Za-z0-9-]{8,}\b/g,
    /\bpk_live_[A-Za-z0-9_]{8,}\b/g,
    /\brk_live_[A-Za-z0-9_]{8,}\b/g,
    /\btok_[A-Za-z0-9._-]{8,}\b/g,
    /\bkey_[A-Za-z0-9._-]{8,}\b/g,
  ]

  export interface Result<T> {
    value: T
    summary: ObservabilitySchema.RedactionSummary
  }

  interface State {
    omittedKeys: number
    truncatedValues: number
    changed: boolean
  }

  export function record(
    input: Record<string, unknown> | undefined,
    maxLength = ObservabilityConfig.current().maxAttributeStringLength,
  ): Record<string, ObservabilitySchema.LabelValue> {
    return redactRecord(input, maxLength).value
  }

  export function redactRecord(
    input: Record<string, unknown> | undefined,
    maxLength = ObservabilityConfig.current().maxAttributeStringLength,
  ): Result<Record<string, ObservabilitySchema.LabelValue>> {
    if (!input) return { value: {}, summary: summary({ omittedKeys: 0, truncatedValues: 0, changed: false }) }
    const state: State = { omittedKeys: 0, truncatedValues: 0, changed: false }
    const value = flattenRecord(sanitize(input, 0, new Set(), maxLength, state), maxLength, state)
    return { value, summary: summary(state) }
  }

  export function value(
    input: unknown,
    maxLength = ObservabilityConfig.current().maxAttributeStringLength,
  ): Result<unknown> {
    const state: State = { omittedKeys: 0, truncatedValues: 0, changed: false }
    const clean = sanitize(input, 0, new Set(), maxLength, state)
    return { value: clean, summary: summary(state) }
  }

  export function text(input: string, maxLength = ObservabilityConfig.current().maxAttributeStringLength) {
    let clean = input
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
      .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]")
      .replace(/(Digest\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]")
      .replace(/(?<=(token|secret|password|authorization|api[_-]?key|cookie)[:=])\s*[^\s"'&]+/gi, "[redacted]")
      .replace(/([?&](?:token|secret|password|authorization|api[_-]?key|cookie)=)[^&#\s"']+/gi, "$1[redacted]")
    for (const pattern of STANDALONE_SECRET_PATTERNS) clean = clean.replace(pattern, "[redacted]")
    return clean.length > maxLength
      ? `${clean.slice(0, maxLength)}...(truncated ${clean.length - maxLength} chars)`
      : clean
  }

  export function errorInfo(error: unknown) {
    if (error instanceof Error) {
      return {
        name: text(error.name || "Error", 128),
        message: text(error.message, 512),
      }
    }
    return { name: "Error", message: text(String(error), 512) }
  }

  export function routePath(input: string) {
    const path = url(input)
    return path
      .split("/")
      .map((part) => {
        if (!part) return part
        if (part.length > 48) return ":value"
        if (/^[A-Za-z0-9_-]{20,}$/.test(part)) return ":value"
        if (/^(sk-|ghp_|github_pat_|xoxb-|tok_|key_)/i.test(part)) return ":secret"
        return part
      })
      .join("/")
  }

  export function commandFamily(command: string | undefined) {
    if (!command) return "unknown"
    const first = command.trim().split(/\s+/)[0] ?? "unknown"
    const base = first.split(/[\\/]/).pop() ?? first
    return text(base, 64).replace(/[^A-Za-z0-9._-]/g, "_") || "unknown"
  }

  export function commandSummary(command: string | undefined) {
    return {
      family: commandFamily(command),
      length: command?.length ?? 0,
    }
  }

  export function cwdScope(cwd: string | undefined) {
    if (!cwd) return "unknown"
    try {
      const abbr = cwd
        .split("/")
        .filter((segment) => segment && segment !== "private" && !/^var$/i.test(segment))
        .slice(-2)
        .join("/")
      return text(abbr, 128) || "configured"
    } catch {
      return "configured"
    }
  }

  export function error(error: Error) {
    return text(error.name || "Error", 128)
  }

  export function url(input: string) {
    try {
      const parsed = new URL(input, "http://localhost")
      return text(parsed.pathname)
    } catch {
      return text(input)
    }
  }

  export function isSensitiveKey(key: string) {
    const raw = key.toLowerCase()
    if (raw.endsWith("_key") || raw.endsWith("_secret")) return true
    const normalized = raw.replace(/[-_]/g, "")
    const configured = ObservabilityConfig.current().redactAttributeKeys ?? []
    // Broad patterns: use word-boundary check to avoid false positives like "somebody", "envelope"
    const broadKeys = new Set(["body", "headers", "prompt", "completion", "content", "env"])
    // Bare "key" is sensitive but requires word-boundary to avoid matching "monkey", "keyboard" etc.
    if (/^key$|^key_|_key_|_key$/.test(raw)) return true
    // Exact-match patterns via includes — these are unambiguous and unlikely to cause false positives
    const exactKeys = [
      "token",
      "secret",
      "password",
      "auth",
      "bearer",
      "authorization",
      "cookie",
      "set-cookie",
      "apikey",
      "api_key",
      "accesstoken",
      "refreshtoken",
      "agentsecret",
      "openaikey",
      "accesskey",
      "privatekey",
      "credential",
      "stack",
      ...configured.filter((c) => !broadKeys.has(c.toLowerCase().replace(/[-_]/g, ""))),
    ]
    if (exactKeys.some((c) => normalized.includes(c.toLowerCase().replace(/[-_]/g, "")))) return true
    for (const candidate of broadKeys) {
      const cNorm = candidate.replace(/[-_]/g, "")
      if (normalized === cNorm) return true
      if (new RegExp(`(^|[_-])${cNorm}([_-]|$)`, "i").test(raw)) return true
    }
    return false
  }

  function sanitize(value: unknown, depth: number, seen: Set<object>, maxLength: number, state: State): unknown {
    if (value === null || value === undefined) return value ?? null
    if (typeof value === "string") {
      const clean = text(value, maxLength)
      if (clean !== value) {
        state.changed = true
        if (clean.includes("truncated")) state.truncatedValues++
      }
      return clean
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value === "boolean") return value
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "symbol") return value.toString()
    if (typeof value === "function") return "[Function]"
    if (value instanceof Error) {
      return {
        name: text(value.name, 128),
        message: text(value.message, 512),
      }
    }
    if (typeof value !== "object") return String(value)
    if (depth >= MAX_DEPTH) {
      state.changed = true
      state.truncatedValues++
      return "[depth limit]"
    }
    if (seen.has(value)) {
      state.changed = true
      return "[circular]"
    }
    seen.add(value)
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1, seen, maxLength, state))
      if (value.length > MAX_ARRAY_LENGTH) {
        state.changed = true
        state.truncatedValues++
        items.push(`...(${value.length - MAX_ARRAY_LENGTH} more)`)
      }
      return items
    }
    const result: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) {
      if (isCommandKey(key)) {
        result[key] = sanitizeCommandValue(val)
        state.changed = true
        continue
      }
      if (isCommandArgKey(key)) {
        result[key] = "[omitted]"
        state.changed = true
        state.omittedKeys++
        continue
      }
      if (isSensitiveKey(key)) {
        result[key] = "[redacted]"
        state.changed = true
        state.omittedKeys++
      } else {
        result[key] = sanitize(val, depth + 1, seen, maxLength, state)
      }
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      result["..."] = `${entries.length - MAX_OBJECT_KEYS} more keys`
      state.changed = true
      state.truncatedValues++
    }
    return result
  }

  function isCommandKey(key: string) {
    return COMMAND_KEYS.has(key.toLowerCase())
  }

  function isCommandArgKey(key: string) {
    return COMMAND_ARG_KEYS.has(key.toLowerCase())
  }

  function sanitizeCommandValue(value: unknown) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      const family = typeof record.family === "string" ? commandFamily(record.family) : "unknown"
      const length = typeof record.length === "number" && Number.isFinite(record.length) ? record.length : 0
      return { family, length }
    }
    return commandSummary(typeof value === "string" ? value : undefined)
  }

  function flattenRecord(
    input: unknown,
    maxLength: number,
    state: State,
  ): Record<string, ObservabilitySchema.LabelValue> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {}
    const result: Record<string, ObservabilitySchema.LabelValue> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        result[key] = value
        continue
      }
      const raw = JSON.stringify(value)
      const clean = text(raw, maxLength)
      if (clean !== raw) {
        state.changed = true
        if (clean.length > maxLength || clean.includes("truncated")) state.truncatedValues++
      }
      result[key] = clean
    }
    return result
  }

  function summary(state: State): ObservabilitySchema.RedactionSummary {
    return { applied: true, omittedKeys: state.omittedKeys, truncatedValues: state.truncatedValues }
  }
}
