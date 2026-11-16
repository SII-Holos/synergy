import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore, type StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { initializeSqliteEngine } from "@ericsanchezok/synergy-harness/storage/sqlite-engine"
import { withStorageQueueOptions } from "@ericsanchezok/synergy-harness/storage/queue"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { ActiveKnowledgeStore as Active } from "../knowledge-active"
import { KnowledgeCache } from "../knowledge-cache"

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Count = z.number().int().nonnegative().safe()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const Address = z.strictObject({ key: z.array(z.string()), cacheID: Hash, value: Active.CachedRelease })
type Address = z.infer<typeof Address>
const rootKey = ["knowledge-native", "manifest"]
const cacheKey = (id: string) => ["knowledge-native", "cache", id]
const addressKey = (key: string[]) => ["knowledge-native", "address", hash(JSON.stringify(key))]
const fileKey = (cacheID: string, fileID: string) => ["knowledge-native", "file", cacheID, fileID]
const byteKey = (cacheID: string, fileID: string) => ["knowledge-native", "bytes", cacheID, fileID]
function fail(message: string): never {
  throw new Error("Hosted knowledge recovery " + message)
}
function address(key: string[], value: unknown): Address | undefined {
  if (key[0] !== "organization-knowledge") return
  if (key[1] === "cache" && key.length === 3) return Address.parse({ key, cacheID: key[2], value })
  if (key[1] === "active-manifests" && key.length === 8 && key[6] === "releases") {
    const cached = Active.CachedRelease.parse(value)
    if (
      cached.release.orgID !== key[2] ||
      (cached.release.scope.kind === "project" && cached.release.scope.projectID !== key[3]) ||
      !/^\d{16}$/.test(key[7]!)
    )
      fail("has an inconsistent manifest release")
    return Address.parse({ key, cacheID: KnowledgeCache.id(cached.release, key[3]!), value: cached })
  }
}
async function index() {
  initializeSqliteEngine()
  const parent = path.join(Global.Path.cache, "knowledge-native")
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await fs.mkdtemp(path.join(parent, "index-"))
  const db = new Database(path.join(directory, "inventory.sqlite"))
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE caches(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE addresses(key TEXT PRIMARY KEY,cacheID TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE files(cacheID TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,location TEXT,PRIMARY KEY(cacheID,id)); CREATE TABLE records(key TEXT PRIMARY KEY,body TEXT NOT NULL)",
  )
  return {
    db,
    directory,
    async close() {
      db.close(true)
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}
function insertAddress(db: Database, value: Address) {
  using previous = db.prepare<{ body: string }, [string]>("SELECT body FROM caches WHERE id=?")
  const body = JSON.stringify(value.value)
  const old = previous.get(value.cacheID)
  if (old && old.body !== body) fail("changes an immutable cached release between references")
  db.prepare("INSERT OR IGNORE INTO caches VALUES(?,?)").run(value.cacheID, body)
  db.prepare("INSERT INTO addresses VALUES(?,?,?)").run(JSON.stringify(value.key), value.cacheID, JSON.stringify(value))
}
function files(db: Database, cacheID: string): AsyncIterable<Publication.File> {
  return (async function* () {
    using rows = db.prepare<{ body: string }, [string]>(
      "SELECT body FROM files WHERE cacheID=? ORDER BY id COLLATE BINARY",
    )
    for (const row of rows.iterate(cacheID)) yield Publication.File.parse(JSON.parse(row.body))
  })()
}
function validateActive(db: Database) {
  using headers = db.prepare<{ key: string; body: string }, []>(
    "SELECT key,body FROM records WHERE json_extract(key,'$[1]')='active'",
  )
  using record = db.prepare<{ body: string }, [string]>("SELECT body FROM records WHERE key=?")
  using rows = db.prepare<{ body: string }, [string, string]>(
    "SELECT body FROM addresses WHERE key>=? AND key<? ORDER BY key COLLATE BINARY",
  )
  for (const row of headers.iterate()) {
    const key = z.array(z.string()).parse(JSON.parse(row.key))
    const header = Active.Header.parse(JSON.parse(row.body))
    if (!same(key, Active.key(header.sessionID))) fail("has an inconsistent active header")
    const root = Active.root(header)
    const sealed = record.get(JSON.stringify([...root, "seal"]))
    if (!sealed) fail("has an unsealed active manifest")
    const seal = z.strictObject({ manifestHash: Hash, releaseCount: Count }).parse(JSON.parse(sealed.body))
    if (seal.manifestHash !== header.selection.manifestHash || seal.releaseCount !== header.selection.releaseCount)
      fail("has an inconsistent active seal")
    const prefix = JSON.stringify([...root, "releases"]).slice(0, -1) + ","
    const digest = createHash("sha256").update("[")
    let count = 0
    for (const release of rows.iterate(prefix, prefix + "\uffff")) {
      const selected = Address.parse(JSON.parse(release.body))
      if (selected.key.at(-1) !== String(count).padStart(16, "0")) fail("has an incomplete active manifest order")
      const item = record.get(JSON.stringify([...root, "items", selected.value.release.itemID]))
      if (!item || JSON.parse(item.body) !== count) fail("has an inconsistent active item index")
      if (count++) digest.update(",")
      const { itemID, version, manifestHash } = selected.value.release
      digest.update(JSON.stringify({ itemID, version, manifestHash }))
    }
    if (count !== seal.releaseCount || digest.update("]").digest("hex") !== seal.manifestHash)
      fail("has an incomplete active manifest")
  }
}

export namespace OrganizationKnowledgeNative {
  export const Manifest = z.strictObject({
    format: z.literal("synergy-organization-knowledge-native"),
    version: z.literal(1),
    source: StorageCheckpoint.Manifest,
    identity: NativeNamespaceIdentity.Descriptor,
    releases: Count,
    addresses: Count,
    files: Count,
    bytes: Count,
  })
  export type Manifest = z.infer<typeof Manifest>
  interface CaptureInput {
    archive: SnapshotMaintenance.ArchiveEvidence
    lease: RuntimeMaintenance.Lease
    directory: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }
  export function capture(input: CaptureInput) {
    const provider = input.keys
    const original = {
      archive: input.archive,
      lease: input.lease,
      directory: input.directory,
      signal: input.signal,
      keys: Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) }),
    }
    return withStorageQueueOptions({ signal: original.signal }, () => captureNative(original))
  }
  async function captureNative(input: CaptureInput) {
    const source = SnapshotMaintenance.assertArchive(input.archive)
    if (!path.isAbsolute(input.directory)) fail("destination must be absolute")
    const assert = () => {
      input.signal?.throwIfAborted()
      SnapshotMaintenance.assertArchive(input.archive)
    }
    const frozen = async () => {
      assert()
      if ((await RuntimeMaintenance.assertHeld(input.lease)).phase !== "frozen")
        fail("requires frozen native maintenance")
      assert()
    }
    await frozen()
    const proof = await NativeNamespaceIdentity.capture()
    const identity = NativeNamespaceIdentity.inspect(proof)
    if (identity.owner !== "organization-runtime" || identity.identity.kind !== "hosted")
      fail("requires its actual Hosted namespace")
    const inventory = await index()
    let target: TransactionalStore | undefined
    let published = false
    let complete = false
    try {
      for await (const entry of StorageCheckpoint.entries({
        directory: source.directory,
        expected: source.namespace,
        keys: input.keys,
        signal: input.signal,
      })) {
        assert()
        if (entry.type !== "record" || entry.key[0] !== "organization-knowledge") continue
        inventory.db
          .prepare("INSERT INTO records VALUES(?,?)")
          .run(JSON.stringify(entry.key), JSON.stringify(entry.value))
        const selected = address(entry.key, entry.value)
        if (selected) insertAddress(inventory.db, selected)
        if (entry.key[1] === "cache-files" && entry.key.length === 4) {
          const file = Publication.File.parse(entry.value)
          if (file.fileID !== entry.key[3] || file.fileID !== hash(file.path))
            fail("has an inconsistent cached file index")
          inventory.db
            .prepare("INSERT INTO files(cacheID,id,body) VALUES(?,?,?)")
            .run(Hash.parse(entry.key[2]), file.fileID, JSON.stringify(file))
        }
      }
      validateActive(inventory.db)
      target = await TransactionalStore.open({
        backend: "sqlite",
        namespace: "knowledge-native",
        filename: path.join(inventory.directory, "segment.sqlite"),
      })
      const handle = { store: target, artifactDirectory: path.join(inventory.directory, "artifacts") }
      const write = <T>(body: () => Promise<T>) => Storage.provide(handle, body)
      let releases = 0
      let count = 0
      let bytes = 0
      using caches = inventory.db.prepare<{ id: string; body: string }, []>("SELECT id,body FROM caches ORDER BY id")
      for (const row of caches.iterate()) {
        assert()
        const cached = Active.CachedRelease.parse(JSON.parse(row.body))
        if (
          cached.release.orgID !== identity.identity.orgID ||
          cached.directory !==
            (await KnowledgeCache.directory(RuntimeContext.current().host.root, row.id, cached.release))
        )
          fail("has a cache outside its selected Home")
        await KnowledgeCache.verify(cached.directory, cached.release, files(inventory.db, row.id), input.signal)
        await write(() => Storage.write(cacheKey(row.id), cached))
        for await (const file of files(inventory.db, row.id)) {
          assert()
          await write(async () => {
            using prepared = await Storage.prepareBinaryStream(
              byteKey(row.id, file.fileID),
              KnowledgeCache.stream(cached.directory, file, input.signal),
              { signal: input.signal },
            )
            await Storage.transaction(async () => {
              await Storage.publishPreparedBinary(prepared)
              await Storage.write(fileKey(row.id, file.fileID), file)
            })
          })
          count = Count.parse(count + 1)
          bytes = Count.parse(bytes + file.bytes)
        }
        releases++
      }
      using addresses = inventory.db.prepare<{ body: string }, []>("SELECT body FROM addresses ORDER BY key")
      let addressCount = 0
      for (const row of addresses.iterate()) {
        const selected = Address.parse(JSON.parse(row.body))
        await write(() => Storage.write(addressKey(selected.key), selected))
        addressCount++
      }
      const manifest = Manifest.parse({
        format: "synergy-organization-knowledge-native",
        version: 1,
        source: source.namespace,
        identity,
        releases,
        addresses: addressCount,
        files: count,
        bytes,
      })
      await write(() => Storage.write(rootKey, manifest))
      const namespace = await write(() =>
        StorageCheckpoint.exportArchive({
          directory: input.directory,
          archiveID: "knowledge-native",
          namespaceID: source.namespace.namespaceID,
          buildVersion: source.namespace.buildVersion,
          keys: input.keys,
          signal: input.signal,
          protect: () => true,
        }),
      )
      published = true
      await NativeNamespaceIdentity.verify(proof)
      await frozen()
      complete = true
      return { directory: input.directory, namespace }
    } finally {
      await target?.close()
      await inventory.close()
      if (published && !complete) await fs.rm(input.directory, { recursive: true, force: true })
    }
  }
  export interface Restored {
    readonly manifest: Readonly<Manifest>
    relocate(tx: StoreTransaction): Promise<void>
    assertCurrent(): void
  }
  export async function withRestored<T>(
    input: {
      directory: string
      expected: StorageCheckpoint.Manifest
      source: StorageCheckpoint.Manifest
      keys: VaultKeyProvider
      signal?: AbortSignal
    },
    body: (prepared: Restored) => Promise<T>,
  ): Promise<T> {
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const primary = runtime.storage
    const root = runtime.host.root
    const home = runtime.host.home
    const store = handle.store
    const artifactDirectory = handle.artifactDirectory
    const objects = handle.artifactObjects
    const objectConfig = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    const writer = await ServerProcessLock.currentOwnership()
    let active = true
    const assert = () => {
      signal?.throwIfAborted()
      const current = Storage.current()
      if (
        !active ||
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        primary?.store !== store ||
        primary.artifactDirectory !== artifactDirectory ||
        primary.artifactObjects !== objects ||
        runtime.host.root !== root ||
        runtime.host.home !== home ||
        current.store !== store ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== objects ||
        objects?.blobs !== objectConfig?.blobs ||
        objects?.writerID !== objectConfig?.writerID ||
        objects?.now !== objectConfig?.now
      )
        fail("requires its original target callback and Store")
      ServerProcessLock.assertCurrent(writer)
    }
    const inventory = await index()
    try {
      let manifest: Manifest | undefined
      for await (const entry of StorageCheckpoint.entries({ directory, expected, keys, signal })) {
        assert()
        if (entry.type === "record" && same(entry.key, rootKey) && !manifest) {
          manifest = Manifest.parse(entry.value)
          continue
        }
        const key = entry.type === "record" || entry.type === "artifact" ? entry.key : []
        if (key[0] !== "knowledge-native") fail("contains an unsupported record")
        if (entry.type === "record" && key.length === 3 && key[1] === "cache") {
          const cached = Active.CachedRelease.parse(entry.value)
          inventory.db.prepare("INSERT INTO caches VALUES(?,?)").run(Hash.parse(key[2]), JSON.stringify(cached))
          continue
        }
        if (entry.type === "record" && key.length === 3 && key[1] === "address") {
          const selected = Address.parse(entry.value)
          if (!same(address(selected.key, selected.value), selected) || !same(addressKey(selected.key), key))
            fail("contains a foreign relocation address")
          inventory.db
            .prepare("INSERT INTO addresses VALUES(?,?,?)")
            .run(JSON.stringify(selected.key), selected.cacheID, JSON.stringify(selected))
          continue
        }
        if (
          (entry.type === "record" || entry.type === "artifact") &&
          key.length === 4 &&
          ["file", "bytes"].includes(key[1]!)
        ) {
          const cacheID = Hash.parse(key[2])
          const id = Hash.parse(key[3])
          if (entry.type === "record" && key[1] === "file") {
            const file = Publication.File.parse(entry.value)
            if (file.fileID !== id || file.fileID !== hash(file.path)) fail("contains an inconsistent file identity")
            inventory.db
              .prepare(
                "INSERT INTO files(cacheID,id,body) VALUES(?,?,?) ON CONFLICT(cacheID,id) DO UPDATE SET body=excluded.body",
              )
              .run(cacheID, id, JSON.stringify(file))
            continue
          }
          if (entry.type === "artifact" && key[1] === "bytes") {
            inventory.db
              .prepare(
                "INSERT INTO files(cacheID,id,body,location) VALUES(?,?,?,?) ON CONFLICT(cacheID,id) DO UPDATE SET location=excluded.location",
              )
              .run(cacheID, id, "null", JSON.stringify(entry.location))
            continue
          }
        }
        fail("contains an unsupported record")
      }
      if (
        !manifest ||
        !same(manifest.source, source) ||
        manifest.identity.owner !== "organization-runtime" ||
        manifest.identity.identity.kind !== "hosted"
      )
        fail("belongs to another namespace checkpoint")
      using references = inventory.db.prepare<{ body: string }, []>("SELECT body FROM addresses ORDER BY key")
      using cacheReference = inventory.db.prepare<{ body: string }, [string]>("SELECT body FROM caches WHERE id=?")
      for (const row of references.iterate()) {
        const selected = Address.parse(JSON.parse(row.body))
        const cache = cacheReference.get(selected.cacheID)
        if (!cache || !same(JSON.parse(cache.body), selected.value)) fail("has an incomplete relocation reference")
      }
      if (
        inventory.db
          .prepare("SELECT c.id FROM caches c WHERE NOT EXISTS(SELECT 1 FROM addresses a WHERE a.cacheID=c.id) LIMIT 1")
          .get()
      )
        fail("contains an unreferenced cache")
      using declaredCaches = inventory.db.prepare<{ body: string }, []>("SELECT body FROM caches ORDER BY id")
      for (const row of declaredCaches.iterate())
        KnowledgeCache.leaf(Active.CachedRelease.parse(JSON.parse(row.body)).release)
      let releases = 0
      let fileCount = 0
      let bytes = 0
      const canonicalRoot = await fs.realpath(root)
      using caches = inventory.db.prepare<{ id: string; body: string }, []>("SELECT id,body FROM caches ORDER BY id")
      using locations = inventory.db.prepare<{ body: string; location: string | null }, [string]>(
        "SELECT body,location FROM files WHERE cacheID=? ORDER BY id COLLATE BINARY",
      )
      for (const row of caches.iterate()) {
        assert()
        const cached = Active.CachedRelease.parse(JSON.parse(row.body))
        if (cached.release.orgID !== manifest.identity.identity.orgID) fail("contains a foreign release")
        const destination = await KnowledgeCache.directory(runtime.host.root, row.id, cached.release)
        const parent = await KnowledgeCache.privateDirectory(runtime.host.root, path.dirname(destination))
        const exists = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        if (!exists) {
          const temporary = await fs.mkdtemp(path.join(parent, ".restore-"))
          const staged = path.join(temporary, KnowledgeCache.leaf(cached.release))
          await fs.mkdir(staged, { mode: 0o700 })
          try {
            for (const stored of locations.iterate(row.id)) {
              assert()
              const file = Publication.File.parse(JSON.parse(stored.body))
              const location =
                stored.location &&
                z.strictObject({ size: Count, sha256: Hash }).passthrough().parse(JSON.parse(stored.location))
              if (!location || location.size !== file.bytes || location.sha256 !== file.sha256)
                fail("has missing or changed knowledge bytes")
              const filename = path.resolve(staged, Publication.Path.parse(file.path))
              await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
              const output = await fs.open(filename, "wx", 0o600)
              try {
                for await (const chunk of StorageCheckpoint.streamArtifact({ directory, location, signal })) {
                  assert()
                  await output.writeFile(chunk)
                }
                await output.sync()
              } finally {
                await output.close()
              }
            }
            await KnowledgeCache.verify(staged, cached.release, files(inventory.db, row.id), signal)
            assert()
            await fs.rename(staged, destination)
          } finally {
            await fs.rm(temporary, { recursive: true, force: true })
          }
        }
        await KnowledgeCache.verify(destination, cached.release, files(inventory.db, row.id), signal)
        for await (const file of files(inventory.db, row.id)) {
          fileCount++
          bytes = Count.parse(bytes + file.bytes)
        }
        releases++
      }
      using extra = inventory.db.prepare(
        "SELECT f.id FROM files f LEFT JOIN caches c ON c.id=f.cacheID WHERE c.id IS NULL OR f.body='null' OR f.location IS NULL LIMIT 1",
      )
      if (extra.get()) fail("contains an undeclared or incomplete file")
      const addressCount = inventory.db.prepare<{ count: number }, []>("SELECT count(*) AS count FROM addresses").get()!
        .count
      if (
        manifest.releases !== releases ||
        manifest.files !== fileCount ||
        manifest.bytes !== bytes ||
        manifest.addresses !== addressCount
      )
        fail("has an incomplete segment inventory")
      const expectedAddressCount = manifest.addresses
      const prepared: Restored = {
        manifest,
        assertCurrent: assert,
        async relocate(tx) {
          const check = () => {
            assert()
            store.assertWriteTransaction(tx)
          }
          const relocated = (selected: Address) => ({
            ...selected.value,
            directory: path.join(
              canonicalRoot,
              "data",
              "organization-knowledge",
              "releases",
              selected.cacheID,
              KnowledgeCache.leaf(selected.value.release),
            ),
          })
          check()
          using lookup = inventory.db.prepare<{ body: string }, [string]>("SELECT body FROM addresses WHERE key=?")
          let covered = 0
          for (const prefix of [
            ["organization-knowledge", "cache"],
            ["organization-knowledge", "active-manifests"],
          ]) {
            let after: string[] | undefined
            for (;;) {
              const page = await tx.query({ prefix, after, limit: 128 })
              check()
              for (const row of page) {
                if (prefix[1] === "active-manifests" && row.key[6] !== "releases") continue
                const actual = address(row.key, row.value)
                const expected = lookup.get(JSON.stringify(row.key))
                if (!actual || !expected) fail("has incomplete canonical reference coverage")
                const selected = Address.parse(JSON.parse(expected.body))
                if (!same(actual.value, selected.value) && !same(actual.value, relocated(selected)))
                  fail("cannot replace an unrelated cached reference")
                covered = Count.parse(covered + 1)
              }
              if (page.length < 128) break
              after = page.at(-1)!.key
            }
          }
          if (covered !== expectedAddressCount) fail("has incomplete canonical reference coverage")
          using addresses = inventory.db.prepare<{ body: string }, []>("SELECT body FROM addresses ORDER BY key")
          for (const row of addresses.iterate()) {
            const selected = Address.parse(JSON.parse(row.body))
            const cached = inventory.db
              .prepare<{ body: string }, [string]>("SELECT body FROM caches WHERE id=?")
              .get(selected.cacheID)
            if (!cached || !same(JSON.parse(cached.body), selected.value))
              fail("has an incomplete relocation reference")
            const restored = relocated(selected)
            const [raw] = await tx.readMany([selected.key])
            check()
            const current = Active.CachedRelease.parse(raw)
            if (!same(current, selected.value) && !same(current, restored))
              fail("cannot replace an unrelated cached reference")
            await tx.write(selected.key, restored)
            check()
          }
          check()
        },
      }
      const result = await body(prepared)
      assert()
      return result
    } finally {
      active = false
      await inventory.close()
    }
  }
}
