import { createHash } from "node:crypto"
import z from "zod"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import type { Truncate } from "./truncation"

const MAX_BYTES = 32 * 1024 * 1024
const ID = z.string().regex(/^tool_[a-zA-Z0-9_-]{1,128}$/)
const Info = z.strictObject({
  version: z.literal(1),
  bytes: z.number().int().nonnegative().max(MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")
const reference = (id: string) => `tool-output://${ID.parse(id)}`
const dataKey = (id: string) => ["tool_outputs", id, "content"]
const infoKey = (id: string) => ["tool_outputs", id, "info"]
const aliasKey = (alias: string) => ["tool_output_aliases", hash(alias)]

/** Immutable output records share the current Storage authority, never a filesystem path. */
export namespace StoredToolOutput {
  export async function save(id: string, text: string, aliases: string[] = []) {
    ID.parse(id)
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("tool_output_size_limit")
    if (
      aliases.length > 64 ||
      aliases.some(
        (value) => !value || value.length > 4096 || value.includes("\0") || value.startsWith("tool-output://"),
      )
    )
      throw new Error("tool_output_alias_invalid")
    const bytes = Buffer.from(text)
    const info = Info.parse({ version: 1, bytes: bytes.length, sha256: hash(bytes) })
    using prepared = await Storage.prepareBinary(dataKey(id), bytes)
    await Storage.transaction(async (tx) => {
      const [previous] = await tx.readMany([infoKey(id)])
      if (previous !== undefined && JSON.stringify(Info.parse(previous)) !== JSON.stringify(info))
        throw new StorageIntegrityError("Tool output identifier collision")
      for (const alias of aliases) {
        const [existing] = await tx.readMany<{ alias: string; id: string }>([aliasKey(alias)])
        if (existing !== undefined && (existing.alias !== alias || existing.id !== id))
          throw new StorageIntegrityError("Tool output alias collision")
      }
      await Storage.publishPreparedBinary(prepared)
      await tx.write(infoKey(id), info)
      for (const alias of aliases) await tx.write(aliasKey(alias), { alias, id })
    })
    return reference(id)
  }

  export async function read(input: { reference: string; offset?: number; limit?: number }) {
    const offset = z
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(input.offset ?? 0)
    // Four bytes always permit progress through a complete UTF-8 scalar.
    const limit = z
      .number()
      .int()
      .min(4)
      .max(50 * 1024)
      .parse(input.limit ?? 16 * 1024)
    if (!input.reference || input.reference.length > 4096) throw new Error("tool_output_reference_invalid")
    const canonical = input.reference.startsWith("tool-output://")
    let id: string
    if (canonical) id = ID.parse(input.reference.slice("tool-output://".length))
    else {
      const alias = await Storage.read<{ alias: string; id: string }>(aliasKey(input.reference))
      if (alias.alias !== input.reference) throw new StorageIntegrityError("Tool output alias mismatch")
      id = ID.parse(alias.id)
    }
    const info = Info.parse(await Storage.read(infoKey(id)))
    const bytes = await Storage.readBinary(dataKey(id), { maxBytes: info.bytes })
    if (bytes.length !== info.bytes || hash(bytes) !== info.sha256)
      throw new StorageIntegrityError("Tool output checksum mismatch")
    if (offset > bytes.length) throw new Error("tool_output_offset_out_of_range")
    const continuation = (at: number) => at < bytes.length && (bytes[at] & 0xc0) === 0x80
    if (continuation(offset)) throw new Error("tool_output_offset_not_utf8_boundary")
    let end = Math.min(bytes.length, offset + limit)
    while (continuation(end)) end--
    return {
      reference: reference(id),
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)),
      offset,
      nextOffset: end,
      totalBytes: bytes.length,
      truncated: end < bytes.length,
    }
  }

  export function persistence(): Truncate.Persistence {
    return {
      async save(id, text) {
        return {
          reference: await save(id, text),
          instructions:
            "Use read_tool_output with this reference and byte offset/limit; continue at nextOffset. No shell or workspace is needed.",
        }
      },
    }
  }
}
