import fs from "fs"

export function sha256Hex(buffer: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

export function sha256File(filePath: string): string {
  const buffer = fs.readFileSync(filePath)
  return sha256Hex(new Uint8Array(buffer))
}

export function sha256JSON(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2)
  return sha256Hex(new Uint8Array(Buffer.from(json)))
}

export function sha256Content(content: string): string {
  return sha256Hex(new Uint8Array(Buffer.from(content)))
}
