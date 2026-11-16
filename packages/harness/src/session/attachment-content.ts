import { z } from "zod"
import { Storage } from "../storage/storage"
import { StorageIntegrityError } from "../storage/errors"
import { SessionPartField } from "./part-field"
import { RolloutArtifact } from "./rollout/artifact"
import { SessionAttachmentIndex } from "./attachment-index"

export namespace SessionAttachmentContent {
  export const Range = z.strictObject({
    version: z.string().min(1).max(512),
    ordinal: z.number().int().nonnegative().safe().optional(),
    offset: z.number().int().nonnegative().safe().default(0),
    length: z.number().int().min(1).max(65_536).default(65_536),
  })
  export type Range = z.input<typeof Range>
  export interface Descriptor {
    version: string
    filename: string
    mediaType: string
    bytes: number
    sha256: string
  }
  export type Result =
    | { state: "unavailable"; version: string; reason: "not_retained" | "partial" }
    | {
        state: "ready"
        descriptor: Descriptor
        offset: number
        nextOffset: number
        data: Uint8Array
        complete: boolean
      }

  const same = (left: RolloutArtifact.Ref, right: RolloutArtifact.Ref) =>
    left.version === right.version &&
    left.id === right.id &&
    left.mediaType === right.mediaType &&
    left.bytes === right.bytes &&
    left.chunks === right.chunks &&
    left.sha256 === right.sha256 &&
    left.status === right.status

  export async function read(key: string[], input: Range, signal?: AbortSignal): Promise<Result> {
    const range = Range.parse(input)
    signal?.throwIfAborted()
    const ordinal = range.ordinal
    const selected =
      ordinal !== undefined
        ? await (async () => {
            const row = await SessionAttachmentIndex.get(key, { version: range.version, ordinal }, signal)
            return {
              version: range.version,
              filename: row.filename,
              reference: row.artifact,
              current: () => SessionAttachmentIndex.assertVersion(key, range.version, signal),
            }
          })()
        : await (async () => {
            const captured = await SessionPartField.descriptor(key, signal)
            if (captured.version !== range.version)
              throw new SessionPartField.Conflict({ message: "Native attachment content changed" })
            const header = captured.header
            return {
              version: captured.version,
              filename: header.type === "attachment" ? header.filename : undefined,
              reference: header.type === "attachment" ? header.artifact : undefined,
              current: async () => {
                if ((await SessionPartField.descriptor(key, signal)).version !== captured.version)
                  throw new SessionPartField.Conflict({ message: "Native attachment content changed" })
              },
            }
          })()
    async function current() {
      signal?.throwIfAborted()
      await selected.current()
    }
    async function unavailable(reason: "not_retained" | "partial"): Promise<Result> {
      await current()
      return { state: "unavailable", version: selected.version, reason }
    }
    if (!selected.reference) return unavailable("not_retained")
    const owner = { kind: "session" as const, scopeID: key[1], sessionID: key[2] }
    const reference = selected.reference
    const stored = await RolloutArtifact.get(owner, reference.id).catch((error: unknown) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (!stored) return unavailable("not_retained")
    if (!same(stored, reference)) throw new StorageIntegrityError("Attachment evidence does not match its owner")
    if (reference.status !== "complete" || !reference.sha256) return unavailable("partial")
    const data = await RolloutArtifact.readRange(owner, reference, range.offset, range.length, signal)
    await current()
    if (!same(await RolloutArtifact.get(owner, reference.id), reference))
      throw new StorageIntegrityError("Attachment evidence changed during its read")
    signal?.throwIfAborted()
    const name = (selected.filename ?? "attachment").split(/[\\/]/).at(-1) || "attachment"
    const filename = name === "." || name === ".." ? "attachment" : name.slice(0, 512)
    const nextOffset = range.offset + data.byteLength
    return {
      state: "ready",
      descriptor: {
        version: selected.version,
        filename,
        mediaType: reference.mediaType,
        bytes: reference.bytes,
        sha256: reference.sha256,
      },
      offset: range.offset,
      nextOffset,
      data,
      complete: nextOffset === reference.bytes,
    }
  }
}
