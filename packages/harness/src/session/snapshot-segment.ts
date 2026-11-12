import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { StorageCheckpoint } from "../storage/checkpoint"
import { TransactionalStore } from "../storage/transactional-store"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import type { VaultKeyProvider } from "../secrets/encrypted-store"
import type { SnapshotCheckpoint } from "./snapshot-checkpoint"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotTransfer } from "./snapshot-transfer"
import { StoredSnapshotContent as Content } from "./stored-snapshot-content"
import { RuntimeContext } from "../lifecycle/context"

export namespace SnapshotSegment {
  const Count = z.number().int().nonnegative().safe()
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const headBytes = 1024 * 1024
  const RefName = z.string().regex(/^refs\/[^\s\0]+$/)
  export const Reference = z.strictObject({
    version: z.literal(1),
    name: RefName,
    oid: z.string().regex(SnapshotStore.OID),
    symbolic: RefName.optional(),
  })
  const Head = z
    .string()
    .max(headBytes)
    .refine(
      (value) => /^ref: refs\/[^\s\0]+$/.test(value.trim()) || /^[a-f0-9]{40}$/.test(value.trim()),
      "Invalid Snapshot HEAD",
    )
  export const Repository = z
    .strictObject({
      version: z.literal(1),
      id: Hash,
      scopeID: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      layout: z.enum(["native", "legacy", "stored"]),
      name: z.string().regex(/^(?:[a-zA-Z0-9_-]+|\.shared\.old)$/),
      head: Head,
      roots: Count,
      refs: Count,
      packs: Count,
    })
    .refine(
      (value) =>
        value.layout === "native" ? value.name === "store" : value.layout !== "stored" || value.name !== ".shared.old",
      "Snapshot repository layout has an incompatible identity",
    )
  export type Repository = z.infer<typeof Repository>
  export const Manifest = z.strictObject({
    format: z.literal("synergy-snapshot-segment"),
    version: z.literal(1),
    namespaceID: StorageCheckpoint.Manifest.shape.namespaceID,
    namespaceRecords: StorageCheckpoint.Manifest.shape.records,
    repositories: Count,
    roots: Count,
    refs: Count,
    packs: Count,
  })
  export type Manifest = z.infer<typeof Manifest>
  export interface Source {
    archive: SnapshotCheckpoint.Archive
    owners(): AsyncIterable<SnapshotCheckpoint.Owner>
    roots(owner: SnapshotCheckpoint.Owner): AsyncIterable<string>
    describe(owner: SnapshotCheckpoint.Owner): ReturnType<SnapshotCheckpoint.Capture["describe"]>
    assertCurrent(): void
    signal: AbortSignal
    keys: VaultKeyProvider
  }
  const repositoryKey = (id: string) => ["snapshot-segment", "repositories", id]
  const rootKey = (id: string, root: string) => [...repositoryKey(id), "roots", root]
  const refKey = (id: string, name: string) => [...repositoryKey(id), "refs", name]
  const packKey = (id: string, ordinal: number) => [...repositoryKey(id), "packs", String(ordinal).padStart(16, "0")]

  export interface Restored {
    readonly manifest: Readonly<Manifest>
    readonly signal: AbortSignal
    assertCurrent(): void
    repositories(): AsyncGenerator<{ info: Readonly<Repository>; repository: string }>
  }
  export async function withRestored<T>(
    input: {
      directory: string
      expected: StorageCheckpoint.Manifest
      source: StorageCheckpoint.Manifest
      keys: VaultKeyProvider
      signal: AbortSignal
    },
    body: (prepared: Restored) => Promise<T>,
  ) {
    const runtime = RuntimeContext.current()
    const store = Storage.current().store
    const artifactDirectory = Storage.current().artifactDirectory
    const parent = path.join(Global.Path.cache, "snapshot-segment-restores")
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    const directory = await fs.mkdtemp(path.join(parent, "prepare-"))
    initializeSqliteEngine()
    const database = new Database(path.join(directory, "index.sqlite"))
    let active = true
    const readers = new Set<{ reader?: AsyncGenerator<{ info: Repository; repository: string }> }>()
    function assertCurrent() {
      input.signal.throwIfAborted()
      if (
        !active ||
        RuntimeContext.current() !== runtime ||
        Storage.current().store !== store ||
        Storage.current().artifactDirectory !== artifactDirectory
      )
        throw new SnapshotStore.StorageError("Restored Snapshot segment is closed or belongs to another Runtime")
    }
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE repositories(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE roots(repository TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(repository,root)); CREATE TABLE refs(repository TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(repository,name)); CREATE TABLE packs(repository TEXT NOT NULL,ordinal INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(repository,ordinal))",
      )
      using addRepository = database.prepare("INSERT INTO repositories VALUES (?,?)")
      using addRoot = database.prepare("INSERT INTO roots VALUES (?,?)")
      using addRef = database.prepare("INSERT INTO refs VALUES (?,?,?)")
      using addPack = database.prepare("INSERT INTO packs VALUES (?,?,?,?)")
      let manifest: Manifest | undefined
      for await (const entry of StorageCheckpoint.entries({
        directory: input.directory,
        expected: input.expected,
        keys: input.keys,
        signal: input.signal,
      })) {
        assertCurrent()
        if (entry.type !== "record" && entry.type !== "artifact")
          throw new SnapshotStore.StorageError("Snapshot segment contains an unrelated native effect")
        if (entry.key[0] !== "snapshot-segment")
          throw new SnapshotStore.StorageError("Snapshot segment contains an unrelated native entry")
        const key = entry.key
        if (entry.type === "record" && key.length === 2 && key[1] === "manifest") {
          if (manifest) throw new SnapshotStore.StorageError("Snapshot segment has duplicate manifests")
          manifest = Manifest.parse(entry.value)
          continue
        }
        if (key[1] !== "repositories" || !Hash.safeParse(key[2]).success)
          throw new SnapshotStore.StorageError("Snapshot segment has an unknown owning key")
        if (entry.type === "record" && key.length === 4 && key[3] === "info") {
          const value = Repository.parse(entry.value)
          if (
            value.id !== key[2] ||
            value.id !==
              createHash("sha256")
                .update(JSON.stringify([value.scopeID, value.layout, value.name]))
                .digest("hex")
          )
            throw new SnapshotStore.StorageError("Snapshot repository identity differs from its metadata")
          addRepository.run(value.id, JSON.stringify(value))
        } else if (entry.type === "record" && key.length === 5 && key[3] === "roots") {
          const value = z
            .strictObject({ version: z.literal(1), root: z.string().regex(SnapshotStore.OID) })
            .parse(entry.value)
          if (value.root !== key[4]) throw new SnapshotStore.StorageError("Snapshot root key differs from its record")
          addRoot.run(key[2], value.root)
        } else if (entry.type === "record" && key.length === 5 && key[3] === "refs") {
          const value = Reference.parse(entry.value)
          if (value.name !== key[4])
            throw new SnapshotStore.StorageError("Snapshot reference key differs from its record")
          addRef.run(key[2], value.name, JSON.stringify(value))
        } else if (entry.type === "artifact" && key.length === 6 && key[3] === "packs" && key[5] === "data") {
          const ordinal = Count.parse(Number(key[4]))
          if (String(ordinal).padStart(16, "0") !== key[4])
            throw new SnapshotStore.StorageError("Snapshot pack ordinal is invalid")
          addPack.run(key[2], ordinal, entry.location.sha256, entry.location.size)
        } else throw new SnapshotStore.StorageError("Snapshot segment contains an unknown record")
      }
      assertCurrent()
      const source = StorageCheckpoint.Manifest.parse(input.source)
      if (
        !manifest ||
        manifest.namespaceID !== source.namespaceID ||
        JSON.stringify(manifest.namespaceRecords) !== JSON.stringify(source.records)
      )
        throw new SnapshotStore.StorageError("Snapshot segment belongs to another namespace checkpoint")
      using foreign = database.prepare(
        "SELECT 1 FROM (SELECT repository FROM roots UNION SELECT repository FROM refs UNION SELECT repository FROM packs) x LEFT JOIN repositories r ON r.id=x.repository WHERE r.id IS NULL LIMIT 1",
      )
      if (foreign.get())
        throw new SnapshotStore.StorageError("Snapshot segment has content without an owning repository")
      using repositories = database.prepare<{ id: string; body: string }, []>(
        "SELECT id,body FROM repositories ORDER BY id",
      )
      using roots = database.prepare<{ root: string }, [string]>(
        "SELECT root FROM roots WHERE repository=? ORDER BY root",
      )
      using refs = database.prepare<{ body: string }, [string]>(
        "SELECT body FROM refs WHERE repository=? ORDER BY name",
      )
      using packs = database.prepare<{ ordinal: number; sha256: string; bytes: number }, [string]>(
        "SELECT ordinal,sha256,bytes FROM packs WHERE repository=? ORDER BY ordinal",
      )
      const totals = { repositories: 0, roots: 0, refs: 0, packs: 0 }
      for (const row of repositories.iterate()) {
        assertCurrent()
        const info = Repository.parse(JSON.parse(row.body))
        const repository = path.join(directory, row.id, "store.git")
        await SnapshotStore.initializeBareRepository(repository, "durable", { emptyTemplate: true })
        let packCount = 0
        for (const pack of packs.iterate(row.id)) {
          assertCurrent()
          if (pack.ordinal !== packCount++) throw new SnapshotStore.StorageError("Snapshot pack sequence is incomplete")
          const filename = path.join(directory, `${row.id}-${pack.ordinal}.pack`)
          const output = await fs.open(filename, "wx", 0o600)
          try {
            for await (const bytes of StorageCheckpoint.streamArtifact({
              directory: input.directory,
              location: { sha256: pack.sha256, size: pack.bytes },
              signal: input.signal,
            }))
              await output.writeFile(bytes)
            await output.sync()
          } finally {
            await output.close()
          }
          await SnapshotGit.checked(repository, ["index-pack", "--stdin", "--strict"], {
            input: filename,
            signal: input.signal,
          })
          await fs.rm(filename)
        }
        const updates = path.join(directory, `${row.id}.refs`)
        const writer = Bun.file(updates).writer()
        let refCount = 0
        try {
          for (const ref of refs.iterate(row.id)) {
            const value = Reference.parse(JSON.parse(ref.body))
            if (!value.symbolic) {
              writer.write(`update ${value.name} ${value.oid}\n`)
              if (refCount % 128 === 0) await writer.flush()
            }
            refCount++
          }
        } finally {
          await writer.end()
        }
        await SnapshotGit.checked(repository, ["update-ref", "--stdin"], { input: updates, signal: input.signal })
        for (const ref of refs.iterate(row.id)) {
          const value = Reference.parse(JSON.parse(ref.body))
          if (value.symbolic)
            await SnapshotGit.checked(repository, ["symbolic-ref", value.name, value.symbolic], {
              signal: input.signal,
            })
        }
        if (info.head.trim().startsWith("ref: "))
          await SnapshotGit.checked(repository, ["check-ref-format", info.head.trim().slice(5)], {
            signal: input.signal,
          })
        await fs.writeFile(path.join(repository, "HEAD"), info.head, { mode: 0o600 })
        await SnapshotGit.checked(repository, ["fsck", "--full", "--no-reflogs"], { signal: input.signal })
        let rootCount = 0
        for (const { root } of roots.iterate(row.id)) {
          assertCurrent()
          if ((await SnapshotGit.checked(repository, ["cat-file", "-t", root], { signal: input.signal })) !== "tree")
            throw new SnapshotStore.StorageError("Restored Snapshot segment omits a captured tree")
          rootCount++
        }
        for (const ref of refs.iterate(row.id)) {
          const value = Reference.parse(JSON.parse(ref.body))
          if (
            (await SnapshotGit.checked(repository, ["rev-parse", "--verify", value.name], { signal: input.signal })) !==
            value.oid
          )
            throw new SnapshotStore.StorageError("Restored Snapshot reference differs from its captured value")
        }
        let actualRefs = 0
        for await (const _reference of SnapshotGit.lines(repository, ["for-each-ref", "--format=%(refname)"], {
          signal: input.signal,
        }))
          actualRefs++
        if (actualRefs !== refCount)
          throw new SnapshotStore.StorageError("Restored Snapshot contains an unrelated native reference")
        if (packCount !== info.packs || refCount !== info.refs || rootCount !== info.roots)
          throw new SnapshotStore.StorageError("Restored Snapshot inventory differs from its declared counts")
        totals.repositories++
        totals.roots += rootCount
        totals.refs += refCount
        totals.packs += packCount
      }
      for (const field of ["repositories", "roots", "refs", "packs"] as const)
        if (totals[field] !== manifest[field])
          throw new SnapshotStore.StorageError("Snapshot segment footer count mismatch")
      const port: Restored = {
        manifest: Object.freeze({ ...manifest, namespaceRecords: Object.freeze({ ...manifest.namespaceRecords }) }),
        signal: input.signal,
        assertCurrent,
        repositories() {
          const held: { reader?: AsyncGenerator<{ info: Repository; repository: string }> } = {}
          const reader = (async function* () {
            assertCurrent()
            readers.add(held)
            let completed = false
            let failed = false
            try {
              for (const row of repositories.iterate()) {
                assertCurrent()
                yield {
                  info: Object.freeze(Repository.parse(JSON.parse(row.body))),
                  repository: path.join(directory, row.id, "store.git"),
                }
                assertCurrent()
              }
              completed = true
            } catch (error) {
              failed = true
              throw error
            } finally {
              readers.delete(held)
              if (!completed && !failed)
                throw new SnapshotStore.StorageError("Restored Snapshot inventory must complete")
            }
          })()
          held.reader = reader
          return reader
        },
      }
      try {
        const result = await body(port)
        assertCurrent()
        if (readers.size) throw new SnapshotStore.StorageError("Restored Snapshot segment has unfinished readers")
        return result
      } finally {
        active = false
        await Promise.allSettled([...readers].map((held) => held.reader?.return(undefined)))
      }
    } finally {
      active = false
      await Promise.allSettled([...readers].map((held) => held.reader?.return(undefined)))
      database.close(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }

  export async function exportArchive(source: Source, input: { directory: string }) {
    source.assertCurrent()
    const sourceHandle = Storage.current()
    const parent = path.join(Global.Path.cache, "snapshot-segments")
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    const temporary = await fs.mkdtemp(path.join(parent, "capture-"))
    initializeSqliteEngine()
    const database = new Database(path.join(temporary, "capture.sqlite"))
    let target: TransactionalStore | undefined
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE manifests(scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,legacy INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id,root,legacy)); CREATE TABLE artifacts(key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL); CREATE TABLE fences(scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE formats(scope TEXT PRIMARY KEY,external INTEGER NOT NULL); CREATE TABLE repositories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,layout TEXT NOT NULL,name TEXT NOT NULL,source TEXT,UNIQUE(scope,layout,name)); CREATE TABLE roots(repository TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(repository,root))",
      )
      using insertManifest = database.prepare("INSERT INTO manifests VALUES (?,?,?,?,?)")
      using insertArtifact = database.prepare("INSERT INTO artifacts VALUES (?,?,?)")
      using insertFence = database.prepare("INSERT INTO fences VALUES (?,?,?)")
      using insertFormat = database.prepare("INSERT INTO formats VALUES (?,?)")
      for await (const entry of StorageCheckpoint.entries({
        directory: source.archive.directory,
        keys: source.keys,
        expected: source.archive.namespace,
        signal: source.signal,
      })) {
        source.assertCurrent()
        if (entry.type === "artifact") {
          if (
            (entry.key[0] === "snapshot-v2" && entry.key[2] === "content") ||
            (entry.key[0] === "sessions" && entry.key[3] === "snapshot_content")
          )
            insertArtifact.run(JSON.stringify(entry.key), entry.location.sha256, entry.location.size)
          continue
        }
        if (entry.type !== "record") continue
        if (entry.key.length === 3 && entry.key[0] === "snapshot-v2" && entry.key[2] === "repository") {
          const format = SnapshotStore.RepositoryFormat.parse(entry.value)
          insertFormat.run(SnapshotStore.component(entry.key[1]), Number(format.content === "external-v1"))
          continue
        }
        const header = Content.headerIdentity(entry.key)
        const fence = Content.fenceIdentity(entry.key)
        if (header) {
          const manifest = header.legacy ? Content.LegacyManifest.parse(entry.value) : Content.Header.parse(entry.value)
          if (manifest.root !== header.root)
            throw new SnapshotStore.StorageError("Captured Snapshot header has another root")
          insertManifest.run(
            header.scopeID,
            header.retentionID,
            header.root,
            Number(header.legacy),
            JSON.stringify(manifest),
          )
        } else if (fence) {
          Content.LegacyFence.parse(entry.value)
          insertFence.run(fence.scopeID, fence.retentionID, fence.root ?? "all")
        }
      }
      source.assertCurrent()
      using insertRepository = database.prepare("INSERT OR IGNORE INTO repositories VALUES (?,?,?,?,?)")
      using insertRoot = database.prepare("INSERT OR IGNORE INTO roots VALUES (?,?)")
      const addRepository = (scopeID: string, layout: Repository["layout"], name: string, location?: string) => {
        const id = createHash("sha256")
          .update(JSON.stringify([scopeID, layout, name]))
          .digest("hex")
        Repository.parse({
          version: 1,
          id,
          scopeID,
          layout,
          name,
          head: "ref: refs/heads/master\n",
          roots: 0,
          refs: 0,
          packs: 0,
        })
        insertRepository.run(id, scopeID, layout, name, location ?? null)
        return id
      }
      for await (const owner of source.owners()) {
        source.assertCurrent()
        const captured = source.describe(owner)
        if (captured.owner.backend === "deleted") continue
        const name =
          captured.layout === "native"
            ? "store"
            : captured.layout === "legacy"
              ? captured.sessionID
              : captured.owner.retentionID
        const location =
          captured.layout === "native"
            ? SnapshotStore.repository(captured.scopeID)
            : captured.layout === "legacy"
              ? SnapshotStore.legacyRepository(captured.scopeID, captured.sessionID)
              : undefined
        const id = addRepository(captured.scopeID, captured.layout, name, location)
        for await (const root of source.roots(owner)) insertRoot.run(id, root)
      }
      async function physical(directory: string, layout: "native" | "legacy") {
        using format = database.prepare<{ external: number }, [string]>("SELECT external FROM formats WHERE scope=?")
        const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return
          throw error
        })
        if (!info) return
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new SnapshotStore.StorageError("Snapshot repositories require ordinary directories")
        for await (const scope of await fs.opendir(directory)) {
          source.assertCurrent()
          if (!scope.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(scope.name)) continue
          const scopeDirectory = path.join(directory, scope.name)
          if (layout === "native") {
            if (format.get(scope.name)?.external) continue
            const location = path.join(scopeDirectory, "store.git")
            if (await Bun.file(path.join(location, "HEAD")).exists())
              addRepository(scope.name, layout, "store", location)
          } else
            for await (const entry of await fs.opendir(scopeDirectory)) {
              if (!entry.isDirectory() || !/^(?:[a-zA-Z0-9_-]+|\.shared\.old)$/.test(entry.name)) continue
              const location = path.join(scopeDirectory, entry.name)
              if (await Bun.file(path.join(location, "HEAD")).exists())
                addRepository(scope.name, layout, entry.name, location)
            }
        }
      }
      await physical(path.join(sourceHandle.artifactDirectory, "snapshot-v2"), "native")
      await physical(path.join(sourceHandle.artifactDirectory, "snapshot"), "legacy")
      target = await TransactionalStore.open({
        backend: "sqlite",
        filename: path.join(temporary, "segment.sqlite"),
        namespace: "snapshot-segment",
      })
      const targetHandle = { store: target, artifactDirectory: path.join(temporary, "artifacts") }
      const write = <T>(body: () => Promise<T>) => Storage.provide(targetHandle, body)
      using artifact = database.prepare<{ sha256: string; bytes: number }, [string]>(
        "SELECT sha256,bytes FROM artifacts WHERE key=?",
      )
      const artifactStream = (key: string[], expected?: { bytes: number; sha256: string }) => {
        source.assertCurrent()
        const value = artifact.get(JSON.stringify(key))
        if (!value || (expected && (expected.bytes !== value.bytes || expected.sha256 !== value.sha256)))
          throw new SnapshotStore.StorageError("Captured Snapshot artifact is missing or differs from its descriptor")
        return StorageCheckpoint.streamArtifact({
          directory: source.archive.directory,
          location: { sha256: value.sha256, size: value.bytes },
          signal: source.signal,
        })
      }
      using selectedManifest = database.prepare<{ body: string; legacy: number }, [string, string, string]>(
        "SELECT body,legacy FROM manifests m WHERE scope=? AND id=? AND root=? AND (legacy=0 OR NOT EXISTS(SELECT 1 FROM fences f WHERE f.scope=m.scope AND f.id=m.id AND (f.root=m.root OR f.root='all'))) ORDER BY legacy LIMIT 1",
      )
      using repositories = database.prepare<
        { id: string; scope: string; layout: Repository["layout"]; name: string; source: string | null },
        []
      >("SELECT * FROM repositories ORDER BY scope,layout,name")
      using roots = database.prepare<{ root: string }, [string]>(
        "SELECT root FROM roots WHERE repository=? ORDER BY root",
      )
      const totals = { repositories: 0, roots: 0, refs: 0, packs: 0 }
      for (const row of repositories.iterate()) {
        source.assertCurrent()
        const directory = path.join(temporary, row.id)
        const repository = path.join(directory, "store.git")
        await SnapshotStore.initializeBareRepository(repository, "durable", { emptyTemplate: true })
        if (row.layout === "stored") {
          for (const { root } of roots.iterate(row.id)) {
            const selected = selectedManifest.get(row.scope, row.name, root)
            if (!selected)
              throw new SnapshotStore.StorageError("Captured stored Snapshot root has no selected manifest")
            const manifest = selected.legacy
              ? Content.LegacyManifest.parse(JSON.parse(selected.body))
              : Content.Header.parse(JSON.parse(selected.body))
            let file: Awaited<ReturnType<typeof fs.open>> | undefined
            let previous = -1
            const finish = async () => {
              if (!file) return
              await file.sync()
              await file.close()
              file = undefined
              await SnapshotGit.checked(repository, ["index-pack", "--stdin", "--strict"], {
                input: path.join(directory, `${previous}.pack`),
                signal: source.signal,
              })
            }
            try {
              for await (const ref of Content.references({
                scopeID: row.scope,
                retentionID: row.name,
                manifest,
                signal: source.signal,
                async readPage(key, maximum) {
                  const blocks: Uint8Array[] = []
                  let bytes = 0
                  for await (const block of artifactStream(key)) {
                    bytes += block.length
                    if (bytes > maximum)
                      throw new SnapshotStore.StorageError("Captured Snapshot page exceeds its format")
                    blocks.push(block)
                  }
                  return Buffer.concat(blocks)
                },
              })) {
                source.assertCurrent()
                if (previous !== ref.pack) {
                  await finish()
                  previous = ref.pack
                  file = await fs.open(path.join(directory, `${previous}.pack`), "w", 0o600)
                }
                const output = file
                if (!output) throw new SnapshotStore.StorageError("Captured Snapshot pack has no native writer")
                for await (const block of artifactStream(ref.key, ref)) await output.writeFile(block)
              }
              await finish()
            } finally {
              await file?.close()
            }
            if ((await SnapshotGit.checked(repository, ["cat-file", "-t", root], { signal: source.signal })) !== "tree")
              throw new SnapshotStore.StorageError("Captured Snapshot pack does not contain its root")
            for await (const oid of SnapshotGit.lines(
              repository,
              ["rev-list", "--objects", "--missing=print", "--no-object-names", root, "--"],
              { signal: source.signal },
            ))
              if (oid.startsWith("?"))
                throw new SnapshotStore.StorageError("Captured stored Snapshot graph is incomplete")
            await SnapshotGit.checked(repository, ["update-ref", SnapshotStore.reference(row.name, root), root], {
              signal: source.signal,
            })
          }
        } else {
          const sourceRepository = row.source
          if (!sourceRepository)
            throw new SnapshotStore.StorageError("Captured native repository has no physical owner")
          const info = await fs.lstat(sourceRepository)
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new SnapshotStore.StorageError("Snapshot repository cannot be a symbolic link")
          await SnapshotGit.checked(sourceRepository, ["fsck", "--full", "--no-reflogs"], { signal: source.signal })
          await using catalog = await SnapshotTransfer.Catalog.create(repository, source.signal)
          await catalog.import(sourceRepository, { signal: source.signal, keepToken: "synergy-snapshot-segment" })
        }
        let rootCount = 0
        for (const { root } of roots.iterate(row.id)) {
          source.assertCurrent()
          if ((await SnapshotGit.checked(repository, ["cat-file", "-t", root], { signal: source.signal })) !== "tree")
            throw new SnapshotStore.StorageError("Snapshot segment omits a captured tree")
          await write(() => Storage.write(rootKey(row.id, root), { version: 1, root }))
          rootCount++
        }
        let refs = 0
        const refsFile = path.join(directory, "references")
        const updates = Bun.file(refsFile).writer()
        try {
          for await (const line of SnapshotGit.lines(
            row.source ?? repository,
            ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"],
            { signal: source.signal },
          )) {
            source.assertCurrent()
            const [name, oid, symbolic] = line.split("\0")
            const value = Reference.parse({ version: 1, name, oid, ...(symbolic ? { symbolic } : {}) })
            if (!value.symbolic) {
              updates.write(`update ${value.name} ${value.oid}\n`)
              if (refs % 128 === 0) await updates.flush()
            }
            await write(() => Storage.write(refKey(row.id, name), value))
            refs++
          }
        } finally {
          await updates.end()
        }
        await SnapshotGit.checked(repository, ["update-ref", "--stdin"], { input: refsFile, signal: source.signal })
        await write(async () => {
          for await (const ref of Storage.records({ prefix: [...repositoryKey(row.id), "refs"], limit: 128 })) {
            const value = Reference.parse(ref.value)
            if (value.symbolic)
              await SnapshotGit.checked(repository, ["symbolic-ref", value.name, value.symbolic], {
                signal: source.signal,
              })
          }
        })
        await SnapshotGit.checked(repository, ["fsck", "--full", "--no-reflogs"], { signal: source.signal })
        let packs = 0
        for await (const entry of await fs.opendir(path.join(repository, "objects", "pack"))) {
          if (!entry.isFile() || !/^pack-[a-f0-9]{40}\.pack$/.test(entry.name)) continue
          source.assertCurrent()
          const filename = path.join(repository, "objects", "pack", entry.name)
          await write(async () => {
            const key = packKey(row.id, packs)
            using prepared = await Storage.prepareBinaryStream(
              [...key, "data"],
              (async function* () {
                for await (const bytes of Bun.file(filename).stream()) {
                  source.signal.throwIfAborted()
                  yield bytes
                }
              })(),
              { signal: source.signal },
            )
            await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
          })
          packs++
        }
        const headFile = path.join(row.source ?? repository, "HEAD")
        const headInfo = await fs.lstat(headFile)
        if (!headInfo.isFile() || headInfo.isSymbolicLink() || headInfo.size > headBytes)
          throw new SnapshotStore.StorageError("Snapshot HEAD is not an ordinary native record")
        const head = await fs.readFile(headFile, "utf8")
        const value = Repository.parse({
          version: 1,
          id: row.id,
          scopeID: row.scope,
          layout: row.layout,
          name: row.name,
          head,
          roots: rootCount,
          refs,
          packs,
        })
        await write(() => Storage.write([...repositoryKey(row.id), "info"], value))
        totals.repositories++
        totals.roots += rootCount
        totals.refs += refs
        totals.packs += packs
      }
      source.assertCurrent()
      const manifest = Manifest.parse({
        format: "synergy-snapshot-segment",
        version: 1,
        namespaceID: source.archive.namespace.namespaceID,
        namespaceRecords: source.archive.namespace.records,
        ...totals,
      })
      await write(() => Storage.write(["snapshot-segment", "manifest"], manifest))
      const archive = await write(() =>
        StorageCheckpoint.exportArchive({
          directory: input.directory,
          archiveID: "snapshot-segment",
          namespaceID: source.archive.namespace.namespaceID,
          buildVersion: source.archive.namespace.buildVersion,
          keys: source.keys,
          protect: () => true,
          signal: source.signal,
        }),
      )
      source.assertCurrent()
      return { directory: input.directory, namespace: archive, snapshots: manifest }
    } finally {
      await target?.close()
      database.close(true)
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
