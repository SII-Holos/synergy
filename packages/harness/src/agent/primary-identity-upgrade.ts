export namespace PrimaryAgentUpgrade {
  const renamed: Readonly<Record<string, string>> = {
    synergy: "atlas",
    "synergy-max": "forge",
    "synergy-flash": "pico",
  }

  export function name(value: string): string {
    return Object.hasOwn(renamed, value) ? renamed[value] : value
  }

  export function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  }

  export function fields(value: unknown, keys: readonly string[]) {
    const item = record(value)
    if (!item) return
    for (const key of keys) {
      if (typeof item[key] === "string") item[key] = name(item[key])
    }
  }

  export function keys(value: unknown) {
    const item = record(value)
    if (!item) return
    const entries = Object.entries(item)
    if (!entries.some(([key]) => name(key) !== key)) return
    for (const key of Object.keys(item)) delete item[key]
    for (const [key, value] of entries) item[name(key)] = value
  }
}
