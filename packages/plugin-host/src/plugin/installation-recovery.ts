import { isDeepStrictEqual } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import * as Lockfile from "./lockfile"
import { readApprovals, removeApproval, saveApproval } from "./consent/approval-store"
import { IncompatiblePluginStore } from "./incompatible-store"
import type { ResolvedPluginSpec } from "./spec-resolver"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { withInstallationLock } from "../installation/lock"
import { InstallationGenerations } from "../installation/generations"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

const Intent = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    status: z.enum(["pending", "complete"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
type Snapshot = Awaited<ReturnType<typeof capture>>
const root = () => path.join(Storage.current().artifactDirectory, "plugin-install-artifacts")
const snapshotPath = (id: string) => path.join(root(), `${z.uuid().parse(id)}.json`)

async function capture(pluginId: string, nextDomain: Config.Info | undefined, resolved?: ResolvedPluginSpec) {
  const id = randomUUID()
  const finalDir = resolved?.stagingDir ? resolved.finalPluginDir : undefined
  const promotion =
    finalDir && resolved?.stagingDir
      ? {
          finalDir,
          stagingDir: resolved.stagingDir,
          backupDir: path.join(root(), "rollback", id),
          hadOriginal: await exists(finalDir),
        }
      : undefined
  return {
    id,
    pluginId,
    previousDomain: await Config.domainGet("plugins"),
    nextDomain,
    lockfile: await Lockfile.read(),
    approvals: await readApprovals(),
    incompatible: await IncompatiblePluginStore.read(),
    promotion,
  }
}

async function exists(filename: string) {
  try {
    await fs.lstat(filename)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function promote(snapshot: Snapshot) {
  const p = snapshot.promotion
  if (!p) return
  await fs.mkdir(path.dirname(p.backupDir), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.dirname(p.finalDir), { recursive: true, mode: 0o700 })
  if (p.hadOriginal) await fs.rename(p.finalDir, p.backupDir)
  await fs.rename(p.stagingDir, p.finalDir)
  await AtomicFile.syncDirectories(path.dirname(p.finalDir), path.dirname(p.stagingDir), path.dirname(p.backupDir))
}

async function finish(snapshot: Snapshot, sha256: string) {
  await Storage.write(["plugin-install-intents", snapshot.id], {
    version: 1,
    id: snapshot.id,
    status: "complete",
    sha256,
  })
  await cleanup(snapshot)
}

async function cleanup(snapshot: Snapshot) {
  if (snapshot.promotion) await fs.rm(snapshot.promotion.backupDir, { recursive: true, force: true })
  await Storage.remove(["plugin-install-intents", snapshot.id])
  await fs.rm(snapshotPath(snapshot.id), { force: true })
}

async function rollback(snapshot: Snapshot, sha256: string) {
  const [state] = await Storage.readMany([["plugin-install-intents", snapshot.id]])
  if (!state) return
  if (Intent.parse(state).status === "complete") {
    await cleanup(snapshot)
    return
  }
  const current = await Config.domainGet("plugins")
  if (
    snapshot.nextDomain &&
    !isDeepStrictEqual(current, snapshot.previousDomain) &&
    !isDeepStrictEqual(current, snapshot.nextDomain)
  )
    throw new Error(
      "Plugin configuration changed during installation; the recovery snapshot is retained for reconciliation",
    )
  const promotion = snapshot.promotion
  if (promotion) {
    if (await exists(promotion.backupDir)) {
      await fs.rm(promotion.finalDir, { recursive: true, force: true })
      await fs.rename(promotion.backupDir, promotion.finalDir)
      await AtomicFile.syncDirectories(path.dirname(promotion.backupDir), path.dirname(promotion.finalDir))
    } else if (!promotion.hadOriginal && !(await exists(promotion.stagingDir)))
      await fs.rm(promotion.finalDir, { recursive: true, force: true })
  }
  if (snapshot.nextDomain) await Config.domainUpdate("plugins", snapshot.previousDomain, { mode: "replace-domain" })
  await Storage.transaction(async () => {
    const currentLock = await Lockfile.read()
    for (const [id, entry] of Object.entries(currentLock.plugins))
      if (id === snapshot.pluginId || entry.approvalId === snapshot.pluginId) delete currentLock.plugins[id]
    for (const [id, entry] of Object.entries(snapshot.lockfile.plugins))
      if (id === snapshot.pluginId || entry.approvalId === snapshot.pluginId) currentLock.plugins[id] = entry
    await Lockfile.write(currentLock)
    const approval = snapshot.approvals.find((entry) => entry.pluginId === snapshot.pluginId)
    if (approval) await saveApproval(approval)
    else await removeApproval(snapshot.pluginId)
    await IncompatiblePluginStore.write([
      ...(await IncompatiblePluginStore.read()).filter((entry) => entry.pluginId !== snapshot.pluginId),
      ...snapshot.incompatible.filter((entry) => entry.pluginId === snapshot.pluginId),
    ])
    await Storage.write(["plugin-install-intents", snapshot.id], {
      version: 1,
      id: snapshot.id,
      status: "complete",
      sha256,
    })
  })
  await cleanup(snapshot)
}

export namespace PluginInstallationRecovery {
  export async function begin(pluginId: string, nextDomain?: Config.Info, resolved?: ResolvedPluginSpec) {
    const snapshot = await capture(pluginId, nextDomain, resolved)
    const text = JSON.stringify(snapshot)
    const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    await Storage.writeJsonAtomic(snapshotPath(snapshot.id), text, { private: true, durable: true })
    await Storage.write(["plugin-install-intents", snapshot.id], {
      version: 1,
      id: snapshot.id,
      status: "pending",
      sha256,
    })
    return {
      promote: () => promote(snapshot),
      finish: () => finish(snapshot, sha256),
      rollback: () => rollback(snapshot, sha256),
    }
  }

  export async function recoverUnlocked() {
    for (const key of await Storage.list(["plugin-install-intents"])) {
      const intent = Intent.parse(await Storage.read(key))
      const text = await Bun.file(snapshotPath(intent.id)).text()
      if (new Bun.CryptoHasher("sha256").update(text).digest("hex") !== intent.sha256)
        throw new Error("Plugin recovery snapshot checksum mismatch")
      const snapshot = JSON.parse(text) as Snapshot
      if (snapshot.id !== intent.id || typeof snapshot.pluginId !== "string" || !snapshot.pluginId)
        throw new Error("Plugin recovery identity mismatch")
      if (snapshot.promotion) {
        const p = snapshot.promotion
        if (
          p.backupDir !== path.join(root(), "rollback", intent.id) ||
          !path.isAbsolute(p.finalDir) ||
          !path.isAbsolute(p.stagingDir) ||
          p.finalDir === p.stagingDir ||
          path.dirname(p.finalDir) === p.finalDir
        )
          throw new Error("Invalid plugin recovery directory ownership")
      }
      if (intent.status === "complete") await cleanup(snapshot)
      else await rollback(snapshot, intent.sha256)
    }
  }

  export async function recover() {
    using lock = await Lock.write("plugin-installation")
    const root = RuntimeContext.current().host.root
    await withInstallationLock(root, async () => {
      await InstallationGenerations.recoverUnlocked(root)
      await recoverUnlocked()
    })
  }
}
