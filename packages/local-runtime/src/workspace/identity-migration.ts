import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { identifyFilesystemObject } from "./identity"
import { MountReceipt } from "./file-host"

export async function migrateNativeMountIdentities(root: string, progress: (current: number, total: number) => void) {
  if (process.platform !== "darwin") return
  const exists = await fs.stat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (!exists) return
  const files = await Array.fromAsync(new Bun.Glob("*/*/workspace/mounts/*").scan({ cwd: root, absolute: true }))
  for (const [index, file] of files.entries()) {
    const raw = z.record(z.string(), z.unknown()).parse(await Bun.file(file).json())
    const receipt = MountReceipt.parse(raw)
    const mount = receipt.mount
    if (mount && !receipt.detached && !mount.physicalID.startsWith("volume-v1:")) {
      const actual = await identifyFilesystemObject(mount.path).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return undefined
        throw error
      })
      if (actual?.directory && actual.legacyPhysicalID === mount.physicalID) {
        await AtomicFile.writeJsonAtomic(
          file,
          JSON.stringify({
            ...raw,
            mount: { ...z.record(z.string(), z.unknown()).parse(raw.mount), physicalID: actual.physicalID },
          }),
          { private: true, durable: true },
        )
      }
    }
    progress(index + 1, files.length)
  }
}

const migrations: Migration[] = [
  {
    id: "20261003-persistent-mount-identity",
    description: "Upgrade verified native mount receipts to persistent volume identities",
    scope: "global",
    execution: "startup",
    dependsOn: ["workspace/20261003-persistent-volume-identity"],
    up: (progress) =>
      migrateNativeMountIdentities(path.join(RuntimeContext.current().host.root, "state", "environments"), progress),
  },
]

export function registerWorkspaceIdentityMigrations() {
  MigrationRegistry.register("local-workspace", migrations)
}
