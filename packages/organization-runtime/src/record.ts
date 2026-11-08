import { z } from "zod"
import { createReadStream } from "node:fs"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

export class MemberHomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemberHomeError"
  }
}

export async function readRecord<T>(filename: string, schema: z.ZodType<T>, label: string) {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of createReadStream(filename, { end: 8192 })) chunks.push(chunk)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const text = Buffer.concat(chunks).toString("utf8")
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
