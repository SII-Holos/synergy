export namespace SecretPaths {
  export const REDACTED_SENTINEL = "__REDACTED__"

  // Secret-shaped key heuristic for free-form string maps (MCP remote
  // headers, MCP local environment, agent/provider options): these fields
  // hold arbitrary keys, so redaction matches key names instead of fixed
  // paths. Keys are split into components (snake/kebab/camel) so
  // ANTHROPIC_API_KEY and apiKey both match; single `key`-shaped names
  // (keybinds, max_tokens) deliberately do not. mergeRecord restores
  // sentinels from stored values, keeping redacted round-trips lossless.
  const SECRET_KEY_COMPONENTS = new Set([
    "secret",
    "secrets",
    "password",
    "passwords",
    "passwd",
    "token",
    "authorization",
    "credential",
    "credentials",
    "apikey",
    "apikeys",
    "privatekey",
    "privatekeys",
    "accesstoken",
    "accesstokens",
    "refreshtoken",
    "refreshtokens",
    "cookie",
    "cookies",
  ])

  export function isSecretShapedKey(key: string): boolean {
    const parts = key
      .split(/[^a-zA-Z0-9]+/)
      .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .map((part) => part.toLowerCase())
      .filter(Boolean)
    for (const part of parts) if (SECRET_KEY_COMPONENTS.has(part)) return true
    for (let i = 0; i + 1 < parts.length; i++) {
      if (SECRET_KEY_COMPONENTS.has(parts[i]! + parts[i + 1]!)) return true
    }
    return false
  }

  export function redactRecord(record: Record<string, unknown>) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        if (value.length > 0 && isSecretShapedKey(key)) record[key] = REDACTED_SENTINEL
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        redactRecord(value as Record<string, unknown>)
      }
    }
  }

  export function mergeRecord(incoming: Record<string, unknown>, stored: Record<string, unknown> | undefined) {
    if (!stored) return
    for (const [key, value] of Object.entries(incoming)) {
      const storedValue = stored[key]
      if (value === REDACTED_SENTINEL && typeof storedValue === "string" && storedValue.length > 0) {
        incoming[key] = storedValue
      } else if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        storedValue &&
        typeof storedValue === "object" &&
        !Array.isArray(storedValue)
      ) {
        mergeRecord(value as Record<string, unknown>, storedValue as Record<string, unknown>)
      }
    }
  }

  export interface CollectedSecret {
    path: string[]
    value: string
  }

  function collectShaped(record: unknown, path: string[], found: CollectedSecret[]) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      if (typeof value === "string") {
        if (value.length > 0 && isSecretShapedKey(key)) found.push({ path: [...path, key], value })
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        collectShaped(value, [...path, key], found)
      }
    }
  }

  /**
   * Walk the config structures redaction knows about and return every
   * secret-shaped value with its location. The secret vault consumes this
   * on config load so registered secrets mask everywhere without any new
   * per-field enumeration.
   */
  export function collectSecretValues(config: Record<string, unknown>): CollectedSecret[] {
    const found: CollectedSecret[] = []
    const provider = config.provider as Record<string, any> | undefined
    if (provider && typeof provider === "object") {
      for (const [id, entry] of Object.entries(provider)) {
        collectShaped(entry?.options, ["provider", id, "options"], found)
        const models = entry?.models as Record<string, any> | undefined
        if (models && typeof models === "object") {
          for (const [modelID, model] of Object.entries(models)) {
            collectShaped(model?.options, ["provider", id, "models", modelID, "options"], found)
          }
        }
      }
    }
    const agent = config.agent as Record<string, any> | undefined
    if (agent && typeof agent === "object") {
      for (const [id, entry] of Object.entries(agent)) {
        collectShaped(entry?.options, ["agent", id, "options"], found)
      }
    }
    const mcp = config.mcp as Record<string, any> | undefined
    if (mcp && typeof mcp === "object") {
      for (const [id, entry] of Object.entries(mcp)) {
        collectShaped(entry?.oauth, ["mcp", id, "oauth"], found)
        collectShaped(entry?.options?.headers, ["mcp", id, "options", "headers"], found)
        collectShaped(entry?.options?.environment, ["mcp", id, "options", "environment"], found)
      }
    }
    return found
  }
}
