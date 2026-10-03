import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
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
    const bytes = await fs.readFile(file)
    let json: unknown
    try {
      json = JSON.parse(bytes.toString())
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    const raw = z.record(z.string(), z.unknown()).safeParse(json)
    const receipt = MountReceipt.safeParse(json)
    if (!raw.success || !receipt.success) {
      await AtomicFile.writeJsonAtomic(
        path.join(path.dirname(file), "..", "identity-migration-issues", path.basename(file)),
        JSON.stringify({ reason: "invalid-receipt", sha256: createHash("sha256").update(bytes).digest("hex") }),
        { private: true, durable: true },
      )
      progress(index + 1, files.length)
      continue
    }
    const mount = receipt.data.mount
    if (mount && !receipt.data.detached && !mount.physicalID.startsWith("volume-v1:")) {
      const actual = await identifyFilesystemObject(mount.path).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return undefined
        throw error
      })
      if (actual?.directory && actual.legacyPhysicalID === mount.physicalID) {
        await AtomicFile.writeJsonAtomic(
          file,
          JSON.stringify({
            ...raw.data,
            mount: { ...z.record(z.string(), z.unknown()).parse(raw.data.mount), physicalID: actual.physicalID },
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
