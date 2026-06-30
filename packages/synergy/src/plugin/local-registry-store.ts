import path from "path"
import { Global } from "../global"

export function localRegistryPath(): string {
  return path.join(Global.Path.data, "registry", "plugins.json")
}

export function localRegistryStoreDir(): string {
  return path.dirname(localRegistryPath())
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
