import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Global } from "../global"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StorageCheckpoint } from "../storage/checkpoint"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import { upgradeImportedRecord } from "../migration/import"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotRecords } from "./snapshot-records"
import { StoredSnapshotContent as Content } from "./stored-snapshot-content"
import { SnapshotCaptureAuthority as Authority } from "./snapshot-capture-authority"

export namespace SnapshotCheckpoint {
  export type Owner = Authority.Owner
  export interface Archive {
    readonly directory: string
    readonly namespace: Readonly<StorageCheckpoint.Manifest>
  }
  export interface Capture {
    exportArchive(input: Parameters<typeof StorageCheckpoint.exportArchive>[0]): Promise<Archive>
    owners(archive: Archive): AsyncGenerator<Owner>
    roots(owner: Owner): AsyncGenerator<string>
    describe(owner: Owner): {
      scopeID: string
      sessionID: string
      owner: Readonly<SnapshotStore.Owner>
      layout: "native" | "stored" | "legacy"
      namespace: Readonly<StorageCheckpoint.Manifest>
    }
  }
  const state = RuntimeContext.state(() => ({
    closed: false,
    controller: new AbortController(),
    pending: new Set<Promise<unknown>>(),
  }))

  function fail(message: string): never {
    throw new SnapshotStore.StorageError(message)
  }

  export async function withCapture<T>(
    body: (capture: Capture) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const current = state()
    if (current.closed) fail("Snapshot checkpoint admission is closed")
    const signal = options.signal
      ? AbortSignal.any([current.controller.signal, options.signal])
      : current.controller.signal
    const task = capture(body, signal)
    current.pending.add(task)
    void task.then(
      () => current.pending.delete(task),
      () => current.pending.delete(task),
    )
    return await task
  }

  export async function stop() {
    const current = state()
    current.closed = true
    current.controller.abort(new SnapshotStore.StorageError("Snapshot checkpoint Runtime is closing"))
    await Promise.allSettled(current.pending)
  }

  async function capture<T>(body: (capture: Capture) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (Storage.inTransaction()) fail("Snapshot capture must begin outside a storage transaction")
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const dataRoot = handle.artifactDirectory
    const store = handle.store
    const objects = handle.artifactObjects
    await using lease = await SnapshotLease.acquireHome(dataRoot, { signal })
    signal.throwIfAborted()
    const controller = new AbortController()
    const scopeSignal = AbortSignal.any([signal, controller.signal])
    let active = true
    const pending = new Set<Promise<unknown>>()
    const readers = new Set<{ close?: () => Promise<void> }>()
    const archives = new WeakMap<Archive, Database>()
    const indexes: { database: Database; directory: string }[] = []
    function assertCurrent() {
      if (
        !active ||
        RuntimeContext.current() !== runtime ||
        Storage.current().store !== store ||
        Storage.current().artifactDirectory !== dataRoot ||
        Storage.current().artifactObjects !== objects
      )
        fail("Snapshot capture is closed or belongs to another Runtime")
      scopeSignal.throwIfAborted()
    }
    function read<T>(source: () => AsyncIterable<T>): AsyncGenerator<T> {
      const held: { close?: () => Promise<void> } = {}
      const reader = (async function* () {
        assertCurrent()
        readers.add(held)
        let completed = false
        let failed = false
        try {
          for await (const value of source()) {
            assertCurrent()
            yield value
            assertCurrent()
          }
          completed = true
        } catch (error) {
          failed = true
          throw error
        } finally {
          readers.delete(held)
          if (!completed && !failed && !scopeSignal.aborted) fail("Snapshot capture read is incomplete")
        }
      })()
      held.close = async () => {
        await reader.return(undefined)
      }
      return reader
    }
    function layout(database: Database, scopeID: string, owner: SnapshotStore.Owner): "native" | "stored" | "legacy" {
      if (owner.backend === "legacy") return "legacy"
      using format = database.prepare<{ external: number }, [string]>("SELECT external FROM formats WHERE scope=?")
      return format.get(scopeID)?.external ? "stored" : "native"
    }
    function physicalRoots(
      database: Database,
      scopeID: string,
      sessionID: string,
      owner: SnapshotStore.Owner,
      signal: AbortSignal,
    ) {
      const source = layout(database, scopeID, owner)
      if (source === "stored")
        return async function* () {
          using roots = database.prepare<{ root: string }, [string, string]>(
            "SELECT root FROM roots WHERE scope=? AND id=? ORDER BY root",
          )
          for (const value of roots.iterate(scopeID, owner.retentionID)) {
            assertCurrent()
            yield value.root
            assertCurrent()
          }
        }
      if (source === "legacy")
        return async function* () {
          for await (const line of SnapshotGit.lines(
            SnapshotStore.legacyRepository(scopeID, sessionID),
            ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
            { signal },
          )) {
            assertCurrent()
            const [root, type] = line.split(" ")
            if (!SnapshotStore.OID.test(root)) fail("Captured legacy Snapshot object identity is invalid")
            if (type === "tree") yield root
          }
        }
    }
    async function exported(input: Parameters<Capture["exportArchive"]>[0]): Promise<Archive> {
      assertCurrent()
      const exportSignal = input.signal ? AbortSignal.any([scopeSignal, input.signal]) : scopeSignal
      const namespace = await StorageCheckpoint.exportArchive({ ...input, signal: exportSignal })
      assertCurrent()
      const namespaceProof = Object.freeze({ ...namespace, records: Object.freeze({ ...namespace.records }) })
      const root = path.join(Global.Path.cache, "snapshot-checkpoints")
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      const directory = await fs.mkdtemp(path.join(root, "capture-"))
      initializeSqliteEngine()
      const database = new Database(path.join(directory, "index.sqlite"))
      indexes.push({ database, directory })
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE owners (scope TEXT NOT NULL,id TEXT NOT NULL,backend TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(scope,id)); CREATE TABLE roots (scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,canonical INTEGER NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE fences (scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE parts (scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE observed (scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE formats (scope TEXT PRIMARY KEY,external INTEGER NOT NULL)",
      )
      using ownerInsert = database.prepare("INSERT INTO owners VALUES (?,?,?,?)")
      using rootInsert = database.prepare(
        "INSERT INTO roots VALUES (?,?,?,?) ON CONFLICT(scope,id,root) DO UPDATE SET canonical=MAX(canonical,excluded.canonical)",
      )
      using fenceInsert = database.prepare("INSERT INTO fences VALUES (?,?,?)")
      using partInsert = database.prepare("INSERT OR IGNORE INTO parts VALUES (?,?,?)")
      using formatInsert = database.prepare("INSERT INTO formats VALUES (?,?)")
      for await (const entry of StorageCheckpoint.entries({
        directory: input.directory,
        keys: input.keys,
        expected: namespace,
        signal: exportSignal,
      })) {
        assertCurrent()
        if (entry.type !== "record") continue
        const key = entry.key
        const header = Content.headerIdentity(key)
        const fence = Content.fenceIdentity(key)
        if (key.length === 3 && key[0] === "snapshot-v2" && key[2] === "repository") {
          const format = SnapshotStore.RepositoryFormat.parse(entry.value)
          formatInsert.run(SnapshotStore.component(key[1]), Number(format.content === "external-v1"))
        } else if (key.length === 4 && key[0] === "snapshot-v2" && key[2] === "owners") {
          SnapshotStore.component(key[1])
          SnapshotStore.component(key[3])
          const owner = SnapshotStore.Owner.parse(upgradeImportedRecord(key, entry.value))
          ownerInsert.run(key[1], key[3], owner.backend, JSON.stringify(owner))
        } else if (header) {
          const manifest = header.legacy ? Content.LegacyManifest.parse(entry.value) : Content.Header.parse(entry.value)
          if (manifest.root !== header.root) fail("Captured stored Snapshot root is invalid")
          rootInsert.run(header.scopeID, header.retentionID, header.root, Number(!header.legacy))
        } else if (fence) {
          Content.LegacyFence.parse(entry.value)
          fenceInsert.run(fence.scopeID, fence.retentionID, fence.root ?? "all")
        } else if (key.length === 7 && key[0] === "sessions" && key[3] === "messages" && key[5] === "parts")
          for (const root of SnapshotRecords.partRoots(entry.value)) partInsert.run(key[1], key[2], root)
      }
      assertCurrent()
      database.exec(
        "DELETE FROM roots WHERE canonical=0 AND EXISTS(SELECT 1 FROM fences f WHERE f.scope=roots.scope AND f.id=roots.id AND (f.root='all' OR f.root=roots.root))",
      )
      using ownerRows = database.prepare<{ scope: string; id: string; owner: string }, []>(
        "SELECT scope,id,owner FROM owners ORDER BY scope,id",
      )
      using observed = database.prepare("INSERT OR IGNORE INTO observed VALUES (?,?,?)")
      for (const row of ownerRows.iterate()) {
        const owner = SnapshotStore.Owner.parse(JSON.parse(row.owner))
        const proof = Authority.issue({
          scopeID: row.scope,
          sessionID: row.id,
          owner,
          layout: layout(database, row.scope, owner),
          namespace: namespaceProof,
          assertCurrent,
          roots: physicalRoots(database, row.scope, row.id, owner, exportSignal),
        })
        for await (const root of SnapshotStore.capturedRoots(proof, exportSignal)) observed.run(row.scope, row.id, root)
      }
      using missing = database.prepare(
        "SELECT p.root FROM parts p LEFT JOIN owners o ON o.scope=p.scope AND o.id=p.id LEFT JOIN observed r ON r.scope=p.scope AND r.id=p.id AND r.root=p.root WHERE o.id IS NULL OR (o.backend<>'deleted' AND r.root IS NULL) LIMIT 1",
      )
      if (missing.get()) fail("Captured Snapshot history has a missing or unowned root")
      assertCurrent()
      const archive = Object.freeze({
        directory: input.directory,
        namespace: namespaceProof,
      })
      archives.set(archive, database)
      return archive
    }
    const port: Capture = {
      exportArchive(input) {
        assertCurrent()
        const task = exported(input)
        pending.add(task)
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        )
        return task
      },
      owners(archive) {
        return read(async function* () {
          const database = archives.get(archive)
          if (!database) fail("Snapshot capture requires its own exported namespace archive")
          using statement = database.prepare<{ scope: string; id: string; owner: string }, []>(
            "SELECT scope,id,owner FROM owners ORDER BY scope,id",
          )
          for (const row of statement.iterate()) {
            assertCurrent()
            const owner = SnapshotStore.Owner.parse(JSON.parse(row.owner))
            yield Authority.issue({
              scopeID: row.scope,
              sessionID: row.id,
              owner,
              layout: layout(database, row.scope, owner),
              namespace: archive.namespace,
              assertCurrent,
              roots: async function* () {
                using roots = database.prepare<{ root: string }, [string, string]>(
                  "SELECT root FROM observed WHERE scope=? AND id=? ORDER BY root",
                )
                for (const value of roots.iterate(row.scope, row.id)) {
                  assertCurrent()
                  yield value.root
                  assertCurrent()
                }
              },
            })
            assertCurrent()
          }
        })
      },
      roots(owner) {
        return read(() => SnapshotStore.capturedRoots(owner, scopeSignal))
      },
      describe(owner) {
        assertCurrent()
        const binding = Authority.current(owner)
        return {
          scopeID: binding.scopeID,
          sessionID: binding.sessionID,
          owner: Object.freeze({ ...binding.owner }),
          layout: binding.layout,
          namespace: binding.namespace,
        }
      },
    }
    try {
      const result = await body(port)
      if (pending.size || readers.size) fail("Snapshot capture has unfinished operations")
      return result
    } finally {
      active = false
      controller.abort(new SnapshotStore.StorageError("Snapshot capture is closed"))
      await Promise.allSettled([...readers].map((reader) => reader.close?.()))
      await Promise.allSettled(pending)
      for (const { database, directory } of indexes) {
        database.close(true)
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  }
}
