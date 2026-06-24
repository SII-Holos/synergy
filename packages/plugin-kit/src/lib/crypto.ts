import fs from "fs"

export function sha256Hex(buffer: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

export function sha256File(filePath: string): string {
  const buffer = fs.readFileSync(filePath)
  return sha256Hex(new Uint8Array(buffer))
}

export function sha256JSON(obj: unknown): string {
  return sha256Content(JSON.stringify(sortKeys(obj)))
}

export function sha256Content(content: string): string {
  return sha256Hex(new Uint8Array(Buffer.from(content)))
}

export function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys)
  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    const result: Record<string, unknown> = {}
    for (const [key, value] of entries) {
      result[key] = sortKeys(value)
    }
    return result
  }
  return obj
}
