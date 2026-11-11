import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { SnapshotStore } from "./snapshot-store"

export namespace StoredSnapshotContent {
  export const chunkBytes = 4 * 1024 * 1024
  export const pageSize = 128
  export const pageBytes = 64 * 1024
  const Count = z.number().int().nonnegative().safe()
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Root = z.string().regex(/^[a-f0-9]{40}$/)
  const Component = z.string().regex(/^[a-zA-Z0-9_-]+$/)
  const Chunk = z.strictObject({ sha256: Hash, bytes: Count.positive().max(chunkBytes) })
  export const LegacyManifest = z.strictObject({
    version: z.literal(1),
    root: Root,
    packs: z
      .array(z.strictObject({ chunks: z.array(Chunk).min(1).max(32768) }))
      .min(1)
      .max(64),
  })
  export type LegacyManifest = z.infer<typeof LegacyManifest>
  export const Header = z.strictObject({
    version: z.literal(2),
    root: Root,
    contentID: Component,
    layout: z.literal("chunks-v2"),
    packCount: Count.positive(),
    chunkCount: Count.positive(),
    pageCount: Count.positive(),
    totalBytes: Count.positive(),
    manifestHash: Hash,
  })
  export type Header = z.infer<typeof Header>
  export const Manifest = z.discriminatedUnion("version", [LegacyManifest, Header])
  export type Manifest = z.infer<typeof Manifest>
  export const Reference = Chunk.extend({ pack: Count, index: Count })
  export type Reference = z.infer<typeof Reference>
  export const Page = z.strictObject({
    version: z.literal(1),
    page: Count,
    entries: z.array(Reference).min(1).max(pageSize),
  })
  export const line = (ref: Reference) =>
    JSON.stringify({ pack: ref.pack, index: ref.index, sha256: ref.sha256, bytes: ref.bytes }) + "\n"
  export function key(scopeID: string, retentionID: string, root: string) {
    return [
      "snapshot-v2",
      SnapshotStore.component(scopeID),
      "content",
      SnapshotStore.component(retentionID),
      Root.parse(root),
    ]
  }
  export function legacyKey(scopeID: string, retentionID: string, root: string) {
    return [
      "sessions",
      SnapshotStore.component(scopeID),
      SnapshotStore.component(retentionID),
      "snapshot_content",
      Root.parse(root),
    ]
  }
  export const LegacyFence = z.strictObject({ version: z.literal(1) })
  export function legacyFenceKey(scopeID: string, retentionID: string, root?: string) {
    return [
      "snapshot-v2",
      SnapshotStore.component(scopeID),
      "legacy-content",
      SnapshotStore.component(retentionID),
      root === undefined ? "all" : Root.parse(root),
    ]
  }
  export async function legacyEnabled(scopeID: string, retentionID: string, root: string) {
    for (const candidate of [undefined, root]) {
      const value = await SnapshotStore.optional<unknown>(legacyFenceKey(scopeID, retentionID, candidate))
      if (value === undefined) continue
      LegacyFence.parse(value)
      return false
    }
    return true
  }
  export function headerIdentity(key: string[]) {
    if (key.length !== 6 || key[5] !== "manifest") return
    const legacy = key[0] === "sessions" && key[3] === "snapshot_content"
    if (!legacy && !(key[0] === "snapshot-v2" && key[2] === "content")) return
    return {
      scopeID: SnapshotStore.component(key[1]),
      retentionID: SnapshotStore.component(key[legacy ? 2 : 3]),
      root: Root.parse(key[4]),
      legacy,
    }
  }
  export function fenceIdentity(key: string[]) {
    if (key.length !== 5 || key[0] !== "snapshot-v2" || key[2] !== "legacy-content") return
    return {
      scopeID: SnapshotStore.component(key[1]),
      retentionID: SnapshotStore.component(key[3]),
      root: key[4] === "all" ? undefined : Root.parse(key[4]),
    }
  }
  export async function* roots(scopeID: string, retentionID: string, signal?: AbortSignal) {
    async function* inventory(prefix: string[], legacy: boolean) {
      let after: string[] | undefined
      for (;;) {
        signal?.throwIfAborted()
        const page = await Storage.queryKeys({ prefix, after, limit: 128 })
        for (const key of page) {
          const identity = headerIdentity(key)
          if (!identity || identity.legacy !== legacy)
            throw new Error("Durable Snapshot inventory contains an unrelated record")
          if (!legacy || (await legacyEnabled(scopeID, retentionID, identity.root))) yield identity.root
        }
        if (page.length < 128) return
        after = page.at(-1)
      }
    }
    const current = inventory(
      ["snapshot-v2", SnapshotStore.component(scopeID), "content", SnapshotStore.component(retentionID)],
      false,
    )
    const legacy = inventory(["sessions", scopeID, retentionID, "snapshot_content"], true)
    let left = await current.next()
    let right = await legacy.next()
    try {
      while (!left.done || !right.done) {
        signal?.throwIfAborted()
        const root =
          !left.done && (right.done || left.value < right.value) ? left.value : !right.done ? right.value : undefined
        if (root === undefined) break
        yield root
        if (!left.done && left.value === root) left = await current.next()
        if (!right.done && right.value === root) right = await legacy.next()
      }
    } finally {
      await current.return(undefined)
      await legacy.return(undefined)
    }
  }
  export function contentKey(scopeID: string, retentionID: string, header: Pick<Header, "root" | "contentID">) {
    return [...key(scopeID, retentionID, header.root), "contents", Component.parse(header.contentID)]
  }
  export function pageKey(
    scopeID: string,
    retentionID: string,
    header: Pick<Header, "root" | "contentID">,
    page: number,
  ) {
    return [...contentKey(scopeID, retentionID, header), "pages", String(Count.parse(page)).padStart(16, "0")]
  }
  export function chunkKey(
    scopeID: string,
    retentionID: string,
    header: LegacyManifest | Pick<Header, "version" | "root" | "contentID" | "layout">,
    ref: Pick<Reference, "pack" | "index">,
  ) {
    return [
      ...(header.version === 1
        ? legacyKey(scopeID, retentionID, header.root)
        : contentKey(scopeID, retentionID, header)),
      "packs",
      String(ref.pack),
      String(ref.index),
    ]
  }
  export async function read(scopeID: string, retentionID: string, root: string, maxBytes?: number) {
    const current = await SnapshotStore.optional<unknown>([...key(scopeID, retentionID, root), "manifest"])
    const value =
      current === undefined
        ? (await legacyEnabled(scopeID, retentionID, root))
          ? await SnapshotStore.optional<unknown>([...legacyKey(scopeID, retentionID, root), "manifest"])
          : undefined
        : current
    if (value === undefined) return
    const manifest = current === undefined ? LegacyManifest.parse(value) : Header.parse(value)
    if (manifest.root !== root) throw new Error("Snapshot manifest root mismatch")
    const bytes = size(manifest)
    if (maxBytes !== undefined && bytes > maxBytes)
      throw new Error("Snapshot content exceeds the explicitly selected byte budget")
    return manifest
  }
  export function size(manifest: Manifest) {
    return manifest.version === 2
      ? manifest.totalBytes
      : manifest.packs.reduce((sum, pack) => sum + pack.chunks.reduce((n, chunk) => n + chunk.bytes, 0), 0)
  }
  export async function* references(input: {
    scopeID: string
    retentionID: string
    manifest: Manifest
    signal?: AbortSignal
    readPage?(key: string[], maximum: number, signal?: AbortSignal): Promise<Uint8Array>
  }): AsyncGenerator<Reference & { key: string[] }> {
    const manifest = Manifest.parse(input.manifest)
    if (manifest.version === 1) {
      for (const [pack, value] of manifest.packs.entries())
        for (const [index, chunk] of value.chunks.entries()) {
          input.signal?.throwIfAborted()
          const ref = { pack, index, ...chunk }
          yield { ...ref, key: chunkKey(input.scopeID, input.retentionID, manifest, ref) }
        }
      return
    }
    if (manifest.pageCount !== Math.ceil(manifest.chunkCount / pageSize))
      throw new Error("Snapshot page count mismatch")
    let complete = false
    let failed = false
    let chunks = 0
    let totalBytes = 0
    let pack = 0
    let index = 0
    const hash = createHash("sha256")
    try {
      for (let page = 0; page < manifest.pageCount; page++) {
        input.signal?.throwIfAborted()
        const key = pageKey(input.scopeID, input.retentionID, manifest, page)
        const bytes = input.readPage
          ? await input.readPage(key, pageBytes, input.signal)
          : await Storage.readBinary(key, { maxBytes: pageBytes })
        if (bytes.byteLength > pageBytes) throw new Error("Snapshot descriptor page exceeds its format")
        const value = Page.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
        if (value.page !== page || value.entries.length !== Math.min(pageSize, manifest.chunkCount - chunks))
          throw new Error("Snapshot descriptor page is missing, reordered or incomplete")
        for (const ref of value.entries) {
          input.signal?.throwIfAborted()
          if (ref.pack === pack + 1 && ref.index === 0 && index > 0) {
            pack++
            index = 0
          }
          if (ref.pack !== pack || ref.index !== index++) throw new Error("Snapshot chunk order mismatch")
          hash.update(line(ref))
          chunks++
          totalBytes += ref.bytes
          Count.parse(totalBytes)
          yield { ...ref, key: chunkKey(input.scopeID, input.retentionID, manifest, ref) }
        }
      }
      input.signal?.throwIfAborted()
      if (chunks !== manifest.chunkCount || pack + 1 !== manifest.packCount || totalBytes !== manifest.totalBytes)
        throw new Error("Snapshot descriptor count mismatch")
      if (hash.digest("hex") !== manifest.manifestHash) throw new Error("Snapshot descriptor seal mismatch")
      complete = true
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (!complete && !failed) {
        input.signal?.throwIfAborted()
        throw new Error("Snapshot descriptor scan must complete")
      }
    }
  }

  export class Writer {
    private readonly runtime = RuntimeContext.current()
    private readonly store = Storage.current().store
    private readonly hash = createHash("sha256")
    private page: Reference[] = []
    private pageCount = 0
    private chunkCount = 0
    private totalBytes = 0
    private packCount = 0
    private nextIndex = 0
    private sealed = false
    constructor(
      readonly scopeID: string,
      readonly retentionID: string,
      readonly root: string,
      readonly contentID: string,
      readonly layout: Header["layout"],
    ) {
      contentKey(scopeID, retentionID, { root, contentID })
    }
    private assertCurrent() {
      if (this.sealed || this.runtime !== RuntimeContext.current() || this.store !== Storage.current().store)
        throw new Error("Snapshot descriptor writer is closed or belongs to another Handle")
    }
    async append(input: Reference) {
      this.assertCurrent()
      const ref = Reference.parse(input)
      if (ref.pack === this.packCount && ref.index === 0) {
        this.packCount++
        this.nextIndex = 0
      }
      if (ref.pack !== this.packCount - 1 || ref.index !== this.nextIndex++)
        throw new Error("Snapshot descriptor preparation order mismatch")
      this.totalBytes += ref.bytes
      Count.parse(this.totalBytes)
      this.chunkCount++
      this.hash.update(line(ref))
      this.page.push(ref)
      if (this.page.length === pageSize) await this.flush()
    }
    private async flush() {
      if (!this.page.length) return
      const bytes = new TextEncoder().encode(
        JSON.stringify(Page.parse({ version: 1, page: this.pageCount, entries: this.page })),
      )
      if (bytes.byteLength > pageBytes) throw new Error("Snapshot descriptor page exceeds its format")
      await Storage.writeBinary(pageKey(this.scopeID, this.retentionID, this, this.pageCount++), bytes)
      this.page = []
    }
    async seal(): Promise<Header> {
      this.assertCurrent()
      await this.flush()
      this.sealed = true
      return Header.parse({
        version: 2,
        root: this.root,
        contentID: this.contentID,
        layout: this.layout,
        packCount: this.packCount,
        chunkCount: this.chunkCount,
        totalBytes: this.totalBytes,
        pageCount: this.pageCount,
        manifestHash: this.hash.digest("hex"),
      })
    }
  }
}
