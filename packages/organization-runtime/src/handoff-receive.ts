import { createHash } from "node:crypto"
import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { SessionTransferStream as Stream } from "@ericsanchezok/synergy-harness/session/transfer"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationHandoffReceive {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "PROTOCOL_MISMATCH", message, outcome: "rejected", retryable: false })
  }
  export function open(input: {
    manifestHash: string
    signal: AbortSignal
    cache: { contains(hash: string): Promise<boolean>; store: BlobStore }
    read(request: z.infer<typeof Handoff.ObjectRange> & { manifestHash: string }): Promise<unknown>
  }) {
    const manifestHash = Hash.parse(input.manifestHash)
    const store: BlobStore = {
      put: input.cache.store.put,
      async get(hash, maximumBytes) {
        input.signal.throwIfAborted()
        Hash.parse(hash)
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > Stream.chunkBytes)
          fail("Handoff object request exceeds its bounded frame")
        if (await input.cache.contains(hash)) {
          const bytes = await input.cache.store.get(hash, maximumBytes)
          input.signal.throwIfAborted()
          if (bytes.length > maximumBytes || digest(bytes) !== hash) fail("Handoff cached object checksum mismatch")
          return bytes
        }
        const chunks: Uint8Array[] = []
        const checksum = createHash("sha256")
        let offset = 0
        let totalBytes: number | undefined
        while (true) {
          input.signal.throwIfAborted()
          const length = Math.min(128 * 1024, Math.max(1, maximumBytes - offset))
          const raw = await input.read({ manifestHash, hash, offset, length })
          input.signal.throwIfAborted()
          const chunk = Handoff.ObjectChunk.parse(raw)
          if (
            chunk.hash !== hash ||
            chunk.offset !== offset ||
            chunk.nextOffset - offset > length ||
            chunk.totalBytes > maximumBytes ||
            (totalBytes !== undefined && chunk.totalBytes !== totalBytes) ||
            (!chunk.complete && chunk.nextOffset === offset)
          )
            fail("Handoff object ranges changed their immutable window")
          totalBytes = chunk.totalBytes
          const bytes = Buffer.from(chunk.data, "base64url")
          chunks.push(bytes)
          checksum.update(bytes)
          offset = chunk.nextOffset
          if (!chunk.complete) continue
          if (offset !== totalBytes || checksum.digest("hex") !== hash) fail("Handoff object checksum mismatch")
          const complete = Buffer.concat(chunks, offset)
          input.signal.throwIfAborted()
          await input.cache.store.put(hash, complete)
          return complete
        }
      },
    }
    async function root() {
      const bytes = await store.get(manifestHash, Stream.pageBytes)
      const value = Stream.Root.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
      if (Stream.digest(value) !== manifestHash) fail("Handoff native root checksum mismatch")
      return value
    }
    return { store, root }
  }
}
