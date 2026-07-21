import path from "path"

export const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
export const RELEASE_STATE_DIR = path.join(REPO_ROOT, ".release")
export const NPM_REGISTRY = "https://registry.npmjs.org"
export const RELEASE_TAG_PREFIX = "v"
export const VERSION_MANAGED_PACKAGE_PATHS = [
  path.join(REPO_ROOT, "packages/synergy/package.json"),
  path.join(REPO_ROOT, "packages/sdk/js/package.json"),
  path.join(REPO_ROOT, "packages/util/package.json"),
  path.join(REPO_ROOT, "packages/plugin/package.json"),
  path.join(REPO_ROOT, "packages/plugin-kit/package.json"),
  path.join(REPO_ROOT, "packages/synergy-link-protocol/package.json"),
  // synergy-link npm publish removed — package too large for npm registry
  // path.join(REPO_ROOT, "packages/synergy-link/package.json"),
  path.join(REPO_ROOT, "packages/app/package.json"),
  path.join(REPO_ROOT, "packages/desktop/package.json"),
] as const

export type RegistryPackageName =
  | "@ericsanchezok/synergy-sdk"
  | "@ericsanchezok/synergy-util"
  | "@ericsanchezok/synergy-link-protocol"
  | "@ericsanchezok/synergy-plugin"
  | "@ericsanchezok/synergy-plugin-kit"
  | "@ericsanchezok/synergy"
// synergy-link npm publish removed — package too large for npm registry
// | "@ericsanchezok/synergy-link"

export const FIXED_REGISTRY_PACKAGES = [
  "@ericsanchezok/synergy-sdk",
  "@ericsanchezok/synergy-util",
  "@ericsanchezok/synergy-link-protocol",
  "@ericsanchezok/synergy-plugin",
  "@ericsanchezok/synergy-plugin-kit",
  "@ericsanchezok/synergy",
  // synergy-link npm publish removed — package too large for npm registry
  // "@ericsanchezok/synergy-link",
] as const satisfies readonly RegistryPackageName[]

export const SDK_DIR = path.join(REPO_ROOT, "packages/sdk/js")
export const UTIL_DIR = path.join(REPO_ROOT, "packages/util")
export const SYNERGY_LINK_PROTOCOL_DIR = path.join(REPO_ROOT, "packages/synergy-link-protocol")
export const PLUGIN_DIR = path.join(REPO_ROOT, "packages/plugin")
export const PLUGIN_KIT_DIR = path.join(REPO_ROOT, "packages/plugin-kit")
export const SYNERGY_DIR = path.join(REPO_ROOT, "packages/synergy")
export const APP_DIR = path.join(REPO_ROOT, "packages/app")
export const DESKTOP_DIR = path.join(REPO_ROOT, "packages/desktop")

export const SYNERGY_LINK_DIR = path.join(REPO_ROOT, "packages/synergy-link")
export const SYNERGY_LINK_DIST_DIR = path.join(SYNERGY_LINK_DIR, "dist")

export const APP_DIST_DIR = path.join(APP_DIR, "dist")
export const SYNERGY_DIST_DIR = path.join(SYNERGY_DIR, "dist")
export const DESKTOP_RELEASE_DIR = path.join(DESKTOP_DIR, "release")

export type ReleaseKind = "dev" | "stable"

export type ReleaseState = {
  kind: ReleaseKind
  version: string
  channel: string
  promoteTag: string | null
  createdAt: string
  registryPackages: string[]
  binaryAssets: string[]
  desktopAssets: string[]
  desktopChecksums: string | null
  desktopUpdateMetadata: string[]
  releaseTag: string | null
  githubReleaseID: string | null
  githubReleaseTagName: string | null
}
