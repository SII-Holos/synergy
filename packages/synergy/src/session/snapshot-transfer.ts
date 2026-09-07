import path from "node:path"
import fs from "node:fs/promises"
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
    private constructor(
      readonly target: string,
      readonly directory: string,
    ) {
      this.db = new Database(path.join(directory, "inventory.sqlite"))
      this.db.exec(
        "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; CREATE TABLE known (oid TEXT PRIMARY KEY); CREATE TABLE incoming (oid TEXT PRIMARY KEY, type TEXT NOT NULL); CREATE TABLE covered (oid TEXT PRIMARY KEY)",
      )
    }

    static async create(target: string, signal?: AbortSignal) {
      const root = path.join(Global.Path.cache, "snapshot-transfer")
      await fs.mkdir(root, { recursive: true })
      const catalog = new Catalog(target, await fs.mkdtemp(path.join(root, "inventory-")))
      try {
        const insert = catalog.db.prepare("INSERT OR IGNORE INTO known VALUES (?)")
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

    async import(source: string, options: { roots?: string[]; signal?: AbortSignal; keepToken?: string } = {}) {
      const format = await SnapshotGit.checked(source, ["rev-parse", "--show-object-format"], options)
      if (format !== "sha1") throw new SnapshotStore.StorageError("Unsupported legacy snapshot object format")
      this.db.exec("DELETE FROM incoming; DELETE FROM covered")
      const insert = this.db.prepare("INSERT OR IGNORE INTO incoming VALUES (?, ?)")
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

    trees() {
      return this.db
        .query<{ oid: string }, []>("SELECT oid FROM incoming WHERE type = 'tree'")
        .all()
        .map((row) => row.oid)
    }

    async protect(sessionID: string | undefined, roots: string[], signal?: AbortSignal) {
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
        if (sessionID) await SnapshotGit.checked(this.target, ["update-ref", "--stdin"], { signal, input: refsFile })
        const cover = this.db.prepare("INSERT OR IGNORE INTO covered VALUES (?)")
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
      if (count) await SnapshotGit.checked(this.target, ["update-ref", "--stdin"], { signal, input: refsFile })
      return count
    }

    async releaseKeep(hash?: string) {
      if (hash) await fs.rm(path.join(this.target, "objects", "pack", `pack-${hash}.keep`), { force: true })
    }

    async [Symbol.asyncDispose]() {
      this.db.close()
      await fs.rm(this.directory, { recursive: true, force: true })
    }
  }
}
