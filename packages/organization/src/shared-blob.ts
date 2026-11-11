import { createHash } from "node:crypto"
import { z } from "zod"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import {
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

const chunkBytes = 4 * 1024 * 1024
const Chunk = z.strictObject({
  offset: z.number().int().nonnegative().safe(),
  bytes: z.number().int().positive().max(chunkBytes),
})
const receiptRoot = (sessionID: string, generation: number, hash: string) => [
  ...Keys.sharedBlob(sessionID, generation, hash),
  "chunk-manifest",
]
const receiptKey = (sessionID: string, generation: number, hash: string, offset: number) => [
  ...receiptRoot(sessionID, generation, hash),
  String(offset).padStart(16, "0"),
]
const lockKey = (sessionID: string, generation: number, hash: string) =>
  `organization-shared-blob:${sessionID}:${generation}:${hash}`
type Authority = () => Promise<Record.SessionDirectory>

function activeAuthority(input: { shareGeneration: number }, authorize: Authority): Authority {
  return async () => {
    const session = await authorize()
    if (session.shareState !== "shared" || session.shareGeneration !== input.shareGeneration)
      fail("SHARE_REVOKED", "The Session share generation is no longer active")
    return session
  }
}

async function verify(manifest: Record.SharedBlob, active: Authority) {
  const hash = createHash("sha256")
  let bytes = 0
  let count = 0
  for await (const row of Storage.records({
    prefix: receiptRoot(manifest.sessionID, manifest.shareGeneration, manifest.hash),
    limit: 128,
  })) {
    const chunk = Chunk.parse(row.value)
    if (
      row.key.at(-1) !== String(bytes).padStart(16, "0") ||
      chunk.offset !== bytes ||
      chunk.bytes !== Math.min(chunkBytes, manifest.bytes - bytes)
    )
      fail("INVALID_REQUEST", "Shared blob chunk manifest is incomplete or changed")
    await Storage.snapshot(active)
    const content = await Storage.readBinary(
      Keys.sharedBlobChunk(manifest.sessionID, manifest.shareGeneration, manifest.hash, chunk.offset),
      { maxBytes: chunkBytes },
    )
    if (content.byteLength !== chunk.bytes) fail("INVALID_REQUEST", "Shared blob chunk size changed")
    hash.update(content)
    bytes += content.byteLength
    count++
  }
  if (bytes !== manifest.bytes || count !== manifest.receivedChunks || hash.digest("hex") !== manifest.hash) {
    await Storage.transaction(async () => {
      await active()
      await Storage.removeTree(Keys.sharedBlob(manifest.sessionID, manifest.shareGeneration, manifest.hash))
    })
    fail("INVALID_REQUEST", "Blob bytes do not match the declared content hash")
  }
  return Storage.transaction(async () => {
    await active()
    const key = Keys.sharedBlob(manifest.sessionID, manifest.shareGeneration, manifest.hash)
    const current = await Record.read(Record.SharedBlob, key)
    if (
      !current ||
      current.bytes !== bytes ||
      current.receivedBytes !== bytes ||
      current.receivedChunks !== count ||
      current.nextOffset !== bytes
    )
      fail("REVISION_CONFLICT", "Shared blob changed before integrity publication")
    const complete = Record.SharedBlob.parse({ ...current, complete: true, updatedAt: Date.now() })
    await Storage.write(key, complete)
    return complete
  })
}

export namespace OrganizationSharedBlobs {
  export function status(manifest: Record.SharedBlob) {
    return Sync.BlobStatus.parse({
      sessionID: manifest.sessionID,
      shareGeneration: manifest.shareGeneration,
      hash: manifest.hash,
      bytes: manifest.bytes,
      chunkBytes,
      receivedBytes: manifest.receivedBytes,
      complete: manifest.complete,
      nextOffset: manifest.complete ? undefined : manifest.nextOffset === manifest.bytes ? 0 : manifest.nextOffset,
    })
  }
  export async function complete(manifest: Record.SharedBlob, authorize: Authority) {
    const active = activeAuthority(manifest, authorize)
    using held = await Lock.write(lockKey(manifest.sessionID, manifest.shareGeneration, manifest.hash))
    await Storage.snapshot(active)
    const current = await Record.read(
      Record.SharedBlob,
      Keys.sharedBlob(manifest.sessionID, manifest.shareGeneration, manifest.hash),
    )
    if (!current) fail("NOT_FOUND", "Blob not found")
    if (current.complete) return current
    if (current.receivedBytes !== current.bytes || current.nextOffset !== current.bytes)
      fail("BLOB_INCOMPLETE", "Blob upload is incomplete")
    return verify(current, active)
  }
  export async function upload(
    input: {
      sessionID: string
      shareGeneration: number
      hash: string
      offset: number
      totalBytes: number
      bytes: Uint8Array
    },
    authorize: Authority,
  ) {
    const hash = Protocol.Digest.parse(input.hash)
    const generation = Identity.Revision.parse(input.shareGeneration)
    const offset = z.number().int().nonnegative().safe().parse(input.offset)
    const total = z.number().int().nonnegative().safe().parse(input.totalBytes)
    const expected = Math.min(chunkBytes, total - offset)
    if (
      offset % chunkBytes !== 0 ||
      offset > total ||
      input.bytes.byteLength !== expected ||
      expected < 0 ||
      (expected === 0 && (total !== 0 || offset !== 0))
    )
      fail("INVALID_REQUEST", "Blob chunk must cover its complete declared aligned range")
    const active = activeAuthority(input, authorize)
    await Storage.snapshot(active)
    const binaryKey = Keys.sharedBlobChunk(input.sessionID, generation, hash, offset)
    using prepared = input.bytes.byteLength ? await Storage.prepareBinary(binaryKey, input.bytes) : undefined
    using held = await Lock.write(lockKey(input.sessionID, generation, hash))
    const manifest = await Storage.transaction(async () => {
      const session = await active()
      const key = Keys.sharedBlob(input.sessionID, generation, hash)
      const current = await Record.read(Record.SharedBlob, key)
      if (current && (current.bytes !== total || current.hash !== hash))
        fail("REVISION_CONFLICT", "Blob metadata cannot change after its first chunk")
      const receipt = receiptKey(input.sessionID, generation, hash, offset)
      const [existing] = await Storage.readMany([receipt])
      let added = 0
      if (existing !== undefined) {
        const previous = Chunk.parse(existing)
        if (previous.bytes !== input.bytes.byteLength) fail("REVISION_CONFLICT", "Published blob chunks are immutable")
        const previousBytes = await Storage.readBinary(binaryKey, { maxBytes: chunkBytes })
        if (!Buffer.from(previousBytes).equals(input.bytes))
          fail("REVISION_CONFLICT", "Published blob chunks are immutable")
      } else if (prepared) {
        await Storage.publishPreparedBinary(prepared)
        await Storage.write(receipt, Chunk.parse({ offset, bytes: input.bytes.byteLength }))
        added = input.bytes.byteLength
      }
      let nextOffset = current?.nextOffset ?? 0
      while (nextOffset < total) {
        const [next] = await Storage.readMany([receiptKey(input.sessionID, generation, hash, nextOffset)])
        if (next === undefined) break
        const chunk = Chunk.parse(next)
        if (chunk.offset !== nextOffset || chunk.bytes !== Math.min(chunkBytes, total - nextOffset))
          fail("INVALID_REQUEST", "Shared blob chunk manifest has an inconsistent range")
        nextOffset += chunk.bytes
      }
      const next = Record.SharedBlob.parse({
        schemaVersion: 2,
        sessionID: session.sessionID,
        shareGeneration: generation,
        hash,
        bytes: total,
        chunkBytes,
        receivedBytes: (current?.receivedBytes ?? 0) + added,
        receivedChunks: (current?.receivedChunks ?? 0) + (added ? 1 : 0),
        nextOffset,
        complete: current?.complete ?? false,
        createdAt: current?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      })
      await Storage.write(key, next)
      return next
    })
    return status(
      manifest.receivedBytes === total && manifest.nextOffset === total && !manifest.complete
        ? await verify(manifest, active)
        : manifest,
    )
  }
}

const Legacy = Record.SharedBlob.omit({ schemaVersion: true, nextOffset: true, receivedChunks: true }).extend({
  schemaVersion: z.literal(1),
  chunks: z.array(Chunk),
})
export const sharedBlobMigration: Migration = {
  id: "20261111-organization-shared-blob-chunk-pages-v2",
  description: "Page shared blob chunk receipts and require proven integrity before publishing completion",
  scope: "global",
  execution: "maintenance",
  emptyInput: [["organization", "shared-blobs"]],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["organization", "shared-blobs"], limit: 128 })) {
      if (row.key.length !== 5) continue
      await Storage.transaction(async () => {
        const raw = await Storage.read(row.key)
        if (Record.SharedBlob.safeParse(raw).success) return
        const legacy = Legacy.parse(raw)
        if (
          legacy.sessionID !== row.key[2] ||
          String(legacy.shareGeneration) !== row.key[3] ||
          legacy.hash !== row.key[4]
        )
          fail("SERVICE_UNAVAILABLE", "Retained shared blob identity changed")
        let received = 0
        let nextOffset = 0
        let previous = -1
        for (const chunk of legacy.chunks) {
          if (
            chunk.offset <= previous ||
            chunk.offset % chunkBytes !== 0 ||
            chunk.bytes !== Math.min(chunkBytes, legacy.bytes - chunk.offset)
          )
            fail("SERVICE_UNAVAILABLE", "Retained shared blob chunk range is inconsistent")
          await Storage.write(receiptKey(legacy.sessionID, legacy.shareGeneration, legacy.hash, chunk.offset), chunk)
          if (chunk.offset === nextOffset) nextOffset += chunk.bytes
          received += chunk.bytes
          previous = chunk.offset
        }
        if (received !== legacy.receivedBytes || received > legacy.bytes)
          fail("SERVICE_UNAVAILABLE", "Retained shared blob byte count changed")
        const { chunks, ...metadata } = legacy
        await Storage.write(
          row.key,
          Record.SharedBlob.parse({
            ...metadata,
            schemaVersion: 2,
            nextOffset,
            receivedChunks: chunks.length,
            complete: false,
          }),
        )
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
