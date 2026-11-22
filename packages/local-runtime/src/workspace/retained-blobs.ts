import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"

export class RetainedWorkspaceBlobs {
  constructor(private readonly directory: string) {}

  private owner(raw: WorkspaceProtocol.BlobOwner) {
    const owner = WorkspaceProtocol.BlobOwner.parse(raw)
    return path.join(this.directory, "owners", `${owner.kind}-${createHash("sha256").update(owner.id).digest("hex")}`)
  }

  private object(hash: string) {
    return path.join(this.directory, "objects", WorkspaceTree.Hash.parse(hash))
  }

  async put(hash: string, bytes: Uint8Array, owner: WorkspaceProtocol.BlobOwner) {
    WorkspaceTree.verify(hash, bytes, WorkspaceTree.manifestBytes)
    const directory = this.owner(owner)
    const object = this.object(hash)
    await withFileLock({ directory: this.directory, key: "blobs" }, async () => {
      if (await Bun.file(path.join(directory, "released")).exists()) return
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.mkdir(path.dirname(object), { recursive: true, mode: 0o700 })
      await AtomicFile.syncDirectories(path.dirname(directory), this.directory)
      const retained = path.join(directory, hash)
      if (!(await Bun.file(retained).exists())) {
        if (await Bun.file(object).exists()) await fs.link(object, retained)
        else await AtomicFile.writeFileAtomic(retained, bytes, { private: true, durable: true })
        await AtomicFile.syncDirectories(directory)
      }
      if (!(await Bun.file(object).exists())) {
        await fs.link(retained, object)
        await AtomicFile.syncDirectories(path.dirname(object))
      }
    })
  }

  async get(hash: string, maximumBytes: number) {
    const file = Bun.file(this.object(hash))
    if (!(await file.exists())) return undefined
    if (file.size > maximumBytes) throw new Error("Workspace object exceeds its read limit")
    return WorkspaceTree.verify(hash, new Uint8Array(await file.arrayBuffer()), maximumBytes)
  }

  async release(owner: WorkspaceProtocol.BlobOwner) {
    const directory = this.owner(owner)
    await withFileLock({ directory: this.directory, key: "blobs" }, async () => {
      await AtomicFile.writeFileAtomic(path.join(directory, "released"), "", { private: true, durable: true })
      await AtomicFile.syncDirectories(path.dirname(directory), this.directory)
      for (const name of await fs.readdir(directory)) {
        if (!WorkspaceTree.Hash.safeParse(name).success) continue
        const object = this.object(name)
        const stat = await fs.stat(object).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        const retained = await fs.stat(path.join(directory, name))
        // Remove the shared name first so a failed unlink can be retried using the retained link.
        if (stat?.nlink === 2 && stat.dev === retained.dev && stat.ino === retained.ino) {
          await fs.unlink(object)
          await AtomicFile.syncDirectories(path.dirname(object))
        }
        await fs.unlink(path.join(directory, name))
      }
      await AtomicFile.syncDirectories(directory)
    })
  }
}
