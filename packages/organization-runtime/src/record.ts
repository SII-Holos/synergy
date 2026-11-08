import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

export class MemberHomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemberHomeError"
  }
}

export async function readRecord<T>(filename: string, schema: z.ZodType<T>, label: string) {
  const text = await Bun.file(filename)
    .slice(0, 8193)
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
  if (text === undefined) return
  try {
    if (Buffer.byteLength(text) > 8192) throw new Error("Oversized record")
    return schema.parse(JSON.parse(text))
  } catch {
    throw new MemberHomeError(`Member Runtime ${label} are invalid or unsupported`)
  }
}

export function writeRecord(filename: string, value: unknown) {
  return AtomicFile.writeJsonAtomic(filename, JSON.stringify(value) + "\n", { private: true, durable: true })
}
