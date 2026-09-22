import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import path from "node:path"

export interface SandboxHelperAsset {
  platform: "linux" | "win32"
  path: string
  sha256: string
}

const runtimeState = RuntimeContext.state(() => ({
  helpers: new Map<SandboxHelperAsset["platform"], Readonly<SandboxHelperAsset>>(),
}))

export function registerSandboxHelper(asset: SandboxHelperAsset) {
  const instanceState = runtimeState()

  if (!path.isAbsolute(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error("Sandbox helper registration requires an absolute path and SHA-256 digest")
  }
  const current = instanceState.helpers.get(asset.platform)
  if (current && (current.path !== asset.path || current.sha256 !== asset.sha256)) {
    throw new Error(`Sandbox helper already registered for ${asset.platform}`)
  }
  instanceState.helpers.set(asset.platform, Object.freeze({ ...asset }))
}

export function sandboxHelper(platform: SandboxHelperAsset["platform"]) {
  const instanceState = runtimeState()

  return instanceState.helpers.get(platform)
}
