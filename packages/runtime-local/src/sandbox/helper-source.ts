import path from "node:path"

export interface SandboxHelperAsset {
  platform: "linux" | "win32"
  path: string
  sha256: string
}

const helpers = new Map<SandboxHelperAsset["platform"], Readonly<SandboxHelperAsset>>()

export function registerSandboxHelper(asset: SandboxHelperAsset) {
  if (!path.isAbsolute(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error("Sandbox helper registration requires an absolute path and SHA-256 digest")
  }
  const current = helpers.get(asset.platform)
  if (current && (current.path !== asset.path || current.sha256 !== asset.sha256)) {
    throw new Error(`Sandbox helper already registered for ${asset.platform}`)
  }
  helpers.set(asset.platform, Object.freeze({ ...asset }))
}

export function sandboxHelper(platform: SandboxHelperAsset["platform"]) {
  return helpers.get(platform)
}
