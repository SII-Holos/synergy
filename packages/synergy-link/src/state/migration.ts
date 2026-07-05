import os from "node:os"
import path from "node:path"
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { SynergyLinkStore, type SynergyLinkAuthState } from "./store"
import { SynergyLinkHolosAuth } from "../holos/auth"
import type { SynergyLinkMigration } from "../migration/types"

const CUTOVER_ID = "20260705-meta-synergy-to-synergy-link"

type MigrationManifest = {
  id: string
  sourceRoot?: string
  destinationRoot: string
  startedAt: string
  completedAt?: string
  files: string[]
  status: "running" | "completed"
}

export namespace SynergyLinkStateMigrations {
  export const migrations: SynergyLinkMigration[] = [
    {
      id: CUTOVER_ID,
      description: "Migrate MetaSynergy host state into Synergy Link state",
      async run() {
        await migrateLegacyRoot()
      },
    },
    {
      id: "20260408-normalize-state",
      description: "Normalize persisted Synergy Link state",
      async run() {
        const raw = await readFile(SynergyLinkStore.statePath(), "utf8").catch(() => undefined)
        if (!raw) return
        const parsed = JSON.parse(raw) as unknown
        const next = SynergyLinkStore.hydrateStateForMigration(parsed)
        await SynergyLinkStore.saveState(next)
      },
    },
  ]
}

async function migrateLegacyRoot() {
  const destinationRoot = SynergyLinkStore.root()
  const sourceRoot = await resolveLegacyRoot(destinationRoot)
  await mkdir(destinationRoot, { recursive: true })
  const manifestPath = path.join(destinationRoot, "migration-manifest.json")
  const lockPath = path.join(destinationRoot, ".migration.lock")

  if (!sourceRoot) return

  if (path.resolve(sourceRoot) === path.resolve(destinationRoot)) {
    throw new Error("Synergy Link migration source and destination resolve to the same path.")
  }

  const existingState = await exists(SynergyLinkStore.statePath())
  const existingManifest = await exists(manifestPath)
  if (existingState && !existingManifest) {
    throw new Error(
      `Synergy Link destination ${destinationRoot} already contains state; refusing to merge legacy data.`,
    )
  }

  await writeFile(lockPath, `${process.pid}\n`)
  const files: string[] = []
  const manifest: MigrationManifest = {
    id: CUTOVER_ID,
    sourceRoot,
    destinationRoot,
    startedAt: new Date().toISOString(),
    files,
    status: "running",
  }
  await writeManifest(manifestPath, manifest)

  try {
    const oldStatePath = path.join(sourceRoot, "state.json")
    const rawState = await readFile(oldStatePath, "utf8").catch(() => undefined)
    if (rawState) {
      const parsed = JSON.parse(rawState) as Record<string, unknown>
      const rewritten = SynergyLinkStore.hydrateStateForMigration(rewriteLegacyState(parsed, destinationRoot))
      await writeFile(SynergyLinkStore.statePath(), JSON.stringify(rewritten, null, 2) + "\n")
      files.push("state.json")
    }

    const oldMigrationLog = await readJsonRecord(path.join(sourceRoot, "migrations.json"))
    if (oldMigrationLog) {
      oldMigrationLog[CUTOVER_ID] = Date.now()
      await writeFile(SynergyLinkStore.migrationLogPath(), JSON.stringify(oldMigrationLog, null, 2) + "\n")
      files.push("migrations.json")
    }

    await copyIfExists(path.join(sourceRoot, "owner.json"), SynergyLinkStore.ownerRegistryPath(), files)
    await archiveLogs(sourceRoot, destinationRoot, files)
    await importLegacyAuthIfNeeded(path.join(sourceRoot, "auth.json"), files)

    await writeManifest(manifestPath, {
      ...manifest,
      files,
      completedAt: new Date().toISOString(),
      status: "completed",
    })
  } catch (error) {
    const quarantine = `${destinationRoot}.partial-${Date.now()}`
    await rename(destinationRoot, quarantine).catch(() => undefined)
    throw error
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function resolveLegacyRoot(destinationRoot: string) {
  const custom = process.env.META_SYNERGY_HOME
  if (custom && (await hasLegacyPayload(custom))) return custom

  const defaultDestination = path.join(os.homedir(), ".synergy-link")
  if (path.resolve(destinationRoot) !== path.resolve(defaultDestination)) return undefined

  const defaultRoot = path.join(os.homedir(), ".meta-synergy")
  if (await hasLegacyPayload(defaultRoot)) return defaultRoot
  return undefined
}

async function hasLegacyPayload(root: string) {
  return (
    (await exists(path.join(root, "state.json"))) ||
    (await exists(path.join(root, "auth.json"))) ||
    (await exists(path.join(root, "owner.json"))) ||
    (await exists(path.join(root, "migrations.json"))) ||
    (await exists(path.join(root, "logs", "runtime.log")))
  )
}

function rewriteLegacyState(input: Record<string, unknown>, destinationRoot: string) {
  const next: Record<string, unknown> = { ...input }
  const legacyID = typeof input.envID === "string" ? input.envID : undefined
  delete next.envID
  if (legacyID) {
    next.linkID = legacyID.startsWith("env_") ? `link_${legacyID.slice("env_".length)}` : legacyID
  }
  next.connectionStatus = "disconnected"
  const service =
    typeof next.service === "object" && next.service ? { ...(next.service as Record<string, unknown>) } : {}
  service.desiredState = "stopped"
  service.runtimeStatus = "stopped"
  delete service.pid
  next.service = service
  next.logs = { filePath: path.join(destinationRoot, "logs", "runtime.log") }
  return next
}

async function importLegacyAuthIfNeeded(oldAuthPath: string, files: string[]) {
  const current = await SynergyLinkHolosAuth.inspect()
  if (current.auth) return
  const raw = await readFile(oldAuthPath, "utf8").catch(() => undefined)
  if (!raw) return
  const parsed = JSON.parse(raw) as Partial<SynergyLinkAuthState>
  if (typeof parsed.agentID !== "string" || typeof parsed.agentSecret !== "string") return
  const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
  const oldShared = await readFile(sharedPath, "utf8").catch(() => undefined)
  if (oldShared !== undefined) {
    await writeFile(`${sharedPath}.bak-${Date.now()}`, oldShared)
  }
  await SynergyLinkHolosAuth.save({ agentID: parsed.agentID, agentSecret: parsed.agentSecret })
  files.push("shared-holos-auth")
}

async function archiveLogs(sourceRoot: string, destinationRoot: string, files: string[]) {
  const sourceLog = path.join(sourceRoot, "logs", "runtime.log")
  if (!(await exists(sourceLog))) return
  const archivePath = path.join(destinationRoot, "logs", "legacy-runtime.log")
  await mkdir(path.dirname(archivePath), { recursive: true })
  await copyFile(sourceLog, archivePath)
  files.push("logs/legacy-runtime.log")
}

async function copyIfExists(source: string, destination: string, files: string[]) {
  if (!(await exists(source))) return
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(source, destination)
  files.push(path.basename(destination))
}

async function readJsonRecord(filePath: string) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    )
  } catch {
    return undefined
  }
}

async function exists(filePath: string) {
  return await stat(filePath)
    .then(() => true)
    .catch(() => false)
}

async function writeManifest(filePath: string, manifest: MigrationManifest) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(manifest, null, 2) + "\n")
}
