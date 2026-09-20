import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { AtomicFile } from "./atomic-file"
import { PackedBackup } from "./packed-backup"
import { StorageIntegrityError } from "./errors"
import { sourcePath } from "./legacy-source"

const Owner = z.object({ scopeID: z.string(), sessionID: z.string() }).strict()
const Manifest = z
  .object({
    version: z.literal(3),
    backupID: z.string(),
    phase: z.enum(["freezing", "frozen"]),
    source: z.object({ dev: z.number(), ino: z.number() }).strict(),
    owners: z.array(Owner),
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
    )
  }

  async manifest() {
    if (this.frozen) return this.frozen
    const filename = path.join(this.backupRoot, "segmented.json")
    if (!(await exists(filename))) return undefined
    const manifest = Manifest.parse(JSON.parse(await fs.readFile(filename, "utf8")))
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
      manifest = {
        version: 3,
        backupID: this.backupID,
        phase: "freezing",
        source: { dev: stat.dev, ino: stat.ino },
        owners: [],
      }
      await this.save(manifest)
    }
    await this.verifySource(manifest)
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
    return new PackedBackup({ dataRoot: this.dataRoot, backupRoot: path.join(this.backupRoot, "global") })
  }

  session(owner: z.infer<typeof Owner>) {
    return new PackedBackup({
      dataRoot: this.sourceRoot,
      backupRoot: sourcePath(this.backupRoot, `sessions/${owner.scopeID}/${owner.sessionID}`),
      selection: owner,
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
    return { files, bytes }
  }
}
