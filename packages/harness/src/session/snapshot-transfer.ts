import { initializeSqliteEngine } from "../storage/sqlite-engine"
import path from "node:path"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { Database } from "bun:sqlite"
import { Global } from "../global"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotStore } from "./snapshot-store"

export namespace SnapshotTransfer {
  export async function recoverImports(target: string, signal?: AbortSignal) {
    const packs = path.join(target, "objects", "pack")
    let protectedObjects = 0
    for (const entry of await fs.readdir(packs)) {
      if (!/^pack-[0-9a-f]{40}\.keep$/.test(entry)) continue
      const keep = path.join(packs, entry)
      const token = (await Bun.file(keep).text()).trim()
      if (!["synergy-snapshot-transfer", "synergy-snapshot-archive"].includes(token)) continue
      const cache = path.join(Global.Path.cache, "snapshot-transfer")
      await fs.mkdir(cache, { recursive: true })
      const directory = await fs.mkdtemp(path.join(cache, "recover-"))
      try {
        const file = path.join(directory, "refs")
        const writer = Bun.file(file).writer()
        try {
          const index = path.join(packs, entry.replace(/\.keep$/, ".idx"))
          for await (const line of SnapshotGit.lines(target, ["verify-pack", "-v", index], { signal })) {
            const oid = line.split(" ")[0]
            if (!SnapshotStore.OID.test(oid)) continue
            writer.write(`update refs/synergy/preserved/${oid} ${oid}\n`)
            if (++protectedObjects % 1024 === 0) await writer.flush()
          }
        } finally {
          await writer.end()
        }
        await SnapshotGit.checked(target, ["update-ref", "--stdin"], { signal, input: file })
        await fs.rm(keep)
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
    return protectedObjects
  }
  export async function releaseKeeps(target: string, token: string) {
    const directory = path.join(target, "objects", "pack")
    for (const entry of await fs.readdir(directory)) {
      if (!/^pack-[0-9a-f]{40}\.keep$/.test(entry)) continue
      const file = path.join(directory, entry)
      if ((await Bun.file(file).text()).trim() === token) await fs.rm(file)
    }
  }

  export class Catalog implements AsyncDisposable {
    private readonly db: Database
    private readonly pendingReferences: string[] = []
    private constructor(
      readonly target: string,
      readonly directory: string,
      private readonly selective = false,
    ) {
      initializeSqliteEngine()
      this.db = new Database(path.join(directory, "inventory.sqlite"))
      this.db.exec(
        "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; CREATE TABLE known (oid TEXT PRIMARY KEY); CREATE TABLE incoming (oid TEXT PRIMARY KEY, type TEXT NOT NULL); CREATE TABLE covered (oid TEXT PRIMARY KEY)",
      )
    }

    static async create(target: string, signal?: AbortSignal, options: { selective?: boolean } = {}) {
      const root = path.join(Global.Path.cache, "snapshot-transfer")
      await fs.mkdir(root, { recursive: true })
      const catalog = new Catalog(target, await fs.mkdtemp(path.join(root, "inventory-")), options.selective)
      try {
        if (options.selective) return catalog
        using insert = catalog.db.prepare("INSERT OR IGNORE INTO known VALUES (?)")
        for await (const oid of SnapshotGit.lines(
          target,
          ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
          { signal },
        )) {
          insert.run(oid)
        }
        return catalog
      } catch (error) {
        await catalog[Symbol.asyncDispose]()
        throw error
      }
    }

    async import(
      source: string,
      options: { roots?: string[]; requiredTrees?: string[]; signal?: AbortSignal; keepToken?: string } = {},
    ) {
      const format = await SnapshotGit.checked(source, ["rev-parse", "--show-object-format"], options)
      if (format !== "sha1") throw new SnapshotStore.StorageError("Unsupported legacy snapshot object format")
      this.db.exec("DELETE FROM incoming; DELETE FROM covered")
      using insert = this.db.prepare("INSERT OR IGNORE INTO incoming VALUES (?, ?)")
      if (options.roots) {
        const roots = new Set(options.roots)
        const rootFile = path.join(this.directory, "roots")
        await Bun.write(rootFile, options.roots.join("\n") + "\n")
        for await (const oid of SnapshotGit.lines(source, ["rev-list", "--objects", "--no-object-names", "--stdin"], {
          ...options,
          input: rootFile,
        })) {
          insert.run(oid, roots.has(oid) ? "tree" : "object")
        }
      } else {
        for await (const line of SnapshotGit.lines(
          source,
          ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
          options,
        )) {
          const [oid, type] = line.split(" ")
          if (!SnapshotStore.OID.test(oid) || !type)
            throw new SnapshotStore.StorageError("Invalid snapshot object inventory")
          insert.run(oid, type)
        }
      }
      // Git synthesizes its empty tree for reads, so a historical root may be absent from --batch-all-objects.
      // Provenance: https://github.com/git/git/blob/v2.25.1/sha1-file.c (find_cached_object).
      for (const oid of options.requiredTrees ?? []) {
        if (!SnapshotStore.OID.test(oid)) throw new SnapshotStore.StorageError("Invalid required snapshot tree")
        insert.run(oid, "tree")
      }
      // Probe only this owner's closure; --batch-check reports missing objects without scanning the shared pool.
      // Provenance: https://git-scm.com/docs/git-cat-file (batch output).
      if (this.selective) {
        const candidates = path.join(this.directory, "candidates")
        const writer = Bun.file(candidates).writer()
        try {
          let count = 0
          for (const row of this.db.query<{ oid: string }, []>("SELECT oid FROM incoming").iterate()) {
            writer.write(row.oid + "\n")
            if (++count % 1024 === 0) await writer.flush()
          }
        } finally {
          await writer.end()
        }
        using known = this.db.prepare("INSERT OR IGNORE INTO known VALUES (?)")
        for await (const line of SnapshotGit.lines(
          this.target,
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          { signal: options.signal, input: candidates },
        )) {
          const [oid, type] = line.split(" ")
          if (["tree", "blob", "commit", "tag"].includes(type)) known.run(oid)
        }
      }
      const inventory = path.join(this.directory, "missing")
      await Bun.write(inventory, "")
      const sink = Bun.file(inventory).writer()
      let added = 0
      try {
        for (const row of this.db
          .query<{ oid: string }, []>("SELECT oid FROM incoming WHERE oid NOT IN (SELECT oid FROM known)")
          .iterate()) {
          sink.write(row.oid + "\n")
          added++
          if (added % 1024 === 0) await sink.flush()
        }
      } finally {
        await sink.end()
      }
      const keep = added
        ? await SnapshotGit.importObjects(source, this.target, inventory, options.signal, options.keepToken)
        : undefined
      this.db.exec("INSERT OR IGNORE INTO known SELECT oid FROM incoming")
      return { added, keep }
    }

    async verifyTrees(repository: string, trees: string[], signal?: AbortSignal) {
      if (!trees.length) return
      const expected = new Set(trees)
      const input = path.join(this.directory, "verify-trees")
      await Bun.write(input, [...expected].join("\n") + "\n")
      for await (const line of SnapshotGit.lines(
        repository,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        { signal, input },
      )) {
        const [oid, type] = line.split(" ")
        if (type !== "tree" || !expected.delete(oid))
          throw new SnapshotStore.StorageError("Historical snapshot tree is missing or invalid")
      }
      if (expected.size) throw new SnapshotStore.StorageError("Historical snapshot tree verification was incomplete")
    }

    trees() {
      return this.db
        .query<{ oid: string }, []>("SELECT oid FROM incoming WHERE type = 'tree'")
        .all()
        .map((row) => row.oid)
    }

    async verifyRetention(sessionID: string, roots: string[], signal?: AbortSignal) {
      const expected = new Map(roots.map((oid) => [SnapshotStore.reference(sessionID, oid), oid]))
      if (!expected.size) return
      for await (const line of SnapshotGit.lines(
        this.target,
        [
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          `refs/synergy/snapshots/${SnapshotStore.component(sessionID)}/`,
        ],
        { signal },
      )) {
        const [oid, reference] = line.split(" ")
        if (expected.get(reference) === oid) expected.delete(reference)
      }
      if (expected.size)
        throw new SnapshotStore.StorageError("Cannot clean legacy snapshot with an unprotected history root")
    }

    async protect(
      sessionID: string | undefined,
      roots: string[],
      signal?: AbortSignal,
      options: { packReferences?: boolean; deferPublication?: boolean } = {},
    ) {
      if (options.deferPublication && !options.packReferences)
        throw new SnapshotStore.StorageError("Deferred retention requires packed reference publication")
      const update = options.packReferences
        ? ["-c", "core.fsync=-reference", "update-ref", "--stdin"]
        : ["update-ref", "--stdin"]
      const refsFile = path.join(this.directory, "references")
      await Bun.write(refsFile, "")
      const refs = Bun.file(refsFile).writer()
      const rootsFile = path.join(this.directory, "retained-roots")
      await Bun.write(rootsFile, "")
      const rootWriter = Bun.file(rootsFile).writer()
      try {
        for (const oid of new Set(roots)) {
          if (sessionID) refs.write(`update ${SnapshotStore.reference(sessionID, oid)} ${oid}\n`)
          rootWriter.write(oid + "\n")
        }
      } finally {
        await Promise.all([refs.end(), rootWriter.end()])
      }
      if (roots.length) {
        if (sessionID) {
          await SnapshotGit.checked(this.target, update, { signal, input: refsFile })
          if (options.packReferences) await this.queueReferences(refsFile)
        }
        using cover = this.db.prepare("INSERT OR IGNORE INTO covered VALUES (?)")
        for await (const oid of SnapshotGit.lines(
          this.target,
          ["rev-list", "--objects", "--no-object-names", "--stdin"],
          { signal, input: rootsFile },
        ))
          cover.run(oid)
      }
      await Bun.write(refsFile, "")
      const preserved = Bun.file(refsFile).writer()
      let count = 0
      try {
        for (const row of this.db
          .query<{ oid: string }, []>("SELECT oid FROM incoming WHERE oid NOT IN (SELECT oid FROM covered)")
          .iterate()) {
          preserved.write(`update refs/synergy/preserved/${row.oid} ${row.oid}\n`)
          count++
          if (count % 1024 === 0) await preserved.flush()
        }
      } finally {
        await preserved.end()
      }
      if (count) {
        await SnapshotGit.checked(this.target, update, { signal, input: refsFile })
        if (options.packReferences) await this.queueReferences(refsFile)
      }
      if (options.packReferences && !options.deferPublication) await this.publishReferences(signal)
      return count
    }

    private async queueReferences(source: string) {
      const file = path.join(this.directory, `pending-refs-${this.pendingReferences.length}`)
      await fs.copyFile(source, file)
      this.pendingReferences.push(file)
    }

    async publishReferences(signal?: AbortSignal) {
      if (this.pendingReferences.length) {
        const version = /^git version (\d+)\.(\d+)/.exec(
          await SnapshotGit.checked(this.target, ["version"], { signal }),
        )
        if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 36)) {
          await this.syncLooseReferences(signal)
        } else {
          // Provenance: https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsync
          // and https://github.com/git/git/blob/v2.50.1/refs/packed-backend.c (write_with_updates).
          // Migration retains its source and import keep until the packed reference file and its rename are durable.
          const pack = ["-c", "core.fsync=reference", "-c", "core.fsyncMethod=fsync", "pack-refs", "--all"]
          await SnapshotGit.checked(this.target, [...pack, "--no-prune"], { signal })
          const packed = await fs.open(path.join(this.target, "packed-refs"), "r+")
          try {
            await packed.sync()
          } finally {
            await packed.close()
          }
          if (process.platform !== "win32") {
            const directory = await fs.open(this.target, "r")
            try {
              await directory.sync()
            } finally {
              await directory.close()
            }
          }
          await SnapshotGit.checked(this.target, pack, { signal })
        }
        for (const file of this.pendingReferences) await fs.rm(file)
        this.pendingReferences.length = 0
      }
    }

    private async syncLooseReferences(signal?: AbortSignal) {
      // Provenance: https://git-scm.com/docs/git-config/2.36.0#Documentation/git-config.txt-corefsync
      // Older Git cannot flush packed refs before rename; retain explicitly flushed loose refs instead.
      const directories = new Set<string>()
      const sync = async (reference: string) => {
        signal?.throwIfAborted()
        const filename = path.join(this.target, reference)
        const file = await fs.open(filename, "r+").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return fs.open(path.join(this.target, "packed-refs"), "r+")
        })
        try {
          await file.sync()
        } finally {
          await file.close()
        }
        let directory = path.dirname(filename)
        while (directory.startsWith(this.target + path.sep)) {
          directories.add(directory)
          directory = path.dirname(directory)
        }
        directories.add(this.target)
      }
      for (const file of this.pendingReferences) {
        for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity }))
          await sync(line.split(" ")[1])
      }
      if (process.platform === "win32") return
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        const file = await fs.open(directory, "r").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return undefined
        })
        try {
          await file?.sync()
        } finally {
          await file?.close()
        }
      }
    }

    async releaseKeep(hash?: string) {
      if (hash) await fs.rm(path.join(this.target, "objects", "pack", `pack-${hash}.keep`), { force: true })
    }

    async [Symbol.asyncDispose]() {
      // Unfinalized statements defer native closure and prevent Windows from deleting the inventory.
      // Provenance: https://bun.com/reference/bun/sqlite/Database/close
      this.db.close(true)
      await fs.rm(this.directory, { recursive: true, force: true })
    }
  }
}
