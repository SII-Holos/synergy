import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferSource as Source,
  SessionTransferStream as Stream,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationHandoffObjects {
  const ID = z.string().min(1).max(4096)
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Identity = z.strictObject({
    orgID: ID,
    deploymentIncarnation: ID,
    role: z.enum(["source", "target"]),
    binding: Epochs.Binding,
  })
  export type Identity = z.infer<typeof Identity>
  const Header = z.strictObject({ version: z.literal(1), identity: Identity })
  const Object = z.strictObject({
    version: z.literal(1),
    hash: Hash,
    bytes: z.number().int().nonnegative().max(Stream.chunkBytes),
  })
  const Sealed = z.strictObject({
    version: z.literal(1),
    manifestHash: Hash,
    objects: z.number().int().positive().safe(),
  })
  const Range = z.strictObject({
    manifestHash: Hash,
    hash: Hash,
    offset: z.number().int().nonnegative().safe(),
    limit: z
      .number()
      .int()
      .positive()
      .max(128 * 1024),
  })
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  function fail(message: string): never {
    throw new OrganizationRuntimeError({ code: "REVISION_CONFLICT", message, outcome: "rejected", retryable: false })
  }

  export async function open(value: Identity, signal: AbortSignal) {
    signal.throwIfAborted()
    const identity = Identity.parse(value)
    const runtime = RuntimeContext.current()
    const currentStorage = Storage.current()
    const storage = {
      store: currentStorage.store,
      artifactDirectory: currentStorage.artifactDirectory,
      artifactObjects: currentStorage.artifactObjects,
    }
    const prefix = [
      "organization_handoff_objects",
      identity.orgID,
      identity.deploymentIncarnation,
      identity.binding.handoffID,
      identity.role,
    ]
    const headerKey = [...prefix, "header"]
    const sealedKey = [...prefix, "sealed"]
    const binaryKey = (hash: string) => [...prefix, "objects", hash]
    const objectKey = (hash: string) => [...prefix, "metadata", hash]
    const membershipPrefix = (hash: string) => [...prefix, "closure", hash]
    const lockName = "organization-handoff-objects:" + digest(new TextEncoder().encode(JSON.stringify(prefix)))
    function assertOwner() {
      signal.throwIfAborted()
      if (RuntimeContext.current() !== runtime) fail("Handoff objects belong to another native Runtime")
      const current = Storage.current()
      if (
        current.store !== storage.store ||
        current.artifactDirectory !== storage.artifactDirectory ||
        current.artifactObjects !== storage.artifactObjects
      )
        fail("Handoff objects belong to another storage owner")
    }
    {
      using lock = await Lock.writeWithSignal(lockName, signal)
      assertOwner()
      const [raw] = await Storage.readMany([headerKey])
      assertOwner()
      if (raw === undefined) await Storage.write(headerKey, Header.parse({ version: 1, identity }))
      else if (JSON.stringify(Header.parse(raw).identity) !== JSON.stringify(identity))
        fail("Handoff object binding changed")
      assertOwner()
    }
    const store = {
      async put(hash: string, bytes: Uint8Array) {
        assertOwner()
        Hash.parse(hash)
        if (bytes.byteLength > Stream.chunkBytes) fail("Handoff object exceeds its bounded transport frame")
        if (digest(bytes) !== hash) fail("Handoff object checksum mismatch")
        using lock = await Lock.writeWithSignal(lockName + ":" + hash, signal)
        assertOwner()
        const [existing] = await Storage.readMany([objectKey(hash)])
        assertOwner()
        if (existing !== undefined) {
          const previous = Object.parse(existing)
          if (previous.hash !== hash || previous.bytes !== bytes.byteLength) fail("Handoff immutable object changed")
          return
        }
        using prepared = await Storage.prepareBinary(binaryKey(hash), bytes)
        assertOwner()
        await Storage.transaction(
          async () => {
            assertOwner()
            await Storage.publishPreparedBinary(prepared)
            assertOwner()
            await Storage.write(objectKey(hash), Object.parse({ version: 1, hash, bytes: bytes.byteLength }))
            assertOwner()
          },
          { commitGuard: assertOwner },
        )
        assertOwner()
      },
      async get(hash: string, maximumBytes: number) {
        assertOwner()
        Hash.parse(hash)
        z.number().int().nonnegative().max(Stream.chunkBytes).parse(maximumBytes)
        const [raw] = await Storage.readMany([objectKey(hash)])
        assertOwner()
        if (raw === undefined) fail("Handoff object is outside this binding")
        const metadata = Object.parse(raw)
        if (metadata.hash !== hash || metadata.bytes > maximumBytes) fail("Handoff object exceeds its requested frame")
        const bytes = await Storage.readBinary(binaryKey(hash), { maxBytes: maximumBytes })
        assertOwner()
        if (bytes.length !== metadata.bytes || digest(bytes) !== hash) fail("Handoff object checksum mismatch")
        return bytes
      },
    }
    async function contains(hash: string) {
      assertOwner()
      Hash.parse(hash)
      const [raw] = await Storage.readMany([objectKey(hash)])
      assertOwner()
      if (raw === undefined) return false
      if (Object.parse(raw).hash !== hash) fail("Handoff cached object identity changed")
      return true
    }
    async function inspect() {
      assertOwner()
      const [raw] = await Storage.readMany([sealedKey])
      assertOwner()
      return raw === undefined ? undefined : Sealed.parse(raw)
    }
    async function sourcePackage() {
      if (identity.role !== "source") fail("Only the source may seal its frozen package")
      const prepared = await Source.status(identity.binding)
      assertOwner()
      if (!prepared) fail("Handoff source package is not sealed")
      return prepared
    }
    async function sealSource() {
      assertOwner()
      using lock = await Lock.writeWithSignal(lockName + ":seal", signal)
      assertOwner()
      const prepared = await sourcePackage()
      const retained = await inspect()
      if (retained) {
        if (retained.manifestHash !== prepared.manifestHash) fail("Handoff source package changed after sealing")
        return retained
      }
      const rootBytes = new TextEncoder().encode(JSON.stringify(Stream.Root.parse(prepared.root)))
      await store.put(prepared.manifestHash, rootBytes)
      const membership = membershipPrefix(prepared.manifestHash)
      const verifiedStore = {
        put: store.put,
        async get(hash: string, maximumBytes: number) {
          const bytes = await store.get(hash, maximumBytes)
          assertOwner()
          await Storage.write([...membership, hash], Object.parse({ version: 1, hash, bytes: bytes.length }))
          assertOwner()
          return bytes
        },
      }
      const directory = path.join(Global.Path.cache, "organization-handoff-objects")
      await fs.mkdir(directory, { recursive: true })
      assertOwner()
      await using reader = await Stream.open({ root: prepared.root, store: verifiedStore, directory, signal })
      assertOwner()
      for await (const entry of reader.entries()) for await (const _bytes of entry.content) signal.throwIfAborted()
      if (!reader.verified()) fail("Handoff package closure was not completely verified")
      await verifiedStore.get(prepared.manifestHash, Stream.pageBytes)
      let objects = 0
      for await (const _row of Storage.records({ prefix: membership, limit: 128 })) {
        signal.throwIfAborted()
        objects++
      }
      await sourcePackage()
      assertOwner()
      const sealed = Sealed.parse({ version: 1, manifestHash: prepared.manifestHash, objects })
      await Storage.write(sealedKey, sealed)
      assertOwner()
      return sealed
    }
    async function range(value: z.infer<typeof Range>): Promise<z.infer<typeof Handoff.ObjectChunk>> {
      assertOwner()
      const input = Range.parse(value)
      const sealed = await inspect()
      if (!sealed || sealed.manifestHash !== input.manifestHash) fail("Handoff object package is not sealed")
      const prepared = await sourcePackage()
      if (prepared.manifestHash !== input.manifestHash) fail("Handoff source ownership changed")
      const [raw] = await Storage.readMany([[...membershipPrefix(input.manifestHash), input.hash]])
      assertOwner()
      if (raw === undefined) fail("Handoff object is outside the sealed package closure")
      const metadata = Object.parse(raw)
      if (input.offset > metadata.bytes) fail("Handoff object offset is outside its immutable bytes")
      const bytes = await store.get(input.hash, metadata.bytes)
      const nextOffset = Math.min(bytes.length, input.offset + input.limit)
      return Handoff.ObjectChunk.parse({
        hash: input.hash,
        offset: input.offset,
        nextOffset,
        totalBytes: bytes.length,
        data: Buffer.from(bytes.subarray(input.offset, nextOffset)).toString("base64url"),
        complete: nextOffset === bytes.length,
      })
    }
    return { store, contains, inspect, sealSource, range }
  }
}
