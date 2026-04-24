import path from "path"

export const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
export const RELEASE_STATE_DIR = path.join(REPO_ROOT, ".release")
export const NPM_REGISTRY = "https://registry.npmjs.org"
export const RELEASE_TAG_PREFIX = "v"

export const VERSION_MANAGED_PACKAGE_PATHS = [
  path.join(REPO_ROOT, "packages/synergy/package.json"),
  path.join(REPO_ROOT, "packages/sdk/js/package.json"),
  path.join(REPO_ROOT, "packages/plugin/package.json"),
  path.join(REPO_ROOT, "packages/meta-protocol/package.json"),
  path.join(REPO_ROOT, "packages/meta-synergy/package.json"),
  path.join(REPO_ROOT, "packages/app/package.json"),
  path.join(REPO_ROOT, "packages/config-ui/package.json"),
] as const

export type RegistryPackageName =
  | "@ericsanchezok/synergy-sdk"
  | "@ericsanchezok/meta-protocol"
  | "@ericsanchezok/synergy-plugin"
  | "@ericsanchezok/synergy"
  | "@ericsanchezok/meta-synergy"

export const FIXED_REGISTRY_PACKAGES = [
  "@ericsanchezok/synergy-sdk",
  "@ericsanchezok/meta-protocol",
  "@ericsanchezok/synergy-plugin",
  "@ericsanchezok/synergy",
  "@ericsanchezok/meta-synergy",
] as const satisfies readonly RegistryPackageName[]

export const SDK_DIR = path.join(REPO_ROOT, "packages/sdk/js")
export const META_PROTOCOL_DIR = path.join(REPO_ROOT, "packages/meta-protocol")
export const PLUGIN_DIR = path.join(REPO_ROOT, "packages/plugin")
export const SYNERGY_DIR = path.join(REPO_ROOT, "packages/synergy")
export const APP_DIR = path.join(REPO_ROOT, "packages/app")
export const CONFIG_UI_DIR = path.join(REPO_ROOT, "packages/config-ui")

export const META_SYNERGY_DIR = path.join(REPO_ROOT, "packages/meta-synergy")
export const META_SYNERGY_DIST_DIR = path.join(META_SYNERGY_DIR, "dist")

export const APP_DIST_DIR = path.join(APP_DIR, "dist")
export const CONFIG_UI_DIST_DIR = path.join(CONFIG_UI_DIR, "dist")
export const SYNERGY_DIST_DIR = path.join(SYNERGY_DIR, "dist")

export type ReleaseKind = "dev" | "stable"

export type ReleaseState = {
  kind: ReleaseKind
  version: string
  channel: string
  promoteTag: string | null
  createdAt: string
  registryPackages: string[]
  binaryAssets: string[]
  releaseTag: string | null
  githubReleaseID: string | null
  githubReleaseTagName: string | null
}
