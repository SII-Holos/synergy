import { PerformanceConfig } from "./config"

export namespace PerformanceRedaction {
  const MAX_OBJECT_KEYS = 48
  const MAX_ARRAY_LENGTH = 32

  export function record(
    input: Record<string, unknown> | undefined,
    maxLength = PerformanceConfig.current().maxAttributeStringLength,
  ) {
    if (!input) return {}
    return sanitize(input, 0, new Set(), maxLength) as Record<string, string | number | boolean | null>
  }

  export function text(input: string, maxLength = PerformanceConfig.current().maxAttributeStringLength) {
    const clean = input
      .replace(/(?<=(token|secret|password|authorization|api[_-]?key|cookie)=)[^\s"'&]+/gi, "[redacted]")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    return clean.length > maxLength
      ? `${clean.slice(0, maxLength)}...(truncated ${clean.length - maxLength} chars)`
      : clean
  }

  export function routePath(input: string) {
    const path = url(input)
    return path
      .split("/")
      .map((part) => {
        if (!part) return part
        if (part.length > 48) return ":value"
        if (/^[A-Za-z0-9_-]{20,}$/.test(part)) return ":value"
        if (/^(sk-|ghp_|xoxb-|tok_|key_)/i.test(part)) return ":secret"
        return part
      })
      .join("/")
  }

  export function commandFamily(command: string) {
    const base = command.split(/[\\/]/).pop() ?? command
    return text(base, 64).replace(/[^A-Za-z0-9._-]/g, "_") || "unknown"
  }

  export function cwdScope(cwd: string | undefined) {
    if (!cwd) return "unknown"
    return "configured"
  }

  export function error(error: Error) {
    return text(error.name || "Error", 128)
  }

  export function url(input: string) {
    try {
      const parsed = new URL(input, "http://localhost")
      return parsed.pathname
    } catch {
      return text(input)
    }
  }

  function isSensitiveKey(key: string) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "")
    return PerformanceConfig.current().redactAttributeKeys.some((candidate) =>
      normalized.includes(candidate.toLowerCase().replace(/[-_]/g, "")),
    )
  }

  function sanitize(value: unknown, depth: number, seen: Set<object>, maxLength: number): unknown {
    if (value === null || value === undefined) return value ?? null
    if (typeof value === "string") return text(value, maxLength)
    if (typeof value === "number" || typeof value === "boolean") return value
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "symbol") return value.toString()
    if (typeof value === "function") return "[Function]"
    if (value instanceof Error) return { name: value.name, message: text(value.message, maxLength) }
    if (typeof value !== "object") return String(value)
    if (depth >= 6) return "[depth limit]"
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    if (Array.isArray(value))
      return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1, seen, maxLength))
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      result[key] = isSensitiveKey(key) ? "[redacted]" : sanitize(val, depth + 1, seen, maxLength)
    }
    return result
  }
}
