import { z } from "zod"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

export class MemberHomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemberHomeError"
  }
}

export async function readRecord<T>(filename: string, schema: z.ZodType<T>, label: string) {
  return (await readRecordSnapshot(filename, schema, label))?.value
}

export function parseRecord<T>(bytes: Uint8Array, schema: z.ZodType<T>, label: string, maxBytes = 8192) {
  try {
    if (bytes.byteLength > maxBytes) throw new Error("Oversized record")
    return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")))
  } catch {
    throw new MemberHomeError(`Member Runtime ${label} are invalid or unsupported`)
  }
}

export async function readRecordSnapshot<T>(
  filename: string,
  schema: z.ZodType<T>,
  label: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
) {
  const signal = options.signal
  const limit = options.maxBytes ?? 8192
  signal?.throwIfAborted()
  const invalid = (reason: string) => new MemberHomeError(`Member Runtime ${label} ${reason}`)
  const optional = async (target: string) =>
    fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  const parent = await optional(path.dirname(filename))
  const before = await optional(filename)
  signal?.throwIfAborted()
  if ((parent && (!parent.isDirectory() || parent.isSymbolicLink())) || (before && !before.isFile()))
    throw invalid("must be ordinary regular files in an independent directory")
  if (!before) return
  const file = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
  )
  try {
    signal?.throwIfAborted()
    const initial = await file.stat()
    if (!initial.isFile() || initial.dev !== before.dev || initial.ino !== before.ino)
      throw invalid("changed while opening")
    if (initial.size > limit) throw invalid("are invalid or unsupported")
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const next = await file.read(bytes, offset, bytes.length - offset, offset)
      signal?.throwIfAborted()
      if (!next.bytesRead) break
      offset += next.bytesRead
    }
    const final = await file.stat()
    const retained = await optional(filename)
    const currentParent = await optional(path.dirname(filename))
    signal?.throwIfAborted()
    if (
      !retained?.isFile() ||
      retained.dev !== initial.dev ||
      retained.ino !== initial.ino ||
      retained.size !== initial.size ||
      retained.mtimeMs !== initial.mtimeMs ||
      retained.ctimeMs !== initial.ctimeMs ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs ||
      offset !== initial.size ||
      !currentParent?.isDirectory() ||
      currentParent.isSymbolicLink() ||
      currentParent.dev !== parent?.dev ||
      currentParent.ino !== parent?.ino
    )
      throw invalid("changed while reading")
    const contents = bytes.subarray(0, offset)
    return { value: parseRecord(contents, schema, label, limit), bytes: contents }
  } finally {
    await file.close()
  }
}

export function writeRecord(filename: string, value: unknown) {
  return AtomicFile.writeJsonAtomic(filename, JSON.stringify(value) + "\n", { private: true, durable: true })
}
