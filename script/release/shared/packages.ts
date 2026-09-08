import path from "path"

export const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
export const RELEASE_STATE_DIR = path.join(REPO_ROOT, ".release")
export const NPM_REGISTRY = "https://registry.npmjs.org"
export const RELEASE_TAG_PREFIX = "v"

interface ReleasePackage {
  directory: string
  registry: string | null
  versioned: boolean
}

export const RELEASE_CATALOG = {
  sdk: { directory: "packages/sdk/js", registry: "@ericsanchezok/synergy-sdk", versioned: true },
  util: { directory: "packages/util", registry: "@ericsanchezok/synergy-util", versioned: true },
  linkProtocol: {
    directory: "packages/synergy-link-protocol",
    registry: "@ericsanchezok/synergy-link-protocol",
    versioned: true,
  },
  plugin: { directory: "packages/plugin", registry: "@ericsanchezok/synergy-plugin", versioned: true },
  pluginKit: { directory: "packages/plugin-kit", registry: "@ericsanchezok/synergy-plugin-kit", versioned: true },
  productRuntime: { directory: "packages/product-runtime", registry: "@ericsanchezok/synergy", versioned: true },
  cli: { directory: "packages/cli", registry: null, versioned: true },
  harness: { directory: "packages/harness", registry: null, versioned: true },
  runtimeLocal: { directory: "packages/runtime-local", registry: null, versioned: true },
  browser: { directory: "packages/browser", registry: null, versioned: true },
  computer: { directory: "packages/computer", registry: null, versioned: true },
  browserRuntime: { directory: "packages/browser-runtime", registry: null, versioned: true },
  computerRuntime: { directory: "packages/computer-runtime", registry: null, versioned: true },
  library: { directory: "packages/library", registry: null, versioned: true },
  note: { directory: "packages/note", registry: null, versioned: true },
  connections: { directory: "packages/connections", registry: null, versioned: true },
  pluginHost: { directory: "packages/plugin-host", registry: null, versioned: true },
  agentIntegrations: { directory: "packages/agent-integrations", registry: null, versioned: true },
  server: { directory: "packages/server", registry: null, versioned: true },
  workbench: { directory: "packages/workbench", registry: null, versioned: true },
  workflows: { directory: "packages/workflows", registry: null, versioned: true },
  media: { directory: "packages/media", registry: null, versioned: true },
  testing: { directory: "packages/testing", registry: null, versioned: true },
  web: { directory: "apps/web", registry: null, versioned: true },
  desktop: { directory: "apps/desktop", registry: null, versioned: true },
  ui: { directory: "packages/ui", registry: null, versioned: false },
  link: { directory: "packages/synergy-link", registry: null, versioned: false },
} as const satisfies Record<string, ReleasePackage>

export type ReleasePackageID = keyof typeof RELEASE_CATALOG
export type RegistryPackageName = Exclude<(typeof RELEASE_CATALOG)[ReleasePackageID]["registry"], null>

export const RUNTIME_RELEASE_TARGETS = {
  core: { package: "cli", entrypoint: "src/index.ts", executable: "synergy", registry: null },
  full: {
    package: "productRuntime",
    entrypoint: "src/index.ts",
    executable: "synergy",
    registry: RELEASE_CATALOG.productRuntime.registry,
  },
} as const satisfies Record<
  string,
  { package: ReleasePackageID; entrypoint: string; executable: string; registry: RegistryPackageName | null }
>

export type RuntimeArtifactProfile = keyof typeof RUNTIME_RELEASE_TARGETS

export function releasePackageDirectory(id: ReleasePackageID): string {
  return path.join(REPO_ROOT, RELEASE_CATALOG[id].directory)
}

export const VERSION_MANAGED_PACKAGE_PATHS = Object.values(RELEASE_CATALOG)
  .filter((entry) => entry.versioned)
  .map((entry) => path.join(REPO_ROOT, entry.directory, "package.json"))

export const FIXED_REGISTRY_PACKAGES = Object.values(RELEASE_CATALOG)
  .map((entry) => entry.registry)
  .filter((name): name is RegistryPackageName => name !== null)

export const SDK_DIR = releasePackageDirectory("sdk")
export const UTIL_DIR = releasePackageDirectory("util")
export const SYNERGY_LINK_PROTOCOL_DIR = releasePackageDirectory("linkProtocol")
export const PLUGIN_DIR = releasePackageDirectory("plugin")
export const PLUGIN_KIT_DIR = releasePackageDirectory("pluginKit")
export const PRODUCT_RUNTIME_DIR = releasePackageDirectory("productRuntime")
export const CLI_DIR = releasePackageDirectory("cli")
export const HARNESS_DIR = releasePackageDirectory("harness")
export const RUNTIME_LOCAL_DIR = releasePackageDirectory("runtimeLocal")
export const WEB_DIR = releasePackageDirectory("web")
export const DESKTOP_DIR = releasePackageDirectory("desktop")
export const SYNERGY_LINK_DIR = releasePackageDirectory("link")
export const SYNERGY_LINK_DIST_DIR = path.join(SYNERGY_LINK_DIR, "dist")
export const WEB_DIST_DIR = path.join(WEB_DIR, "dist")
export const PRODUCT_RUNTIME_DIST_DIR = path.join(PRODUCT_RUNTIME_DIR, "dist")
export const CORE_RUNTIME_DIST_DIR = path.join(CLI_DIR, "dist")
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
  binaryChecksums: string | null
  desktopAssets: string[]
  desktopChecksums: string | null
  desktopUpdateMetadata: string[]
  releaseTag: string | null
  githubReleaseID: string | null
  githubReleaseTagName: string | null
}
