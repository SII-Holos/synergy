import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { PackedBackup } from "./packed-backup"
import { StorageIntegrityError } from "./errors"
import { legacyFiles, sourcePath } from "./legacy-source"
import { SnapshotProtection } from "../session/snapshot-protection"
import { UpgradeWork } from "./upgrade-work"

const Owner = z.object({ scopeID: z.string(), sessionID: z.string() }).strict()
const Manifest = z
  .object({
    version: z.union([z.literal(3), z.literal(4)]),
    backupID: z.string(),
    phase: z.enum(["freezing", "frozen"]),
    source: z.object({ dev: z.number(), ino: z.number() }).strict(),
    owners: z.array(Owner),
    originalRoot: z.string().optional(),
    snapshots: z.array(z.object({ relative: z.string(), dev: z.number(), ino: z.number() }).strict()).optional(),
  })
  .strict()

async function exists(filename: string) {
  return fs.lstat(filename).catch((error) => {
    if (error?.code !== "ENOENT") throw error
    return undefined
  })
}

async function sync(directory: string) {
  if (process.platform === "win32") return
  const file = await fs.open(directory, "r")
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

export class SegmentedBackup {
  private frozen?: z.infer<typeof Manifest>
  private owners = new Set<string>()
  readonly backupRoot: string
  readonly sourceRoot: string

  constructor(
    readonly dataRoot: string,
    readonly backupID: string,
    backupRoot?: string,
    private format: 3 | 4 = 3,
  ) {
    this.backupRoot = backupRoot ?? sourcePath(dataRoot, `storage/backups/${backupID}`)
    this.sourceRoot = sourcePath(dataRoot, `storage/legacy/${backupID}`)
  }

  static async open(directory: string) {
    const backupRoot = path.resolve(directory)
    const manifest = Manifest.parse(JSON.parse(await fs.readFile(path.join(backupRoot, "segmented.json"), "utf8")))
    const canonical =
      path.basename(backupRoot) === manifest.backupID &&
      path.basename(path.dirname(backupRoot)) === "backups" &&
      path.basename(path.dirname(path.dirname(backupRoot))) === "storage"
    return new SegmentedBackup(
      canonical ? path.resolve(backupRoot, "../../..") : backupRoot,
      manifest.backupID,
      backupRoot,
      manifest.version,
    )
  }

  async manifest() {
    if (this.frozen) return this.frozen
    const filename = path.join(this.backupRoot, "segmented.json")
    if (!(await exists(filename))) return undefined
    const manifest = Manifest.parse(JSON.parse(await fs.readFile(filename, "utf8")))
    this.format = manifest.version
    if (manifest.version === 4 && (!manifest.originalRoot || !manifest.snapshots))
      throw new StorageIntegrityError("Segmented snapshot inventory is missing")
    if (manifest.backupID !== this.backupID) throw new StorageIntegrityError("Segmented backup identity changed")
    const identities = new Set<string>()
    for (const owner of manifest.owners) {
      sourcePath(this.sourceRoot, `sessions/${owner.scopeID}/${owner.sessionID}`)
      if (identities.has(owner.sessionID)) throw new StorageIntegrityError("Duplicate Session in backup cohort")
      identities.add(owner.sessionID)
    }
    if (manifest.phase === "frozen") {
      this.frozen = manifest
      this.owners = new Set(manifest.owners.map((owner) => JSON.stringify([owner.scopeID, owner.sessionID])))
    }
    return manifest
  }

  async freeze() {
    let manifest = await this.manifest()
    if (!manifest) {
      await fs.mkdir(this.sourceRoot, { recursive: true, mode: 0o700 })
      await sync(path.dirname(this.sourceRoot))
      await sync(path.dirname(path.dirname(this.sourceRoot)))
      const stat = await fs.lstat(this.sourceRoot)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageIntegrityError("Invalid frozen source")
      const snapshots: Array<{ relative: string; dev: number; ino: number }> = []
      if (this.format === 4) {
        const snapshotRoot = path.join(this.dataRoot, "snapshot")
        const directory = await exists(snapshotRoot)
        if (directory) {
          if (!directory.isDirectory() || directory.isSymbolicLink())
            throw new StorageIntegrityError("Invalid legacy snapshot tree")
          for (const name of await fs.readdir(snapshotRoot)) {
            if (name === ".locks" || name.startsWith(".tmp-") || name.endsWith(".tmp")) continue
            const relative = `snapshot/${name}`
            const entry = await fs.lstat(sourcePath(this.dataRoot, relative))
            if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
              throw new StorageIntegrityError("Invalid snapshot segment")
            snapshots.push({ relative, dev: entry.dev, ino: entry.ino })
          }
        }
      }
      manifest = {
        version: this.format,
        ...(this.format === 4 ? { snapshots, originalRoot: path.resolve(this.dataRoot) } : {}),
        backupID: this.backupID,
        phase: "freezing",
        source: { dev: stat.dev, ino: stat.ino },
        owners: [],
      }
      await this.save(manifest)
    }
    await this.verifySource(manifest)
    if (manifest.version === 4) await SnapshotProtection.protect(this.dataRoot, this.backupID)
    if (manifest.phase === "frozen") return manifest
    const original = path.join(this.dataRoot, "sessions")
    const frozen = path.join(this.sourceRoot, "sessions")
    if (await exists(original)) {
      if (await exists(frozen)) throw new StorageIntegrityError("A legacy Session writer reappeared during freeze")
      const stat = await fs.lstat(original)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageIntegrityError("Invalid legacy Session tree")
      await fs.rename(original, frozen)
      await sync(this.sourceRoot)
      await sync(this.dataRoot)
    }
    const owners: z.infer<typeof Owner>[] = []
    if (await exists(frozen)) {
      for (const scope of await fs.readdir(frozen, { withFileTypes: true })) {
        if (scope.name === ".locks" || scope.name.startsWith(".tmp-")) continue
        if (!scope.isDirectory()) throw new StorageIntegrityError("Invalid legacy Scope directory")
        for (const session of await fs.readdir(path.join(frozen, scope.name), { withFileTypes: true })) {
          if (session.name === ".locks" || session.name.startsWith(".tmp-")) continue
          if (!session.isDirectory()) throw new StorageIntegrityError("Invalid legacy Session directory")
          owners.push({ scopeID: scope.name, sessionID: session.name })
        }
      }
    }
    manifest = { ...manifest, phase: "frozen", owners }
    await this.save(manifest)
    return (await this.manifest())!
  }

  private save(manifest: z.infer<typeof Manifest>) {
    return AtomicFile.writeJsonAtomic(path.join(this.backupRoot, "segmented.json"), JSON.stringify(manifest), {
      private: true,
      durable: true,
    })
  }

  private async verifySource(manifest: z.infer<typeof Manifest>) {
    const stat = await fs.lstat(this.sourceRoot)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== manifest.source.dev ||
      stat.ino !== manifest.source.ino
    )
      throw new StorageIntegrityError(
        "Frozen Session source was replaced; preserve the segmented backup and original source",
      )
  }

  global() {
    return new PackedBackup({
      dataRoot: this.dataRoot,
      backupRoot: path.join(this.backupRoot, "global"),
      ...(this.format === 4 ? { excludedRoots: ["snapshot"] } : {}),
    })
  }

  session(owner: z.infer<typeof Owner>) {
    return new PackedBackup({
      dataRoot: this.sourceRoot,
      backupRoot: sourcePath(this.backupRoot, `sessions/${owner.scopeID}/${owner.sessionID}`),
      selection: { scopeID: owner.scopeID, sessionID: owner.sessionID },
      capacity: async (bytes) => {
        const disk = await fs.statfs(this.dataRoot, { bigint: true })
        if (disk.bavail * disk.bsize < BigInt(Math.ceil(bytes + 64 * 1024 ** 2)))
          throw new StorageIntegrityError("Insufficient free space for Session backup and recovery reserve")
      },
    })
  }

  async sealSession(owner: z.infer<typeof Owner>) {
    const manifest = await this.manifest()
    if (!manifest || manifest.phase !== "frozen" || !this.owners.has(JSON.stringify([owner.scopeID, owner.sessionID])))
      throw new StorageIntegrityError("Session is absent from the frozen backup cohort")
    const backup = this.session(owner)
    if (!(await backup.manifest())) {
      await this.verifySource(manifest)
      await backup.create()
    }
    return backup
  }

  private snapshot(relative: string) {
    if (!relative.startsWith("snapshot/") || relative.split("/").length !== 2)
      throw new StorageIntegrityError("Invalid snapshot segment identity")
    return new PackedBackup({
      dataRoot: this.dataRoot,
      backupRoot: sourcePath(this.backupRoot, `snapshots/${relative.slice(9)}`),
      selection: { prefix: relative },
    })
  }

  private async verifyAlternates(relative: string) {
    const directory = sourcePath(this.dataRoot, relative)
    if (!(await fs.lstat(directory)).isDirectory()) return
    for await (const entry of legacyFiles(directory)) {
      if (entry.linkTarget !== undefined)
        throw new StorageIntegrityError("Snapshot backup cannot independently restore symbolic object dependencies")
    }
    for (const repository of await fs.readdir(directory, { withFileTypes: true })) {
      if (!repository.isDirectory()) continue
      const objects = path.join(directory, repository.name, "objects")
      const value = await fs
        .readFile(path.join(objects, "info", "alternates"), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
      for (const line of value?.split("\n").filter(Boolean) ?? []) {
        const input = line.startsWith('"') ? String(JSON.parse(line)) : line
        const target = await fs.realpath(path.resolve(objects, input))
        const local = path.relative(await fs.realpath(this.dataRoot), target)
        if (local === ".." || local.startsWith(".." + path.sep) || path.isAbsolute(local))
          throw new StorageIntegrityError("Snapshot backup has an external object dependency")
        if (!local.startsWith("snapshot" + path.sep) && !local.startsWith("snapshot-v2" + path.sep))
          throw new StorageIntegrityError("Snapshot object dependency is outside the backup snapshot roots")
      }
    }
  }

  async sealSnapshots(limit = Infinity) {
    const manifest = await this.manifest()
    let sealed = 0
    for (const segment of manifest?.snapshots ?? []) {
      const backup = this.snapshot(segment.relative)
      if (await backup.manifest()) continue
      await UpgradeWork.checkpoint()
      const stat = await fs.lstat(sourcePath(this.dataRoot, segment.relative))
      if (stat.isSymbolicLink() || stat.dev !== segment.dev || stat.ino !== segment.ino)
        throw new StorageIntegrityError("Protected snapshot segment was replaced")
      await this.verifyAlternates(segment.relative)
      await backup.create()
      if (++sealed >= limit) break
    }
    return sealed
  }

  async completeness() {
    const manifest = await this.manifest()
    if (!manifest) return { independent: false, sealed: 0, total: 0 }
    let sealed = (await this.global().manifest()) ? 1 : 0
    for (const owner of manifest.owners) if (await this.session(owner).manifest()) sealed++
    for (const segment of manifest.snapshots ?? []) if (await this.snapshot(segment.relative).manifest()) sealed++
    const total = 1 + manifest.owners.length + (manifest.snapshots?.length ?? 0)
    return { independent: sealed === total, sealed, total }
  }

  private async relocateAlternates(destination: string, originalRoot: string) {
    const root = path.join(destination, "snapshot")
    for (const scope of await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })) {
      if (!scope.isDirectory()) continue
      for (const repository of await fs.readdir(path.join(root, scope.name), { withFileTypes: true })) {
        if (!repository.isDirectory()) continue
        const repositoryRoot = path.join(root, scope.name, repository.name)
        if (await Bun.file(path.join(repositoryRoot, "HEAD")).exists()) {
          await fs.mkdir(path.join(repositoryRoot, "refs"), { recursive: true })
          await fs.mkdir(path.join(repositoryRoot, "objects", "pack"), { recursive: true })
        }
        const objects = path.join(repositoryRoot, "objects")
        const file = path.join(objects, "info", "alternates")
        const value = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (value === undefined) continue
        const lines = value
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const input = line.startsWith('"') ? (JSON.parse(line) as string) : line
            const relative = path.isAbsolute(input)
              ? path.relative(originalRoot, input)
              : path.relative(destination, path.resolve(objects, input))
            if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
              throw new StorageIntegrityError("Snapshot backup has an external object dependency")
            return path.relative(objects, path.join(destination, relative)).split(path.sep).join("/")
          })
        await AtomicFile.writeFileAtomic(file, lines.join("\n") + "\n", { private: true, durable: true })
      }
    }
  }

  async restore(destination: string) {
    return withFileLock({ directory: path.join(this.dataRoot, "storage", ".locks"), key: "artifact-packs" }, () =>
      this.restoreLocked(destination),
    )
  }

  private async restoreLocked(destination: string) {
    const manifest = await this.manifest()
    if (!manifest || manifest.phase !== "frozen")
      throw new StorageIntegrityError("Backup discovery is incomplete; resume the upgrade first")
    const global = this.global()
    const sealed = await global.manifest()
    if (!sealed) throw new StorageIntegrityError("Global backup is incomplete; resume the upgrade first")
    await global.restore(destination)
    let files = sealed.files,
      bytes = sealed.bytes
    for (const owner of manifest.owners) {
      const backup = await this.sealSession(owner)
      await backup.restore(destination)
      const part = (await backup.manifest())!
      files += part.files
      bytes += part.bytes
    }
    await this.sealSnapshots()
    for (const segment of manifest.snapshots ?? []) {
      const backup = this.snapshot(segment.relative)
      await backup.restore(destination)
      const part = (await backup.manifest())!
      files += part.files
      bytes += part.bytes
    }
    if (manifest.version === 4) await this.relocateAlternates(destination, manifest.originalRoot!)
    return { files, bytes }
  }
}
