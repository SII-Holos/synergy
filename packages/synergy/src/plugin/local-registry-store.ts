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
