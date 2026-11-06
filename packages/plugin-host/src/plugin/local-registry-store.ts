import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import path from "path"
import { Global } from "@ericsanchezok/synergy-harness/global"

export function localRegistryStoreDir(): string {
  return path.join(Global.Path.data, "registry")
}

export async function readLocalRegistry(): Promise<Record<string, unknown>[]> {
  const keys = await Storage.list(["registry", "entries"])
  return (await Storage.readMany<Record<string, unknown>>(keys)).filter(
    (entry): entry is Record<string, unknown> => entry !== undefined,
  )
}

export async function writeLocalRegistry(entries: Array<{ id: string }>): Promise<void> {
  await Storage.transaction(async (tx) => {
    const existing = await tx.scan(["registry", "entries"])
    const ids = new Set(entries.map((entry) => entry.id))
    for (const id of existing) if (!ids.has(id)) await tx.remove(["registry", "entries", id])
    for (const entry of entries) await tx.write(["registry", "entries", entry.id], entry)
  })
}

export function localRegistryArtifactDir(pluginId: string, version: string): string {
  return path.join(localRegistryStoreDir(), "artifacts", pluginId, version)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function resolveLocalRegistryInstallSpec(entry: unknown, version: unknown): string {
  const entryRecord = asRecord(entry)
  const versionRecord = asRecord(version)
  const pluginId = typeof entryRecord.id === "string" ? entryRecord.id : "unknown"
  const versionId = typeof versionRecord.version === "string" ? versionRecord.version : "unknown"
  const explicit = versionRecord.downloadUrl ?? versionRecord.installSpec
  if (typeof explicit === "string" && explicit.trim()) return explicit
  throw new Error(
    `Local registry version ${pluginId}@${versionId} has no installable artifact. Expected versions[].downloadUrl or versions[].installSpec.`,
  )
}
